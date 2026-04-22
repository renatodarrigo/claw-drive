import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { appendEvent, readEventsSince, type Event } from "../../src/lib/events.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claw-drive-events-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("events", () => {
  it("appendEvent writes one JSON line", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    await appendEvent(file, {
      seq: 1,
      at: "2026-04-21T12:00:00Z",
      kind: "session_started",
      cwd: "/tmp/x",
      policy_digest: "abc",
    } as Event);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean).length).toBe(1);
    const parsed = JSON.parse(raw.trimEnd());
    expect(parsed.seq).toBe(1);
    expect(parsed.kind).toBe("session_started");
  });

  it("readEventsSince(0) returns all events", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    await appendEvent(file, { seq: 1, at: "2026-04-21T12:00:00Z", kind: "session_started" } as any);
    await appendEvent(file, { seq: 2, at: "2026-04-21T12:00:01Z", turn_id: "turn_1", kind: "turn_started", message: "hi" } as any);
    const { events, nextSince } = await readEventsSince(file, 0);
    expect(events.length).toBe(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
    expect(nextSince).toBe(2);
  });

  it("readEventsSince(1) skips first event", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    await appendEvent(file, { seq: 1, at: "2026-04-21T12:00:00Z", kind: "session_started" } as any);
    await appendEvent(file, { seq: 2, at: "2026-04-21T12:00:01Z", kind: "session_stopped" } as any);
    const { events, nextSince } = await readEventsSince(file, 1);
    expect(events.length).toBe(1);
    expect(events[0].seq).toBe(2);
    expect(nextSince).toBe(2);
  });

  it("readEventsSince on missing file returns empty", async () => {
    const file = path.join(tmpDir, "does-not-exist.jsonl");
    const { events, nextSince } = await readEventsSince(file, 0);
    expect(events).toEqual([]);
    expect(nextSince).toBe(0);
  });

  it("tool_output_provided round-trips", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    await appendEvent(file, {
      seq: 1,
      at: "2026-04-22T00:00:00Z",
      turn_id: "turn_1",
      kind: "tool_output_provided",
      call_id: "toolu_abc",
      stdout_len: 42,
      stderr_len: 0,
      exit_code: 0,
    } as any);
    const { events } = await readEventsSince(file, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_output_provided",
      call_id: "toolu_abc",
      stdout_len: 42,
      exit_code: 0,
    });
  });

  it("readEventsSince tolerates a partial last line (still being written)", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    await appendEvent(file, { seq: 1, at: "t", kind: "session_started" } as any);
    // Simulate a half-written line
    await fs.appendFile(file, '{"seq":2,"at":"t","kind":"turn_s');
    const { events, nextSince } = await readEventsSince(file, 0);
    expect(events.length).toBe(1);
    expect(nextSince).toBe(1);
  });
});
