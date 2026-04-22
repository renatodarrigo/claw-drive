import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, eventsPath, isValidSessionId } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";
import { readEventsSince } from "../../lib/events.js";

export async function cmdSessions(_argv: string[]): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    console.log("(no sessions)");
    return 0;
  }
  const rows: string[] = [];
  rows.push(["SESSION_ID", "STATUS", "TURNS", "PENDING", "CWD"].join("\t"));
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const s = await readState(statePath(id));
    if (!s) continue;
    const alive = s.runner_pid ? isPidAlive(s.runner_pid) : false;
    const status =
      !alive && (s.status === "ready" || s.status === "running" || s.status === "starting")
        ? "orphaned"
        : s.status;
    const events = (await readEventsSince(eventsPath(id), 0)).events;
    const requiredCalls = new Set(
      events.filter((e) => e.kind === "tool_decision_required").map((e) => (e as any).call_id as string)
    );
    const resolvedCalls = new Set(
      events.filter((e) => e.kind === "tool_decision_resolved").map((e) => (e as any).call_id as string)
    );
    let pending = 0;
    for (const c of requiredCalls) if (!resolvedCalls.has(c)) pending++;
    rows.push([id, status, String(s.turns), String(pending), s.cwd].join("\t"));
  }
  console.log(rows.join("\n"));
  return 0;
}
