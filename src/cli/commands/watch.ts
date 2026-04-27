import * as fs from "node:fs";
import { eventsPath, isValidSessionId } from "../../lib/paths.js";
import { readEventsSince, type Event } from "../../lib/events.js";

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
    }
  | { ok: false; error: string };

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
    } else {
      return { ok: false, error: `unknown flag: ${a}` };
    }
  }

  return { ok: true, sessionId: id, since, allowed };
}

export async function cmdWatch(argv: string[]): Promise<number> {
  const parsed = parseWatchArgs(argv);
  if (!parsed.ok) {
    console.error(
      parsed.error +
        "\nusage: claw-drive watch <session_id> [--since N | --replay] [--only KIND[,KIND]... | --decision-only]\n" +
        "  default: stream NEW events only (no replay)\n" +
        "  --since N: start from seq N (0 = full replay)\n" +
        "  --replay: shorthand for --since 0\n" +
        "  --only KIND[,KIND]...: narrow to a subset of kinds (must be valid watch kinds)\n" +
        "  --decision-only: shorthand for --only on the six human-attention kinds\n" +
        `  valid kinds: ${[...VALID_WATCH_KINDS].join(", ")}`
    );
    return 2;
  }
  const { sessionId: id, allowed } = parsed;
  let since = parsed.since;

  // Default: stream NEW events only, BUT catch up on unresolved gates +
  // session_stopped first. This plugs a race where events emitted between
  // start_session's return and Monitor's spawn-of-watch would otherwise be
  // skipped (cloverleaf CLV-16 dogfood finding, 2026-04-22).
  let stopped = false;
  if (since === "current") {
    const all = await readEventsSince(eventsPath(id), 0);
    const catchup = catchUpPending(all.events);
    for (const e of catchup) {
      if (userFilter(e, allowed)) {
        process.stdout.write(JSON.stringify(e) + "\n");
      }
      if (e.kind === "session_stopped") stopped = true;
    }
    since = all.nextSince;
  }

  let cursor: number = since;
  const emit = async () => {
    const { events, nextSince } = await readEventsSince(eventsPath(id), cursor);
    for (const e of events) {
      if (shouldEmit(e) && userFilter(e, allowed)) {
        process.stdout.write(JSON.stringify(e) + "\n");
      }
      if (e.kind === "session_stopped") stopped = true;
    }
    cursor = nextSince;
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

  const done = new Promise<void>((resolve) => {
    const onChange = async () => {
      try {
        await emit();
        if (stopped) {
          if (watcher) watcher.close();
          resolve();
        }
      } catch {
        /* swallow transient read errors */
      }
    };
    watcher!.on("change", onChange);
    process.once("SIGINT", () => {
      if (watcher) watcher.close();
      resolve();
    });
  });
  await done;
  return 0;
}
