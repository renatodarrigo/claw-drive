import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, isValidSessionId } from "./paths.js";
import { readState, isPidAlive, type SessionState } from "./state.js";
import { inFleetView, type FleetView } from "./fleet.js";

/**
 * The session statuses that mean "still active" — worth tailing under
 * `watch --all` and worth a `send --all` turn. A session in one of these
 * states whose runner pid is dead is orphaned (mirrors the orphan detection
 * in sessions.ts / status.ts) and is NOT considered live.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "ready", "running"]);

export interface SessionRow {
  id: string;
  state: SessionState;
  /** Fleets: whether this session is in the caller's fleet view. */
  inView: boolean;
}

/** True iff the sessions root directory exists (surfaces distinguish "no directory" from "empty"). */
export async function sessionsRootExists(): Promise<boolean> {
  try {
    await fs.access(sessionsRoot());
    return true;
  } catch {
    return false;
  }
}

/**
 * The one sessions-root enumerator every fleet surface uses. Returns every
 * valid-id session dir whose state.json exists AND parses, sorted by id, each
 * row carrying `inView` per the fleet predicate. A corrupt state.json is
 * skipped (the posture alias resolution and `status` already take) rather
 * than aborting the listing. Rows are NOT pre-filtered so each surface can
 * apply its own liveness rule and then count what the view hid. A missing
 * root yields `[]`.
 */
export async function listSessions(view: FleetView): Promise<SessionRow[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    let state: SessionState | null;
    try {
      state = await readState(statePath(id));
    } catch {
      continue;
    }
    if (state === null) continue;
    rows.push({ id, state, inView: inFleetView(state, view) });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/** The `watch --all` / `send --all` liveness rule: active status AND a live runner pid. */
export function isLiveState(state: SessionState): boolean {
  if (!ACTIVE_STATUSES.has(state.status)) return false;
  if (state.runner_pid === null || !isPidAlive(state.runner_pid)) return false;
  return true;
}

/**
 * Ids of the live sessions in the fleet view, sorted for deterministic
 * membership. Used by `watch --all` (and its periodic rescan).
 */
export async function listLiveSessions(view: FleetView): Promise<string[]> {
  return (await listSessions(view))
    .filter((r) => r.inView && isLiveState(r.state))
    .map((r) => r.id);
}
