import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, eventsPath, isValidSessionId } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";
import { readEventsSince } from "../../lib/events.js";

export async function cmdPending(argv: string[]): Promise<number> {
  const target = argv[0];
  let ids: string[];
  if (target) {
    if (!isValidSessionId(target)) {
      console.error("invalid session_id");
      return 2;
    }
    ids = [target];
  } else {
    try {
      ids = (await fs.readdir(sessionsRoot())).filter(isValidSessionId);
    } catch {
      console.log("(no sessions)");
      return 0;
    }
  }
  for (const id of ids) {
    const s = await readState(statePath(id));
    if (!s || (s.runner_pid && !isPidAlive(s.runner_pid))) continue;
    const events = (await readEventsSince(eventsPath(id), 0)).events;
    const resolved = new Set(
      events.filter((e) => e.kind === "tool_decision_resolved").map((e) => (e as any).call_id as string)
    );
    const pending = events.filter(
      (e) => e.kind === "tool_decision_required" && !resolved.has((e as any).call_id)
    );
    for (const p of pending) {
      console.log(JSON.stringify({ session_id: id, ...p }));
    }
  }
  return 0;
}
