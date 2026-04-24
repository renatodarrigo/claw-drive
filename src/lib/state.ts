import * as fs from "node:fs/promises";
import type { Policy } from "./policy.js";

export type SessionStatus =
  | "starting"
  | "ready"
  | "running"
  | "failed"
  | "stopped"
  | "orphaned";

export interface SessionState {
  session_id: string;
  status: SessionStatus;
  cwd: string;
  policy: Policy;
  decision_timeout_seconds: number;
  model: string | null;
  runner_pid: number | null;
  started_at: string;
  last_event_at: string | null;
  turns: number;
  exit_code: number | null;
  exit_reason: string | null;
}

export async function readState(statePath: string): Promise<SessionState | null> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Per-path write queue. All writeState() calls against the same path are
// serialised in submission order, eliminating a race where two concurrent
// writers share the same `.tmp-<pid>` filename and the second rename() fails
// with ENOENT because the first writer already renamed the tmp away.
// Scope is in-process; the runner is a single process per session, which
// matches the "single writer per session" invariant documented in the design.
const writeChains = new Map<string, Promise<void>>();

export async function writeState(statePath: string, state: SessionState): Promise<void> {
  const prev = writeChains.get(statePath) ?? Promise.resolve();
  const next = prev.then(() => doWriteState(statePath, state));
  // Swallow errors on the CHAIN so one failed write doesn't poison subsequent
  // writes (they should still run). The caller's `next` handle still rejects,
  // so the original error is visible to whoever awaited this specific write.
  writeChains.set(statePath, next.catch(() => undefined));
  return next;
}

async function doWriteState(statePath: string, state: SessionState): Promise<void> {
  const tmp = statePath + ".tmp-" + process.pid;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8" });
  await fs.rename(tmp, statePath);
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true; // process exists, just not ours
    return false;
  }
}
