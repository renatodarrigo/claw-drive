import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, isValidSessionId } from "./paths.js";
import { readState, isPidAlive } from "./state.js";

/**
 * The session statuses that mean "still active" — worth tailing under
 * `watch --all`. A session in one of these states whose runner pid is dead is
 * orphaned (mirrors the orphan detection in sessions.ts / status.ts) and is
 * NOT considered live.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "ready", "running"]);

/**
 * Enumerate the ids of live driven sessions: a readable state in an active
 * status (starting/ready/running) backed by a live runner pid. Stopped,
 * failed, orphaned (active-but-dead-pid), pid-less, invalid-id, and
 * state-less directories are all excluded. Returns the surviving ids sorted
 * for deterministic membership.
 *
 * Used by `watch --all` (and its periodic rescan) to decide which sessions to
 * tail. A missing sessions root yields `[]`.
 */
export async function listLiveSessions(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    return [];
  }
  const live: string[] = [];
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    let state;
    try {
      state = await readState(statePath(id));
    } catch {
      continue;
    }
    if (state === null) continue;
    if (!ACTIVE_STATUSES.has(state.status)) continue;
    if (state.runner_pid === null || !isPidAlive(state.runner_pid)) continue;
    live.push(id);
  }
  return live.sort();
}
