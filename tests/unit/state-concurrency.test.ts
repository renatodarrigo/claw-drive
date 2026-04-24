import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readState, writeState, type SessionState } from "../../src/lib/state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claw-drive-state-concurrent-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function baseState(turns: number): SessionState {
  return {
    session_id: "sess_abc",
    status: "ready",
    cwd: "/tmp",
    policy: "bypass",
    decision_timeout_seconds: 300,
    model: null,
    runner_pid: process.pid,
    started_at: "2026-04-24T00:00:00Z",
    last_event_at: null,
    turns,
    exit_code: null,
    exit_reason: null,
  };
}

describe("writeState concurrency", () => {
  it("serialises 100 concurrent writes against the same path without error", async () => {
    const file = path.join(tmpDir, "state.json");
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(writeState(file, baseState(i)));
    }
    await Promise.all(promises);
  });

  it("final on-disk state reflects the last submitted write", async () => {
    const file = path.join(tmpDir, "state.json");
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(writeState(file, baseState(i)));
    }
    await Promise.all(promises);
    const loaded = await readState(file);
    expect(loaded?.turns).toBe(99);
  });

  it("survives 10 sequential bursts of 100 concurrent writes", async () => {
    const file = path.join(tmpDir, "state.json");
    for (let burst = 0; burst < 10; burst++) {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(writeState(file, baseState(burst * 100 + i)));
      }
      await Promise.all(promises);
    }
    const loaded = await readState(file);
    expect(loaded?.turns).toBe(999);
  });

  it("concurrent writes to two DIFFERENT paths do not block each other", async () => {
    const fileA = path.join(tmpDir, "stateA.json");
    const fileB = path.join(tmpDir, "stateB.json");
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(writeState(fileA, baseState(i)));
      promises.push(writeState(fileB, baseState(i + 1000)));
    }
    await Promise.all(promises);
    const a = await readState(fileA);
    const b = await readState(fileB);
    expect(a?.turns).toBe(49);
    expect(b?.turns).toBe(1049);
  });
});
