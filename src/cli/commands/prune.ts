import * as fs from "node:fs/promises";
import { sessionsRoot, sessionDir, statePath, crashHandoverPath, isValidSessionId } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2];
  return n * (unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000);
}

export async function cmdPrune(argv: string[]): Promise<number> {
  let olderThan = parseDuration("24h");
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--older-than") olderThan = parseDuration(argv[++i] ?? "24h");
    else if (argv[i] === "--force") force = true;
  }
  const cutoff = Date.now() - olderThan;
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    return 0;
  }
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const s = await readState(statePath(id));
    if (!s) continue;
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
