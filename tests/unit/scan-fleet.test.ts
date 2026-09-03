import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as net from "node:net";
import { resolveCmd } from "../../src/cli/commands/_shared-resolve.js";
import { cmdProvideOutput } from "../../src/cli/commands/provide-output.js";
import { startSocketServer } from "../../src/runner/socket-server.js";
import { sessionDir, statePath, socketPath } from "../../src/lib/paths.js";
import type { ControlRequest, ControlResponse } from "../../src/lib/socket-protocol.js";

// The scans walk live sessions and ask each runner over its control socket.
// A real socket server standing in for a runner (socket-protocol precedent)
// lets the scans run end-to-end; the fleet view decides which sockets are
// even asked.

let home: string;
const servers: net.Server[] = [];
const ENV_KEYS = ["CLAW_DRIVE_HOME", "CLAW_DRIVE_FLEET", "CLAUDE_CODE_SESSION_ID"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

async function liveSession(id: string, over: Record<string, unknown>, holdsCall: string): Promise<void> {
  await fs.mkdir(sessionDir(id), { recursive: true });
  await fs.writeFile(
    statePath(id),
    JSON.stringify({
      session_id: id, status: "running", cwd: "/tmp/x", policy: "bypass",
      decision_timeout_seconds: 3600, model: null, runner_pid: process.pid,
      started_at: "2026-09-02T00:00:00Z", last_event_at: null, turns: 1,
      exit_code: null, exit_reason: null, ...over,
    })
  );
  const handler = async (req: ControlRequest): Promise<ControlResponse> => {
    const callId = (req as { call_id?: string }).call_id;
    if (req.op === "resolve_tool_call") {
      return callId === holdsCall
        ? { id: req.id, ok: true, result: { ok: true } }
        : { id: req.id, ok: false, error: "NOT_PENDING", message: "no such call" };
    }
    if (req.op === "provide_tool_output") {
      return callId === holdsCall
        ? { id: req.id, ok: true, result: { turn_id: "turn_2" } }
        : { id: req.id, ok: false, error: "CALL_NOT_FOUND", message: "no such call" };
    }
    return { id: req.id, ok: false, error: "UNKNOWN_OP", message: req.op };
  };
  servers.push(await startSocketServer(socketPath(id), handler));
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await fn();
    return { code, out: log.mock.calls.map((c) => c.join(" ")).join("\n"), err: errSpy.mock.calls.map((c) => c.join(" ")).join("\n") };
  } finally {
    log.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd-scan-fleet-"));
  process.env.CLAW_DRIVE_HOME = home;
  process.env.CLAW_DRIVE_FLEET = "team-a";
  delete process.env.CLAUDE_CODE_SESSION_ID;
  await liveSession("sess_other", { fleet: "team-b" }, "call_in_other");
  await liveSession("sess_own", { fleet: "team-a" }, "call_in_own");
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("approve/reject/defer scan — fleet view", () => {
  it("finds a call held in the own fleet", async () => {
    const r = await capture(() => resolveCmd("approve", ["call_in_own"]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ session_id: "sess_own", ok: true });
  });

  it("does not see a call held in another fleet unless --all-fleets is passed", async () => {
    const hidden = await capture(() => resolveCmd("approve", ["call_in_other"]));
    expect(hidden.code).toBe(1);
    expect(hidden.err).toBe("call_id not found in any live session");
    const widened = await capture(() => resolveCmd("approve", ["call_in_other", "--all-fleets"]));
    expect(widened.code).toBe(0);
    expect(JSON.parse(widened.out)).toEqual({ session_id: "sess_other", ok: true });
  });

  it("--fleet team-b acts as that fleet; a fleet-flag error exits 2 before any scan", async () => {
    const r = await capture(() => resolveCmd("reject", ["call_in_other", "--fleet", "team-b"]));
    expect(r.code).toBe(0);
    expect((await capture(() => resolveCmd("reject", ["call_in_other", "--fleet", "a b"]))).code).toBe(2);
  });
});

describe("provide-output scan — fleet view", () => {
  it("delivers to the own fleet and ignores another fleet's call unless widened", async () => {
    const own = await capture(() => cmdProvideOutput(["call_in_own", "--stdout", "hi", "--exit", "0"]));
    expect(own.code).toBe(0);
    expect(JSON.parse(own.out)).toEqual({ session_id: "sess_own", ok: true, result: { turn_id: "turn_2" } });
    const hidden = await capture(() => cmdProvideOutput(["call_in_other", "--stdout", "hi"]));
    expect(hidden.code).toBe(1);
    expect(hidden.err).toBe("call_id not found in any live session (deferred or pending)");
    const widened = await capture(() => cmdProvideOutput(["call_in_other", "--stdout", "hi", "--all-fleets"]));
    expect(widened.code).toBe(0);
    expect(JSON.parse(widened.out).session_id).toBe("sess_other");
  });
});
