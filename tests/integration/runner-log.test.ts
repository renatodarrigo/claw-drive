import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// CD-45: the runner is spawned standalone as `node dist/runner/runner.js <id>`
// (the same binary mcp/server.ts spawns detached with stdio:"ignore"). Driving
// it directly against a missing-state session deterministically exercises the
// startup-failure path: runRunner installs the log capture FIRST, then
// readState throws → the standalone entry's "runner fatal:" lands in runner.log
// and nothing leaks to the parent's pipes. This is the ONLY place the
// process.stdout/stderr redirect can be verified — vitest intercepts console.*
// in-process, so the capture/rotation LOGIC is unit-tested via the openRunnerLog
// sink instead. No real claude needed (fast + stable).

const runnerJs = path.resolve("dist/runner/runner.js");

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "cd45-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function runRunnerProc(
  sessionId: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerJs, sessionId], {
      env: { ...process.env, CLAW_DRIVE_HOME: root },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("runner-log capture wiring (integration)", () => {
  it("captures a startup failure into runner.log and leaks nothing to the parent", async () => {
    const sid = "sess_nostate0001";
    const res = await runRunnerProc(sid);

    // capture installed first → readState throws → standalone .catch → exit(1).
    expect(res.code).toBe(1);
    // Everything the runner wrote was redirected to the file; the parent's
    // pipes stay empty (the spawn-site stdio:"ignore" semantics still hold).
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");

    const logPath = path.join(root, "sessions", sid, "runner.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("runner fatal:");
    expect(log).toContain("no state.json");
  }, 20_000);

  it("creates the session dir + runner.log even when neither pre-existed", async () => {
    const sid = "sess_nostate0002";
    expect(fs.existsSync(path.join(root, "sessions", sid))).toBe(false);
    await runRunnerProc(sid);
    expect(fs.existsSync(path.join(root, "sessions", sid, "runner.log"))).toBe(true);
  }, 20_000);
});
