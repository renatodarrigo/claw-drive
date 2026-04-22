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

export async function cmdWatch(argv: string[]): Promise<number> {
  const id = argv[0];
  if (!id || !isValidSessionId(id)) {
    console.error(
      "usage: claw-drive watch <session_id> [--since N] [--replay]\n" +
        "  default: start streaming from the current end of the event log (not replay-from-0)\n" +
        "  --since N: start from seq N (0 = full replay)\n" +
        "  --replay: shorthand for --since 0"
    );
    return 2;
  }
  let since: number | "current" = "current";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--since") since = Number(argv[++i] ?? 0);
    else if (argv[i] === "--replay") since = 0;
  }

  // Default: stream NEW events only. Avoids flooding a mid-run monitor.
  if (since === "current") {
    const all = await readEventsSince(eventsPath(id), 0);
    since = all.nextSince;
  }

  let stopped = false;
  let cursor: number = since;
  const emit = async () => {
    const { events, nextSince } = await readEventsSince(eventsPath(id), cursor);
    for (const e of events) {
      if (shouldEmit(e)) {
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
