import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { listLiveSessions, listSessions, isLiveState, sessionsRootExists } from "../../src/lib/live-sessions.js";

/** No identity: the view is untagged sessions only — which is every fixture in the pre-existing tests. */
const NO_IDENTITY = { acting: undefined, allFleets: false };

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

    const live = await listLiveSessions(NO_IDENTITY);
    expect(live).toEqual(["sess_rdy01", "sess_run01", "sess_srt01"]);
  });

  it("returns [] when the sessions root does not exist", async () => {
    await fs.rm(root, { recursive: true, force: true });
    expect(await listLiveSessions(NO_IDENTITY)).toEqual([]);
    await fs.mkdir(root, { recursive: true }); // restore for afterEach cleanup
  });

  it("returns [] when there are no session dirs", async () => {
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    expect(await listLiveSessions(NO_IDENTITY)).toEqual([]);
  });
});

describe("listSessions — fleet view", () => {
  it("returns every readable session sorted by id, with inView per the fleet predicate", async () => {
    await writeSession("sess_own", baseState({ session_id: "sess_own", fleet: "A" }));
    await writeSession("sess_other", baseState({ session_id: "sess_other", fleet: "B" }));
    await writeSession("sess_free", baseState({ session_id: "sess_free" }));
    const rows = await listSessions({ acting: "A", allFleets: false });
    expect(rows.map((r) => [r.id, r.inView])).toEqual([
      ["sess_free", true],
      ["sess_other", false],
      ["sess_own", true],
    ]);
    expect(rows[2].state.fleet).toBe("A");
  });

  it("--all-fleets puts every row in view", async () => {
    await writeSession("sess_other", baseState({ session_id: "sess_other", fleet: "B" }));
    const rows = await listSessions({ acting: "A", allFleets: true });
    expect(rows.map((r) => r.inView)).toEqual([true]);
  });

  it("with no identity only untagged rows are in view", async () => {
    await writeSession("sess_tagged", baseState({ session_id: "sess_tagged", fleet: "A" }));
    await writeSession("sess_free", baseState({ session_id: "sess_free" }));
    const rows = await listSessions(NO_IDENTITY);
    expect(rows.map((r) => [r.id, r.inView])).toEqual([
      ["sess_free", true],
      ["sess_tagged", false],
    ]);
  });

  it("skips a corrupt state.json instead of throwing, and skips invalid ids and state-less dirs", async () => {
    await writeSession("sess_good", baseState({ session_id: "sess_good" }));
    await fs.mkdir(path.join(root, "sessions", "sess_corrupt"), { recursive: true });
    await fs.writeFile(path.join(root, "sessions", "sess_corrupt", "state.json"), "{not json");
    await writeSession("sess_nostate", null);
    await fs.mkdir(path.join(root, "sessions", "not-a-session"), { recursive: true });
    const rows = await listSessions(NO_IDENTITY);
    expect(rows.map((r) => r.id)).toEqual(["sess_good"]);
  });

  it("a missing sessions root yields [] and sessionsRootExists() false", async () => {
    await fs.rm(path.join(root, "sessions"), { recursive: true, force: true });
    expect(await listSessions(NO_IDENTITY)).toEqual([]);
    expect(await sessionsRootExists()).toBe(false);
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    expect(await sessionsRootExists()).toBe(true);
  });
});

describe("isLiveState", () => {
  it("true for an active status with a live pid; false for a dead pid, a null pid, or a terminal status", () => {
    expect(isLiveState(baseState({}) as never)).toBe(true);
    expect(isLiveState(baseState({ status: "starting" }) as never)).toBe(true);
    expect(isLiveState(baseState({ runner_pid: DEAD_PID }) as never)).toBe(false);
    expect(isLiveState(baseState({ runner_pid: null }) as never)).toBe(false);
    expect(isLiveState(baseState({ status: "stopped" }) as never)).toBe(false);
  });
});

describe("listLiveSessions(view)", () => {
  it("returns only in-view live ids, sorted", async () => {
    await writeSession("sess_own", baseState({ session_id: "sess_own", fleet: "A" }));
    await writeSession("sess_other", baseState({ session_id: "sess_other", fleet: "B" }));
    await writeSession("sess_dead", baseState({ session_id: "sess_dead", fleet: "A", runner_pid: DEAD_PID }));
    await writeSession("sess_free", baseState({ session_id: "sess_free" }));
    expect(await listLiveSessions({ acting: "A", allFleets: false })).toEqual(["sess_free", "sess_own"]);
    expect(await listLiveSessions({ acting: "A", allFleets: true })).toEqual(["sess_free", "sess_other", "sess_own"]);
  });
});
