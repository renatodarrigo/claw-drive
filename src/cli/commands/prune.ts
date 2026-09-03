import * as fs from "node:fs/promises";
import { sessionDir, crashHandoverPath } from "../../lib/paths.js";
import { isPidAlive } from "../../lib/state.js";
import { parseFleetFlags } from "../../lib/fleet.js";
import { listSessions, sessionsRootExists } from "../../lib/live-sessions.js";

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2];
  return n * (unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000);
}

export async function cmdPrune(argv: string[]): Promise<number> {
  // Fleets: prune deletes only within the fleet view — another driver's dead
  // sessions are theirs to prune; --all-fleets widens deliberately.
  const fleet = parseFleetFlags(argv);
  if (!fleet.ok) {
    console.error(fleet.error);
    return 2;
  }
  const args = fleet.rest;
  let olderThan = parseDuration("24h");
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--older-than") olderThan = parseDuration(args[++i] ?? "24h");
    else if (args[i] === "--force") force = true;
  }
  const cutoff = Date.now() - olderThan;
  if (!(await sessionsRootExists())) return 0;
  const rows = await listSessions(fleet.view);
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const { id, state: s, inView } of rows) {
    if (!inView) continue;
    const alive = s.runner_pid ? isPidAlive(s.runner_pid) : false;
    if (alive) continue;
    const startedAt = Date.parse(s.started_at);
    if (startedAt > cutoff) continue;
    if (!force && !s.rotated_to) {
      // Context rotation: a crash-handover no successor ever consumed may be the only
      // distilled copy of the session's final state — refuse to eat it.
      try {
        await fs.access(crashHandoverPath(id));
        skipped.push(id);
        continue;
      } catch {
        /* no unconsumed crash handover — prune as before */
      }
    }
    await fs.rm(sessionDir(id), { recursive: true, force: true });
    removed.push(id);
  }
  console.log(JSON.stringify({ removed, skipped_unconsumed_handover: skipped }));
  return 0;
}
