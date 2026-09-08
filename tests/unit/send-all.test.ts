import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as net from "node:net";
import { cmdSend, sendToFleet, type SendFn } from "../../src/cli/commands/send.js";
import { listSessions, type SessionRow } from "../../src/lib/live-sessions.js";
import { startSocketServer } from "../../src/runner/socket-server.js";
import { sessionDir, statePath, socketPath } from "../../src/lib/paths.js";
import type { ControlRequest, ControlResponse } from "../../src/lib/socket-protocol.js";

// Real socket servers stand in for runners (socket-protocol precedent): the
// fan-out's transport, ordering, timeout, and refusal paths are exercised
// against production wire semantics, not mocks. The one exception is the
// parallelism test — concurrency is not observable from the wire without
// timing it, so that one latches through the deps.send seam instead.

let home: string;
const servers: net.Server[] = [];
const ENV_KEYS = ["CLAW_DRIVE_HOME", "CLAW_DRIVE_FLEET", "CLAUDE_CODE_SESSION_ID"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

type Behavior = "accept" | "refuse-exited" | "hang" | "no-socket";

async function session(id: string, over: Record<string, unknown>, behavior: Behavior): Promise<void> {
  await fs.mkdir(sessionDir(id), { recursive: true });
  await fs.writeFile(
    statePath(id),
    JSON.stringify({
      session_id: id, status: "running", cwd: "/tmp/x", policy: "bypass",
      decision_timeout_seconds: 3600, model: null, runner_pid: process.pid,
      started_at: "2026-09-02T00:00:00Z", last_event_at: null, turns: 4,
      exit_code: null, exit_reason: null, ...over,
    })
  );
  if (behavior === "no-socket") return;
  const handler = (req: ControlRequest): Promise<ControlResponse> => {
    if (behavior === "hang") return new Promise(() => {});
    if (behavior === "refuse-exited") {
      return Promise.resolve({
        id: req.id, ok: false, error: "SESSION_EXITED",
        message: "session process has exited; turn cannot start — use recover",
      });
    }
    return Promise.resolve({ id: req.id, ok: true, result: { turn_id: "turn_5" } });
  };
  servers.push(await startSocketServer(socketPath(id), handler));
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await fn();
    return {
      code,
      out: log.mock.calls.map((c) => c.join(" ")),
      err: errSpy.mock.calls.map((c) => c.join(" ")).join("\n"),
    };
  } finally {
    log.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd-send-all-"));
  process.env.CLAW_DRIVE_HOME = home;
  process.env.CLAW_DRIVE_FLEET = "team-a";
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(home, { recursive: true, force: true });
});

const inView = async (): Promise<SessionRow[]> =>
  (await listSessions({ acting: "team-a", allFleets: false })).filter((r) => r.inView);

describe("sendToFleet", () => {
  it("one line per target in id order, with alias/fleet when present, keys in the spec's order", async () => {
    // Every member here settles in milliseconds — the no-socket connect error
    // first, though it sorts last — so no timeoutMs is passed and the default
    // 5 s window is never approached: a stalled box cannot redden ordering.
    await session("sess_a_ok", { fleet: "team-a", alias: "reviewer" }, "accept");
    await session("sess_b_exited", {}, "refuse-exited");
    await session("sess_d_nosock", { fleet: "team-a", status: "starting" }, "no-socket");
    const lines = await sendToFleet(await inView(), "hello");
    expect(lines.map((l) => l.session_id)).toEqual(["sess_a_ok", "sess_b_exited", "sess_d_nosock"]);
    expect(Object.keys(lines[0])).toEqual(["session_id", "alias", "fleet", "ok", "turn_id"]);
    expect(lines[0]).toEqual({ session_id: "sess_a_ok", alias: "reviewer", fleet: "team-a", ok: true, turn_id: "turn_5" });
    expect(lines[1]).toEqual({
      session_id: "sess_b_exited", ok: false, error: "SESSION_EXITED",
      message: "session process has exited; turn cannot start — use recover",
    });
    expect(lines[2]).toMatchObject({ session_id: "sess_d_nosock", ok: false, error: "SESSION_UNREACHABLE" });
    expect(Object.keys(lines[1])).toEqual(["session_id", "ok", "error", "message"]);
  });

  it("a member that never answers becomes SESSION_UNREACHABLE at the timeout", async () => {
    // The only member hangs, so a scheduler stall can delay this test but
    // never flip it — the line is a timeout either way.
    await session("sess_hang", { fleet: "team-a" }, "hang");
    const lines = await sendToFleet(await inView(), "hello", { timeoutMs: 100 });
    expect(lines).toEqual([
      { session_id: "sess_hang", fleet: "team-a", ok: false, error: "SESSION_UNREACHABLE", message: "socket timeout" },
    ]);
  });

  it("fans the turn out in parallel: the second send begins before the first settles", async () => {
    // A latch through the deps.send seam, not the wall clock: the first send
    // parks until the second has begun. A serial fan-out never begins the
    // second, so the safety timer rejects the parked send and this fails in
    // ~2 s — it cannot pass on a fast machine or hang on a slow one.
    await session("sess_a", { fleet: "team-a" }, "no-socket");
    await session("sess_b", { fleet: "team-a" }, "no-socket");
    let secondBegan!: () => void;
    let giveUp!: (e: Error) => void;
    const bothInFlight = new Promise<void>((resolve) => { secondBegan = resolve; });
    const safety = new Promise<never>((_, reject) => { giveUp = reject; });
    const timer = setTimeout(() => giveUp(new Error("the second send never began — the fan-out is serial")), 2000);
    let calls = 0;
    const send: SendFn = async (_socketPath, req) => {
      const n = ++calls;
      if (n === 1) await Promise.race([bothInFlight, safety]);
      else secondBegan();
      return { id: req.id, ok: true, result: { turn_id: `turn_${n}` } };
    };
    try {
      const lines = await sendToFleet(await inView(), "hello", { send });
      expect(lines.map((l) => [l.session_id, l.ok, l.turn_id])).toEqual([
        ["sess_a", true, "turn_1"],
        ["sess_b", true, "turn_2"],
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe("claw-drive send --all", () => {
  it("broadcasts to the fleet view's live members only and exits 0 when all accept", async () => {
    await session("sess_own", { fleet: "team-a" }, "accept");
    await session("sess_free", {}, "accept");
    await session("sess_other", { fleet: "team-b" }, "accept");
    await session("sess_dead", { fleet: "team-a", runner_pid: 999_999_999 }, "no-socket");
    await session("sess_stopped", { fleet: "team-a", status: "stopped", runner_pid: null }, "no-socket");
    const r = await capture(() => cmdSend(["--all", "wrap up"]));
    expect(r.code).toBe(0);
    expect(r.out.map((l) => JSON.parse(l).session_id)).toEqual(["sess_free", "sess_own"]);
    expect(r.err).toBe("");
  });

  it("exits 1 when any member refuses, still reporting every member", async () => {
    await session("sess_a", { fleet: "team-a" }, "accept");
    await session("sess_b", { fleet: "team-a" }, "refuse-exited");
    const r = await capture(() => cmdSend(["--all", "wrap up"]));
    expect(r.code).toBe(1);
    expect(r.out.map((l) => JSON.parse(l).ok)).toEqual([true, false]);
  });

  it("--all-fleets broadcasts box-wide; --fleet acts as another fleet", async () => {
    await session("sess_own", { fleet: "team-a" }, "accept");
    await session("sess_other", { fleet: "team-b" }, "accept");
    const wide = await capture(() => cmdSend(["--all", "go", "--all-fleets"]));
    expect(wide.out.map((l) => JSON.parse(l).session_id)).toEqual(["sess_other", "sess_own"]);
    const asB = await capture(() => cmdSend(["--all", "go", "--fleet", "team-b"]));
    expect(asB.out.map((l) => JSON.parse(l).session_id)).toEqual(["sess_other"]);
  });

  it("an empty view exits 2 and names the live sessions hidden in other fleets", async () => {
    await session("sess_other", { fleet: "team-b" }, "accept");
    const r = await capture(() => cmdSend(["--all", "go"]));
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err).toBe("no live sessions in view (1 live in other fleets; --all-fleets broadcasts to them)");
    await fs.rm(path.join(home, "sessions"), { recursive: true, force: true });
    const none = await capture(() => cmdSend(["--all", "go"]));
    expect(none.code).toBe(2);
    expect(none.err).toBe("no live sessions in view");
  });

  it("usage errors exit 2 before any socket is touched", async () => {
    expect((await capture(() => cmdSend(["--all"]))).code).toBe(2);
    expect((await capture(() => cmdSend(["--all", "x", "--fleet"]))).code).toBe(2);
  });

  it("the single-session form still works end-to-end", async () => {
    await session("sess_other", { fleet: "team-b" }, "accept");
    const r = await capture(() => cmdSend(["sess_other", "hello"]));
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['{"turn_id":"turn_5"}']);
  });
});
