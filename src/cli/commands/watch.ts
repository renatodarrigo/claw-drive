import * as fs from "node:fs";
import { eventsPath, isValidSessionId } from "../../lib/paths.js";
import { readEventsSince, type Event } from "../../lib/events.js";
import {
  extractTrailingToken,
  resolveSurfaceMode,
  DEFAULT_IDLE_AFTER_SECONDS,
} from "../../lib/tokens.js";

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
 * The `--decision-only` preset: the six kinds that genuinely require human
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

export type ParsedWatchArgs =
  | {
      ok: true;
      sessionId: string;
      since: number | "current";
      allowed: Set<string> | null;
      noTokenFilter: boolean;
      idleAfterSeconds: number;
    }
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
  let lastText: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" && (e as { turn_id?: string }).turn_id === turnId) {
      lastText = (e as { text: string }).text;
      break;
    }
  }
  if (lastText === undefined) return false;

  const token = extractTrailingToken(lastText);
  if (token === null) return false;

  return resolveSurfaceMode(token) === "always";
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
  const id = argv[0];
  if (!id || !isValidSessionId(id)) {
    return { ok: false, error: "session id missing or malformed" };
  }
  let since: number | "current" = "current";
  let allowed: Set<string> | null = null;
  let decisionOnlySet = false;
  let onlySet = false;
  let noTokenFilter = false;
  let idleAfterSeconds = DEFAULT_IDLE_AFTER_SECONDS;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") {
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
    } else if (a === "--idle-after") {
      const v = argv[++i];
      if (v === undefined) {
        return { ok: false, error: "--idle-after requires a value (non-negative integer seconds; 0 disables)" };
      }
      if (!/^\d+$/.test(v)) {
        return { ok: false, error: `--idle-after requires a non-negative integer seconds; 0 disables (got '${v}')` };
      }
      idleAfterSeconds = Number(v);
    } else {
      return { ok: false, error: `unknown flag: ${a}` };
    }
  }

  return {
    ok: true,
    sessionId: id,
    since,
    allowed,
    noTokenFilter,
    idleAfterSeconds,
  };
}

export async function cmdWatch(argv: string[]): Promise<number> {
  const parsed = parseWatchArgs(argv);
  if (!parsed.ok) {
    console.error(
      parsed.error +
        "\nusage: claw-drive watch <session_id> [--since N | --replay] " +
        "[--only KIND[,KIND]... | --decision-only] [--no-token-filter] " +
        "[--idle-after SECONDS]\n" +
        "  default: stream NEW events only (no replay), idle event after 600s of silence\n" +
        "  --since N: start from seq N (0 = full replay)\n" +
        "  --replay: shorthand for --since 0\n" +
        "  --only KIND[,KIND]...: narrow to a subset of kinds\n" +
        "  --decision-only: shorthand for --only on the human-attention kinds\n" +
        "  --no-token-filter: surface every event regardless of trailing token\n" +
        "  --idle-after SECONDS: emit synthetic 'idle' event after N seconds of silence (default 600; 0 disables)\n" +
        `  valid kinds: ${[...VALID_WATCH_KINDS].join(", ")}`
    );
    return 2;
  }
  const { sessionId: id, allowed, noTokenFilter, idleAfterSeconds } = parsed;
  let since = parsed.since;

  // tokenFilter needs to find the matching assistant_text for any
  // turn_completed event, which may have been emitted in an earlier read
  // cycle. We accumulate the full event history seen since cmdWatch started
  // so the lookup always succeeds.
  const allEvents: Event[] = [];

  // Idle-event timer. Threshold of 0 disables the feature entirely;
  // shouldFireIdle bails on threshold===0, so the timer plumbing below
  // is a no-op in that mode.
  const idle = newIdleState(idleAfterSeconds, Date.now());

  // Synthetic events use NEGATIVE seq numbers so they never collide with
  // the runner's positive monotonic seq from events.jsonl. v0.5.7 convention.
  let nextSyntheticSeq = -1;
  const syntheticSeq = (): number => nextSyntheticSeq--;

  // Default: stream NEW events only, BUT catch up on unresolved gates +
  // session_stopped first. This plugs a race where events emitted between
  // start_session's return and Monitor's spawn-of-watch would otherwise be
  // skipped (cloverleaf CLV-16 dogfood finding, 2026-04-22).
  let stopped = false;
  if (since === "current") {
    const all = await readEventsSince(eventsPath(id), 0);
    allEvents.push(...all.events);
    const catchup = catchUpPending(all.events);
    for (const e of catchup) {
      if (userFilter(e, allowed)) {
        process.stdout.write(JSON.stringify(e) + "\n");
        noteSurface(idle, Date.now());
      }
      if (e.kind === "session_stopped") {
        stopped = true;
        cancelIdle(idle);
      }
    }
    since = all.nextSince;
  }

  // Emit a synthetic idle event if the silence threshold has elapsed, then
  // reset the timer. Subject to userFilter so `--only` works for idle.
  const maybeEmitIdle = (): void => {
    if (!shouldFireIdle(idle, Date.now())) return;
    const idleEvent = {
      seq: syntheticSeq(),
      at: new Date().toISOString(),
      kind: "idle" as const,
      silent_for_ms: idle.thresholdMs,
      current_turn: deriveCurrentTurn(allEvents),
    };
    if (userFilter(idleEvent as unknown as Event, allowed)) {
      process.stdout.write(JSON.stringify(idleEvent) + "\n");
    }
    noteSurface(idle, Date.now());
  };

  let cursor: number = since;
  const emit = async () => {
    const { events, nextSince } = await readEventsSince(eventsPath(id), cursor);
    for (const e of events) {
      allEvents.push(e);
      if (
        shouldEmit(e) &&
        userFilter(e, allowed) &&
        tokenFilter(e, allEvents, noTokenFilter)
      ) {
        process.stdout.write(JSON.stringify(e) + "\n");
        noteSurface(idle, Date.now());
      }
      if (e.kind === "session_stopped") {
        stopped = true;
        cancelIdle(idle);
      }
    }
    cursor = nextSince;
    // After draining a batch (real or empty), check whether silence has
    // tripped the idle threshold.
    maybeEmitIdle();
  };

  // Initial drain (only meaningful if --replay or --since < current)
  await emit();
  if (stopped) return 0;

  // Tail on changes
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(eventsPath(id), { persistent: true });
  } catch (err) {
    console.error("cannot watch events.jsonl:", (err as Error).message);
    return 1;
  }

  // fs.watch only fires on file changes — but idle is precisely the
  // absence-of-changes signal. We need an independent ticker. Pick a tick
  // cadence that catches the threshold crossing within a small fraction
  // (~quarter) of the threshold, capped at 5s so short thresholds (test
  // configs, stress runs) react promptly without burning CPU on long ones.
  const tickMs =
    idle.thresholdMs === 0
      ? 0
      : Math.max(250, Math.min(5000, Math.floor(idle.thresholdMs / 4)));

  const done = new Promise<void>((resolve) => {
    let ticker: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
      if (watcher) watcher.close();
    };
    const onChange = async () => {
      try {
        await emit();
        if (stopped) {
          cleanup();
          resolve();
        }
      } catch {
        /* swallow transient read errors */
      }
    };
    watcher!.on("change", onChange);
    if (tickMs > 0) {
      ticker = setInterval(() => {
        try {
          maybeEmitIdle();
        } catch {
          /* defensive: never let a tick crash the watcher */
        }
      }, tickMs);
    }
    process.once("SIGINT", () => {
      cleanup();
      resolve();
    });
  });
  await done;
  return 0;
}
