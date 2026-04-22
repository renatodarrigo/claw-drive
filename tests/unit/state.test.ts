import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readState, writeState, isPidAlive, type SessionState } from "../../src/lib/state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claw-drive-state-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("state", () => {
  it("writeState + readState round-trips", async () => {
    const file = path.join(tmpDir, "state.json");
    const s: SessionState = {
      session_id: "sess_abc",
      status: "ready",
      cwd: "/tmp/x",
      policy: "bypass",
      decision_timeout_seconds: 300,
      model: null,
      runner_pid: 12345,
      started_at: "2026-04-21T12:00:00Z",
      last_event_at: null,
      turns: 0,
      exit_code: null,
      exit_reason: null,
    };
    await writeState(file, s);
    const loaded = await readState(file);
    expect(loaded).toEqual(s);
  });

  it("readState returns null for missing file", async () => {
    expect(await readState(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("writeState is atomic (no truncated file mid-crash)", async () => {
    const file = path.join(tmpDir, "state.json");
    await writeState(file, {
      session_id: "sess_abc",
      status: "ready",
      cwd: "/tmp",
      policy: "bypass",
      decision_timeout_seconds: 300,
      model: null,
      runner_pid: 1,
      started_at: "t",
      last_event_at: null,
      turns: 0,
      exit_code: null,
      exit_reason: null,
    });
    const raw = await fs.readFile(file, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("isPidAlive(current) is true", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("isPidAlive(invalid) is false", () => {
    expect(isPidAlive(999999999)).toBe(false);
  });

  it("isPidAlive(0) is false", () => {
    expect(isPidAlive(0)).toBe(false);
  });
});
