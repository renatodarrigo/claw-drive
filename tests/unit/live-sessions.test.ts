import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { listLiveSessions } from "../../src/lib/live-sessions.js";

let root: string;
let prevHome: string | undefined;

// A reliably-dead pid: spawn a node that exits immediately, then reuse its
// (now-reaped) pid. isPidAlive(deadPid) → ESRCH → false.
const DEAD_PID: number = (() => {
  const c = spawnSync(process.execPath, ["-e", ""]);
  return c.pid as number;
})();

function baseState(over: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "x",
    status: "running",
    cwd: "/tmp",
    policy: "bypass",
    decision_timeout_seconds: 600,
    model: null,
    runner_pid: process.pid,
    started_at: "2026-05-31T00:00:00Z",
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
    ...over,
  };
}

async function writeSession(id: string, state: Record<string, unknown> | null): Promise<void> {
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  if (state !== null) {
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state));
  }
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd38-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("listLiveSessions", () => {
  it("returns only alive sessions (active status + live pid), sorted; excludes stopped/orphaned/no-pid/invalid/state-less", async () => {
    await writeSession("sess_run01", baseState({ session_id: "sess_run01", status: "running", runner_pid: process.pid }));
    await writeSession("sess_rdy01", baseState({ session_id: "sess_rdy01", status: "ready", runner_pid: process.pid }));
    await writeSession("sess_srt01", baseState({ session_id: "sess_srt01", status: "starting", runner_pid: process.pid }));
    await writeSession("sess_stp01", baseState({ session_id: "sess_stp01", status: "stopped", runner_pid: process.pid }));
    await writeSession("sess_orp01", baseState({ session_id: "sess_orp01", status: "running", runner_pid: DEAD_PID }));
    await writeSession("sess_nop01", baseState({ session_id: "sess_nop01", status: "running", runner_pid: null }));
    await writeSession("not-a-session", baseState({ status: "running" })); // invalid id dir
    await writeSession("sess_nost1", null); // dir but no state.json

    const live = await listLiveSessions();
    expect(live).toEqual(["sess_rdy01", "sess_run01", "sess_srt01"]);
  });

  it("returns [] when the sessions root does not exist", async () => {
    await fs.rm(root, { recursive: true, force: true });
    expect(await listLiveSessions()).toEqual([]);
    await fs.mkdir(root, { recursive: true }); // restore for afterEach cleanup
  });

  it("returns [] when there are no session dirs", async () => {
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    expect(await listLiveSessions()).toEqual([]);
  });
});
