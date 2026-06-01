import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, eventsPath, isValidSessionId } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";
import { readEventsSince } from "../../lib/events.js";
import { resolveSessionRef } from "../../lib/alias.js";

export async function cmdPending(argv: string[]): Promise<number> {
  const target = argv[0];
  let ids: string[];
  if (target) {
    // CD-10: accept a canonical id or a live alias.
    const id = await resolveSessionRef(target);
    if (id === null) {
      console.error(`no live session for '${target}'`);
      return 2;
    }
    ids = [id];
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
      // CD-10: include the alias alongside session_id when the session has one;
      // un-aliased lines are byte-identical (no alias key).
      const tag = s.alias ? { session_id: id, alias: s.alias } : { session_id: id };
      console.log(JSON.stringify({ ...tag, ...p }));
    }
  }
  return 0;
}
