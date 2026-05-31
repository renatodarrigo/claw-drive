import { isValidSessionId } from "../../lib/paths.js";
import { type Event } from "../../lib/events.js";
import {
  extractTrailingToken,
  resolveSurfaceMode,
  DEFAULT_IDLE_AFTER_SECONDS,
} from "../../lib/tokens.js";
import { startSessionTailer } from "../../lib/session-tailer.js";

/**
 * Filter predicate: true = emit (human/A needs to see this), false = drop.
 * Exported so tests can exercise it without spawning a subprocess.
 */
export function shouldEmit(ev: Event): boolean {
  switch (ev.kind) {
    case "tool_decision_required":
      return true;
    case "tool_decision_resolved":
      return (ev as any).resolved_by === "timeout";
    case "tool_output_provided":
    case "turn_completed":
    case "turn_failed":
    case "session_stopped":
    case "error":
      return true;
    case "tool_call_result":
      return (ev as any).is_error === true;
    default:
      return false;
  }
}

/**
 * The complete set of event kinds `shouldEmit` could plausibly pass through.
 * Used by `--only` to validate the user's kind list — kinds outside this set
 * would be silently dropped by `shouldEmit` regardless, so accepting them
 * would be misleading.
 */
export const VALID_WATCH_KINDS: ReadonlySet<string> = new Set([
  "tool_decision_required",
  "tool_decision_resolved",
  "tool_output_provided",
  "turn_completed",
  "turn_failed",
  "error",
  "session_stopped",
  "tool_call_result",
  "idle",
]);

/**
 * The `--decision-only` preset: the seven kinds that genuinely require human
 * attention. Drops `turn_completed` (progress) and `tool_output_provided`
 * (confirmation that human-supplied output was relayed).
 */
export const DECISION_ONLY_KINDS: ReadonlySet<string> = new Set([
  "tool_decision_required",
  "tool_decision_resolved",
  "turn_failed",
  "error",
  "session_stopped",
  "tool_call_result",
  "idle",
]);

/**
 * Optional second-layer filter applied AFTER shouldEmit. `null` means no
 * narrowing (the existing default behavior). A non-null Set restricts
 * emission to its members.
 */
export function userFilter(ev: Event, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  return allowed.has(ev.kind);
}

/**
 * Given the full event history, return the subset a NEW watch subscriber
 * needs to see to understand the current state of the session:
 *   - every `tool_decision_required` that still lacks a matching
 *     `tool_decision_resolved` (unresolved gates the driver must act on)
 *   - `session_stopped` if present (so watch exits immediately instead of
 *     tailing a dead session)
 *
 * Events are returned in their original seq order. Without this catch-up,
 * `watch`'s default "from current seq" behavior (v0.2) silently missed
 * pending gates that landed between `start_session` returning and `Monitor`
 * subscribing — see the cloverleaf CLV-16 dogfood finding.
 *
 * Exported for unit-testing.
 */
export function catchUpPending(events: Event[]): Event[] {
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_decision_resolved") {
      resolved.add((e as any).call_id);
    }
  }
  const out: Event[] = [];
  for (const e of events) {
    if (
      e.kind === "tool_decision_required" &&
      !resolved.has((e as any).call_id)
    ) {
      out.push(e);
    } else if (e.kind === "session_stopped") {
      out.push(e);
    }
  }
  return out;
}

/** The per-session filter/replay flags shared by single- and all-mode watch. */
export interface WatchFilterArgs {
  since: number | "current";
  allowed: Set<string> | null;
  noTokenFilter: boolean;
  idleAfterSeconds: number;
  suspectedNeedsInput: boolean;
}

export type ParsedWatchArgs =
  | ({ ok: true; all: false; sessionId: string } & WatchFilterArgs)
  | ({ ok: true; all: true } & WatchFilterArgs)
  | { ok: false; error: string };

/**
 * Sentinel-aware filter — applied AFTER shouldEmit + userFilter, only for
 * `turn_completed` events. Walks back through `events` to find the most
 * recent `assistant_text` of the same turn, extracts the trailing
 * `[TOKEN]`, and returns true iff the resolved surface mode is "always".
 * Other event kinds bypass and always return true.
 *
 * If `noTokenFilter` is true, this layer is a no-op (always true).
 */
export function tokenFilter(
  ev: Event,
  events: Event[],
  noTokenFilter: boolean
): boolean {
  if (noTokenFilter) return true;
  if (ev.kind !== "turn_completed") return true;

  const turnId = (ev as { turn_id: string }).turn_id;
  const lastText = lastAssistantTextForTurn(turnId, events);
  if (lastText === undefined) return false;

  const token = extractTrailingToken(lastText);
  if (token === null) return false;

  return resolveSurfaceMode(token) === "always";
}

/** Find the most recent `assistant_text` for `turnId`, or undefined. */
function lastAssistantTextForTurn(turnId: string, events: Event[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" && (e as { turn_id?: string }).turn_id === turnId) {
      return (e as { text: string }).text;
    }
  }
  return undefined;
}

/** The final non-empty (trimmed) line of `text`, or "" if there is none. */
function finalNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * CD-6 silent-miss backstop: a bounded, stable descriptor for the matched
 * signal, attached to the watch JSON alongside `suspected_needs_input`. A
 * descriptor (not the raw line) keeps the watch stream bounded — the driver
 * gets the full assistant_text via `tail`/`status`.
 */
export const SUSPECTED_NEEDS_INPUT_SIGNAL = "trailing-question-mark";

export type SuspectedNeedsInputVerdict =
  | { suspected: false }
  | { suspected: true; signal: string };

/**
 * CD-6 silent-miss backstop. The sentinel protocol's scariest failure is
 * silent: if Session B should have emitted `[NEEDS-INPUT]` but forgot,
 * `tokenFilter` drops the `turn_completed` and Session A assumes B is working
 * autonomously — the session deadlocks until the idle event eventually fires.
 *
 * For a no-token `turn_completed` this tests the turn's final assistant line:
 * if it ends in `?`, treat the turn as a SUSPECTED needs-input so the caller
 * surfaces it (with an additive marker so the driver can tell it apart from a
 * real `[NEEDS-INPUT]`).
 *
 * Conservative by design (RFC CD-6 out-of-scope list): trailing `?` ONLY — no
 * phrase matching ("should I", "confirm", …). Returns `suspected:false` when
 * disabled, for non-`turn_completed` kinds, for tokened turns (those are not a
 * silent miss), when the turn has no assistant_text, or when the final line is
 * a statement.
 */
export function detectSuspectedNeedsInput(
  ev: Event,
  events: Event[],
  enabled: boolean
): SuspectedNeedsInputVerdict {
  if (!enabled) return { suspected: false };
  if (ev.kind !== "turn_completed") return { suspected: false };

  const turnId = (ev as { turn_id: string }).turn_id;
  const lastText = lastAssistantTextForTurn(turnId, events);
  if (lastText === undefined) return { suspected: false };
  if (extractTrailingToken(lastText) !== null) return { suspected: false };

  if (finalNonEmptyLine(lastText).endsWith("?")) {
    return { suspected: true, signal: SUSPECTED_NEEDS_INPUT_SIGNAL };
  }
  return { suspected: false };
}

/** The additive CD-6 marker the backstop attaches to a rescued turn_completed. */
export interface SuspectedNeedsInputMarker {
  suspected_needs_input: true;
  suspected_needs_input_signal: string;
}

export interface WatchEmitDecision {
  /** true = write `payload` to the watch stream; false = drop. */
  emit: boolean;
  /**
   * The object to serialize. Identical to `ev` unless the CD-6 backstop
   * rescued an otherwise-dropped no-token question turn, in which case it is a
   * shallow copy carrying the additive `suspected_needs_input` marker.
   */
  payload: Event | (Event & SuspectedNeedsInputMarker);
}

/**
 * The full per-event surface decision for `claw-drive watch`, layering the
 * CD-6 silent-miss backstop on top of the sentinel `tokenFilter`. Pure and
 * exported so tests exercise the decision AND the additive-marker shape
 * without spawning a subprocess.
 *
 * `shouldEmit` + `userFilter` are applied by the caller before this; this
 * layer owns only the token/backstop decision and the emitted payload. When
 * `tokenFilter` already surfaces the turn (a real token, or `--no-token-filter`)
 * the event passes through raw — the marker only appears on turns the backstop
 * itself rescues.
 */
export function decideWatchEmit(
  ev: Event,
  events: Event[],
  opts: { noTokenFilter: boolean; suspectedNeedsInput: boolean }
): WatchEmitDecision {
  if (tokenFilter(ev, events, opts.noTokenFilter)) {
    return { emit: true, payload: ev };
  }
  const verdict = detectSuspectedNeedsInput(ev, events, opts.suspectedNeedsInput);
  if (verdict.suspected) {
    const payload: Event & SuspectedNeedsInputMarker = {
      ...ev,
      suspected_needs_input: true,
      suspected_needs_input_signal: verdict.signal,
    };
    return { emit: true, payload };
  }
  return { emit: false, payload: ev };
}

/**
 * Idle-timer state. Pure data — the loop owns this and updates it
 * based on real-time events.
 */
export interface IdleState {
  /** ms timestamp of the last surfaced event (or watch-start if none yet) */
  lastSurfaceMs: number;
  /** ms threshold; 0 means disabled */
  thresholdMs: number;
  /** true once session_stopped has been seen — timer is permanently off */
  cancelled: boolean;
}

export function newIdleState(thresholdSeconds: number, nowMs: number): IdleState {
  return {
    lastSurfaceMs: nowMs,
    thresholdMs: thresholdSeconds * 1000,
    cancelled: false,
  };
}

/**
 * Called whenever an event was emitted to the consumer (passed all filters).
 * Resets the silence timer.
 */
export function noteSurface(state: IdleState, nowMs: number): void {
  state.lastSurfaceMs = nowMs;
}

/**
 * Called when session_stopped is observed. Disables future idle emission.
 */
export function cancelIdle(state: IdleState): void {
  state.cancelled = true;
}

/**
 * Returns true iff an idle event should fire NOW.
 *  - threshold > 0 (idle is enabled for this watch invocation)
 *  - not cancelled (session is still running)
 *  - elapsed silence ≥ threshold
 *
 * Called by the loop on each tick (real or synthetic). When this returns
 * true, the caller emits an idle event and calls noteSurface to reset the
 * timer.
 */
export function shouldFireIdle(state: IdleState, nowMs: number): boolean {
  if (state.cancelled) return false;
  if (state.thresholdMs === 0) return false;
  return nowMs - state.lastSurfaceMs >= state.thresholdMs;
}

/**
 * Walk the accumulated event history backwards to find the most recent
 * `turn_started` whose `turn_id` has no matching `turn_completed` later in
 * the array. Returns that turn_id, or null if no turn has started.
 */
export function deriveCurrentTurn(events: Event[]): string | null {
  const completedTurns = new Set<string>();
  for (const e of events) {
    if (e.kind === "turn_completed") {
      completedTurns.add((e as { turn_id: string }).turn_id);
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "turn_started") {
      const id = (e as { turn_id: string }).turn_id;
      if (!completedTurns.has(id)) return id;
    }
  }
  return null;
}

/**
 * Pure argv parser for `claw-drive watch`. Extracted from `cmdWatch` so tests
 * can exercise flag combinations without spawning a subprocess.
 */
export function parseWatchArgs(argv: string[]): ParsedWatchArgs {
  let sessionId: string | null = null;
  let all = false;
  let since: number | "current" = "current";
  let allowed: Set<string> | null = null;
  let decisionOnlySet = false;
  let onlySet = false;
  let noTokenFilter = false;
  let idleAfterSeconds = DEFAULT_IDLE_AFTER_SECONDS;
  let suspectedNeedsInput = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      all = true;
    } else if (a === "--since") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--since requires a value" };
      since = Number(v);
    } else if (a === "--replay") {
      since = 0;
    } else if (a === "--decision-only") {
      if (onlySet) {
        return { ok: false, error: "--only and --decision-only are mutually exclusive" };
      }
      decisionOnlySet = true;
      allowed = new Set(DECISION_ONLY_KINDS);
    } else if (a === "--only") {
      if (decisionOnlySet) {
        return { ok: false, error: "--only and --decision-only are mutually exclusive" };
      }
      onlySet = true;
      const csv = argv[++i];
      if (csv === undefined) {
        return { ok: false, error: "--only requires a comma-separated list of kinds" };
      }
      const kinds = csv.split(",").map((s) => s.trim()).filter(Boolean);
      if (kinds.length === 0) {
        return { ok: false, error: "--only requires at least one kind" };
      }
      const valid = [...VALID_WATCH_KINDS].join(", ");
      for (const k of kinds) {
        if (!VALID_WATCH_KINDS.has(k)) {
          return {
            ok: false,
            error: `unknown kind '${k}'. valid kinds: ${valid}`,
          };
        }
      }
      allowed = new Set(kinds);
    } else if (a === "--no-token-filter") {
      noTokenFilter = true;
    } else if (a === "--no-suspected-needs-input") {
      suspectedNeedsInput = false;
    } else if (a === "--idle-after") {
      const v = argv[++i];
      if (v === undefined) {
        return { ok: false, error: "--idle-after requires a value (non-negative integer seconds; 0 disables)" };
      }
      if (!/^\d+$/.test(v)) {
        return { ok: false, error: `--idle-after requires a non-negative integer seconds; 0 disables (got '${v}')` };
      }
      idleAfterSeconds = Number(v);
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}` };
    } else {
      // A positional token: the (single) session id.
      if (sessionId !== null) {
        return { ok: false, error: "at most one session id" };
      }
      if (!isValidSessionId(a)) {
        return { ok: false, error: "session id missing or malformed" };
      }
      sessionId = a;
    }
  }

  const filters: WatchFilterArgs = {
    since,
    allowed,
    noTokenFilter,
    idleAfterSeconds,
    suspectedNeedsInput,
  };

  if (all && sessionId !== null) {
    return {
      ok: false,
      error: "--all takes no session id — watch one session by id, or the whole fleet with --all",
    };
  }
  if (!all && sessionId === null) {
    return { ok: false, error: "session id missing or malformed" };
  }

  return all
    ? { ok: true, all: true, ...filters }
    : { ok: true, all: false, sessionId: sessionId as string, ...filters };
}

/**
 * `watch --all` fleet multiplexer. CD-38 lands parsing + live-session
 * enumeration; CD-40 replaces this stub body with the dynamic-membership
 * multiplexer that tails every live session into one tagged stream.
 */
async function cmdWatchAll(
  _parsed: Extract<ParsedWatchArgs, { ok: true; all: true }>
): Promise<number> {
  console.error("watch --all is not yet available");
  return 1;
}

export async function cmdWatch(argv: string[]): Promise<number> {
  const parsed = parseWatchArgs(argv);
  if (!parsed.ok) {
    console.error(
      parsed.error +
        "\nusage: claw-drive watch <session_id> [--since N | --replay] " +
        "[--only KIND[,KIND]... | --decision-only] [--no-token-filter] " +
        "[--idle-after SECONDS] [--no-suspected-needs-input]\n" +
        "  default: stream NEW events only (no replay), idle event after 600s of silence\n" +
        "  --since N: start from seq N (0 = full replay)\n" +
        "  --replay: shorthand for --since 0\n" +
        "  --only KIND[,KIND]...: narrow to a subset of kinds\n" +
        "  --decision-only: shorthand for --only on the human-attention kinds\n" +
        "  --no-token-filter: surface every event regardless of trailing token\n" +
        "  --idle-after SECONDS: emit synthetic 'idle' event after N seconds of silence (default 600; 0 disables)\n" +
        "  --no-suspected-needs-input: disable the silent-miss backstop (no-token '?' turns drop as before; on by default)\n" +
        `  valid kinds: ${[...VALID_WATCH_KINDS].join(", ")}`
    );
    return 2;
  }
  if (parsed.all) {
    return cmdWatchAll(parsed);
  }
  // Single-session watch is now the tailer driven straight to stdout. The
  // tail loop (catch-up, cursor, fs.watch, idle ticker, filter chain,
  // session_stopped handling) lives in src/lib/session-tailer.ts so the
  // watch --all multiplexer can reuse it. No tag → output is byte-identical
  // to before.
  let watchError: string | null = null;
  const tailer = startSessionTailer({
    sessionId: parsed.sessionId,
    emit: (line) => process.stdout.write(line),
    since: parsed.since,
    allowed: parsed.allowed,
    noTokenFilter: parsed.noTokenFilter,
    suspectedNeedsInput: parsed.suspectedNeedsInput,
    idleAfterSeconds: parsed.idleAfterSeconds,
    onWatchError: (msg) => {
      watchError = msg;
    },
  });
  process.once("SIGINT", () => tailer.close());
  await tailer.done;
  if (watchError !== null) {
    console.error("cannot watch events.jsonl:", watchError);
    return 1;
  }
  return 0;
}
