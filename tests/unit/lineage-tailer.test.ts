import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { startLineageTailer, type LineageTailerOptions } from "../../src/lib/lineage-tailer.js";

let root: string;
let prevHome: string | undefined;

const A = "sess_20200101T000000_aaaaaa";
const B = "sess_20200101T000000_bbbbbb";
const C = "sess_20200101T000000_cccccc";

/** Shared real-clock lag tolerance (crash-teardown-runner convention). */
const REAL_CLOCK_DEADLINE_MS = 5000;

async function waitUntil(cond: () => boolean, ms = REAL_CLOCK_DEADLINE_MS): Promise<void> {
  const dl = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > dl) throw new Error("waitUntil: condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A pid no live process plausibly holds (beyond default pid_max). */
const DEAD_PID = 999_999_999;

async function makeSession(sid: string, state: object, events: object[]): Promise<void> {
  const dir = path.join(root, "sessions", sid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ session_id: sid, ...state })
  );
  await fs.writeFile(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

/** A finished turn; optionally a rotation narration + stop, or no stop at all. */
function turnEvents(): object[] {
  return [
    { seq: 1, at: "t", kind: "turn_started", turn_id: "x", message: "go" },
    { seq: 2, at: "t", kind: "assistant_text", turn_id: "x", text: "done\n[DONE]" },
    { seq: 3, at: "t", kind: "turn_completed", turn_id: "x", stop_reason: "success" },
  ];
}

function rotatedEvents(successor: string): object[] {
  return [
    ...turnEvents(),
    { seq: 4, at: "t", kind: "session_rotated", new_session_id: successor, generation: 2, handover_path: "h", watch_command: "w" },
    { seq: 5, at: "t", kind: "session_stopped", reason: `rotated:${successor}`, exit_code: 0 },
  ];
}

function stoppedEvents(): object[] {
  return [
    ...turnEvents(),
    { seq: 4, at: "t", kind: "session_stopped", reason: "done", exit_code: 0 },
  ];
}

function collectLineage(startId: string, over: Partial<LineageTailerOptions> = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const handle = startLineageTailer({
    sessionId: startId,
    emit: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    filters: { since: 0, allowed: null, noTokenFilter: false, suspectedNeedsInput: true, idleAfterSeconds: 0 },
    pollIntervalMs: 25,
    onWatchError: (m) => errors.push(m),
    ...over,
  });
  return { lines, errors, handle };
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd-lineage-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("startLineageTailer — natural-end walking", () => {
  it("hops a rotation: predecessor lines (tagged) then successor lines (tagged), then done", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, rotated_to: B, generation: 1 }, rotatedEvents(B));
    await makeSession(B, { status: "stopped", runner_pid: null, generation: 2, alias: "rev" }, stoppedEvents());
    const { lines, errors, handle } = collectLineage(A);
    await handle.done;
    expect(errors).toEqual([]);
    const rotated = lines.find((l) => l.kind === "session_rotated");
    // The event's own generation field (the successor's) survives the tag
    // merge — payload fields win over tag fields, the watch --all line shape.
    expect(rotated).toMatchObject({ session_id: A, generation: 2, new_session_id: B });
    const aStop = lines.find((l) => l.kind === "session_stopped" && l.session_id === A);
    // A's stop payload has no generation field, so the tag's survives.
    expect(aStop).toMatchObject({ session_id: A, generation: 1 });
    const bStop = lines.find((l) => l.kind === "session_stopped" && l.session_id === B);
    expect(bStop).toMatchObject({ session_id: B, alias: "rev", generation: 2 });
    const lastA = lines.map((l) => l.session_id).lastIndexOf(A);
    const firstB = lines.map((l) => l.session_id).indexOf(B);
    expect(lastA).toBeLessThan(firstB); // strictly sequential, no interleaving
  });

  it("exits at a clean stop with no successor, every line tagged with the sole member", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, generation: 1 }, stoppedEvents());
    const { lines, errors, handle } = collectLineage(A);
    await handle.done;
    expect(errors).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.session_id).toBe(A);
  });

  it("walks multiple dead ancestors to the lineage end", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, rotated_to: B }, rotatedEvents(B));
    await makeSession(B, { status: "stopped", runner_pid: null, rotated_to: C }, rotatedEvents(C));
    await makeSession(C, { status: "stopped", runner_pid: null, generation: 3 }, stoppedEvents());
    const { lines, handle } = collectLineage(A);
    await handle.done;
    const tags = lines.map((l) => l.session_id);
    expect(tags).toContain(A);
    expect(tags).toContain(B);
    expect(tags).toContain(C);
    expect(tags.lastIndexOf(B)).toBeLessThan(tags.indexOf(C));
  });

  it("successors tail from 'current' unless the walk is a full --replay", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, rotated_to: B }, rotatedEvents(B));
    await makeSession(B, { status: "stopped", runner_pid: null }, stoppedEvents());

    // since 0 (--replay): B's historical turn_completed replays too.
    const replay = collectLineage(A);
    await replay.handle.done;
    expect(replay.lines.some((l) => l.kind === "turn_completed" && l.session_id === B)).toBe(true);

    // since "current" on an already-dead walk: catch-up surfaces stops, not history.
    const current = collectLineage(A, {
      filters: { since: "current", allowed: null, noTokenFilter: false, suspectedNeedsInput: true, idleAfterSeconds: 0 },
    });
    await current.handle.done;
    expect(current.lines.some((l) => l.kind === "turn_completed")).toBe(false);
    expect(current.lines.some((l) => l.kind === "session_stopped" && l.session_id === B)).toBe(true);
  });

  it("--since N binds to the first member only; successors use 'current'", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, rotated_to: B }, rotatedEvents(B));
    await makeSession(B, { status: "stopped", runner_pid: null }, stoppedEvents());
    const { lines, handle } = collectLineage(A, {
      filters: { since: 3, allowed: null, noTokenFilter: false, suspectedNeedsInput: true, idleAfterSeconds: 0 },
    });
    await handle.done;
    // A from seq 3: its session_rotated (seq 4) surfaces.
    expect(lines.some((l) => l.kind === "session_rotated" && l.session_id === A)).toBe(true);
    // B on "current": its historical turn_completed (seq 3) does NOT.
    expect(lines.some((l) => l.kind === "turn_completed" && l.session_id === B)).toBe(false);
    expect(lines.some((l) => l.kind === "session_stopped" && l.session_id === B)).toBe(true);
  });

  it("a member watch error ends the walk loudly, without hopping past it", async () => {
    // A's state names a successor, but A has no events file at all.
    const dir = path.join(root, "sessions", A);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ session_id: A, status: "stopped", runner_pid: null, rotated_to: B }));
    await makeSession(B, { status: "stopped", runner_pid: null }, stoppedEvents());
    const { lines, errors, handle } = collectLineage(A);
    await handle.done;
    expect(errors.length).toBe(1);
    expect(lines.every((l) => l.session_id !== B)).toBe(true);
  });

  it("a hand-edited state cycle ends the walk loudly instead of looping", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, rotated_to: B }, rotatedEvents(B));
    await makeSession(B, { status: "stopped", runner_pid: null, rotated_to: A }, rotatedEvents(A));
    const { lines, errors, handle } = collectLineage(A);
    await handle.done;
    expect(errors.some((m) => m.includes("lineage cycle"))).toBe(true);
    // Each member tailed exactly once.
    expect(lines.filter((l) => l.kind === "session_stopped" && l.session_id === A).length).toBe(1);
    expect(lines.filter((l) => l.kind === "session_stopped" && l.session_id === B).length).toBe(1);
  });

  it("close() mid-walk resolves done without hopping further", async () => {
    await makeSession(A, { status: "stopped", runner_pid: null, rotated_to: B }, rotatedEvents(B));
    // B is live-ish: no stop event, alive pid — its tailer would wait forever.
    await makeSession(B, { status: "running", runner_pid: process.pid }, turnEvents());
    const { lines, handle } = collectLineage(A);
    await waitUntil(() => lines.some((l) => l.session_id === B && l.kind === "turn_completed"));
    handle.close();
    await handle.done;
  });
});

describe("startLineageTailer — recover hops (state poll)", () => {
  it("hops when a crashed member is recovered mid-watch", async () => {
    // A crashed: dead pid, no session_stopped ever, no successor yet.
    await makeSession(A, { status: "running", runner_pid: DEAD_PID, generation: 1 }, turnEvents());
    await makeSession(B, { status: "stopped", runner_pid: null, generation: 2 }, stoppedEvents());
    const { lines, errors, handle } = collectLineage(A);
    await waitUntil(() => lines.some((l) => l.session_id === A && l.kind === "turn_completed"));
    // The human runs recover: A's state gains the successor pointer.
    await fs.writeFile(
      path.join(root, "sessions", A, "state.json"),
      JSON.stringify({ session_id: A, status: "running", runner_pid: DEAD_PID, generation: 1, rotated_to: B })
    );
    await waitUntil(() => lines.some((l) => l.session_id === B && l.kind === "session_stopped"));
    await handle.done; // B stops cleanly with no successor: lineage end
    expect(errors).toEqual([]);
  });

  it("a pre-recovered corpse hops on the immediate tick, with its replay intact", async () => {
    await makeSession(A, { status: "running", runner_pid: DEAD_PID, rotated_to: B }, turnEvents());
    await makeSession(B, { status: "stopped", runner_pid: null }, stoppedEvents());
    // A huge interval proves the IMMEDIATE tick does the hop (a 60s first
    // tick would blow the test timeout).
    const { lines, handle } = collectLineage(A, { pollIntervalMs: 60_000 });
    await handle.done;
    // caughtUp gating: A's full replay emitted before the poll closed it.
    expect(lines.some((l) => l.session_id === A && l.kind === "turn_completed")).toBe(true);
    expect(lines.some((l) => l.session_id === B && l.kind === "session_stopped")).toBe(true);
  });

  it("never hops away from a live predecessor holding a dangling successor pointer", async () => {
    await makeSession(A, { status: "running", runner_pid: process.pid, rotated_to: B }, turnEvents());
    await makeSession(B, { status: "stopped", runner_pid: null }, stoppedEvents());
    const { lines, handle } = collectLineage(A);
    await waitUntil(() => lines.some((l) => l.session_id === A && l.kind === "turn_completed"));
    await delay(150); // ~6 poll ticks at 25ms
    expect(lines.some((l) => l.session_id === B)).toBe(false); // poll stayed hands-off
    // The predecessor then stops for real: the natural path hops.
    await fs.appendFile(
      path.join(root, "sessions", A, "events.jsonl"),
      JSON.stringify({ seq: 4, at: "t", kind: "session_stopped", reason: `rotated:${B}`, exit_code: 0 }) + "\n"
    );
    await waitUntil(() => lines.some((l) => l.session_id === B && l.kind === "session_stopped"));
    await handle.done;
  });

  it("a crashed member with no successor waits — close() is the only way out", async () => {
    await makeSession(A, { status: "running", runner_pid: DEAD_PID }, turnEvents());
    const { handle } = collectLineage(A);
    const outcome = await Promise.race([
      handle.done.then(() => "done"),
      delay(150).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
    handle.close();
    await handle.done;
  });
});
