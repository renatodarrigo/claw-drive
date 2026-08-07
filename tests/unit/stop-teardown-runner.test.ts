import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { handleRequest, makeSignalHandler, observeBExit, teardownSession, type RunnerContext } from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";
import { readEventsSince } from "../../src/lib/events.js";
import { eventsPath } from "../../src/lib/paths.js";

// A2 hardening (July orphaned runners; SIGTERM wedge): the teardown path must
// escalate SIGTERM→SIGKILL against an unresponsive B, and must short-circuit
// — no timers, no waiting on an exit event that already fired — when B is
// already dead. Fake timers cover the ladder; real fs under a synthetic
// CLAW_DRIVE_HOME records the terminal state.

const SID = "sess_stoptear01";

let root: string;
let prevHome: string | undefined;
let exitCalls: Array<number | undefined>;
let processKills: Array<[number, string | number]>;

interface FakeB {
  emitter: EventEmitter;
  stdinEnds: number;
  b: ChildProcess & { exitCode: number | null; signalCode: string | null };
}

function makeFakeB(): FakeB {
  const emitter = new EventEmitter();
  const fake: FakeB = {
    emitter,
    stdinEnds: 0,
    b: null as never,
  };
  fake.b = {
    pid: 424242,
    exitCode: null,
    signalCode: null,
    stdin: {
      write: () => true,
      end: () => {
        fake.stdinEnds += 1;
      },
    },
    kill: () => true,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
  } as unknown as FakeB["b"];
  return fake;
}

async function makeCtx(fake: FakeB): Promise<RunnerContext> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "events.jsonl"), "");
  const state: SessionState = {
    session_id: SID,
    status: "running",
    cwd: "/tmp/x",
    policy: { rotation: { threshold_tokens: 100_000 } },
    decision_timeout_seconds: 3600,
    model: null,
    runner_pid: process.pid,
    started_at: new Date().toISOString(),
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
  };
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
  return {
    sessionId: SID,
    state,
    b: fake.b,
    currentTurnId: null,
    seq: 1,
    pendingApprovals: new Map(),
    deferredCalls: new Map(),
    stopping: false,
    budget: null,
    budgetBreached: false,
    lastContextTokens: null,
    completedTurns: 0,
    turnInFlight: false,
    firstTurnContextTokens: null,
    rotating: false,
    turnWaiters: new Map(),
    bExited: false,
    crashTeardownEngaged: false,
    tearingDown: false,
    lastInterruptAt: null,
    rotationSettled: null,
  } as RunnerContext;
}

/** Let real (non-faked) macrotasks — setImmediate, fs callbacks — drain. */
async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Drain real macrotasks until `cond` holds. Time-bounded via Date.now — the
 * fs threadpool can lag arbitrarily under parallel suites, so counting yield
 * rounds alone flakes. Timers are faked, so no setTimeout in here. */
async function settleUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached while settling");
    await new Promise((r) => setImmediate(r));
  }
}

async function eventKinds(): Promise<string[]> {
  const { events } = await readEventsSince(eventsPath(SID), 0);
  return events.map((e) => e.kind);
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "stoptear-"));
  process.env.CLAW_DRIVE_HOME = root;
  exitCalls = [];
  processKills = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code);
  }) as never);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
    processKills.push([pid, sig ?? "SIGTERM"]);
    return true;
  }) as never);
  // Only the clock is faked — setImmediate and fs callbacks stay real so
  // teardown's async fs work can drain via settle().
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("stop_session teardown", () => {
  it("escalates SIGTERM at 10s and SIGKILL at 20s against an unresponsive B, then finishes on exit", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const resp = await handleRequest(ctx, { id: "s1", op: "stop_session" });
    expect(resp).toMatchObject({ ok: true });
    await settle();
    expect(fake.stdinEnds).toBe(1);
    expect(processKills).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(processKills).toEqual([[424242, "SIGTERM"]]);
    vi.advanceTimersByTime(10_000);
    expect(processKills).toEqual([
      [424242, "SIGTERM"],
      [424242, "SIGKILL"],
    ]);
    fake.b.exitCode = 137;
    fake.emitter.emit("exit", 137, null);
    await settleUntil(() => exitCalls.length > 0);
    const kinds = await eventKinds();
    expect(kinds).toContain("session_stopped");
    expect(ctx.state.status).toBe("stopped");
    expect(ctx.state.exit_code).toBe(137);
    expect(exitCalls).toEqual([0]);
  });

  it("defers to the crash teardown when B already exited through it (no timers, no second record)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    (ctx as { bExited?: boolean }).bExited = true;
    (ctx as { crashTeardownEngaged?: boolean }).crashTeardownEngaged = true;
    fake.b.exitCode = 0;
    const resp = await handleRequest(ctx, { id: "s1", op: "stop_session" });
    expect(resp).toMatchObject({ ok: true });
    await settle();
    vi.advanceTimersByTime(30_000);
    expect(processKills).toHaveLength(0);
    expect(fake.stdinEnds).toBe(0);
    const kinds = await eventKinds();
    expect(kinds).not.toContain("session_stopped");
    expect(exitCalls).toEqual([]);
  });

  it("writes the terminal record immediately when B is dead but the crash path never ran", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    // B exited on the same tick the stop landed: exitCode is set, but no
    // "exit" event will ever be observed by a listener registered now.
    fake.b.exitCode = 0;
    await handleRequest(ctx, { id: "s1", op: "stop_session" });
    await settleUntil(() => exitCalls.length > 0);
    const kinds = await eventKinds();
    expect(kinds).toContain("session_stopped");
    expect(ctx.state.status).toBe("stopped");
    expect(exitCalls).toEqual([0]);
    vi.advanceTimersByTime(30_000);
    expect(processKills).toHaveLength(0);
  });

  it("a stop whose deferred teardown finds B already dead and latched still writes the terminal record (no wedge)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    // Interleaving: stop_session set stopping and queued its teardown; B died
    // in that gap, so the exit handler latched bExited and returned early on
    // stopping — the crash path never engaged. The queued teardown must still
    // terminal-record via the dead-B fast path.
    ctx.stopping = true;
    observeBExit(ctx);
    fake.b.exitCode = 0;
    teardownSession(ctx, "stop_session");
    await settleUntil(() => exitCalls.length > 0);
    expect(await eventKinds()).toContain("session_stopped");
    expect(exitCalls).toEqual([0]);
  });
});

describe("makeSignalHandler (runner SIGTERM/SIGINT)", () => {
  it("first signal engages graceful teardown and stamps exit_reason", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const onTerm = makeSignalHandler(ctx, "SIGTERM");
    onTerm();
    expect(ctx.state.exit_reason).toBe("runner_sigterm");
    expect(ctx.stopping).toBe(true);
    await settle();
    expect(fake.stdinEnds).toBe(1);
    expect(exitCalls).toEqual([]);
  });

  it("second signal force-exits (operator override of a hung teardown)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const onTerm = makeSignalHandler(ctx, "SIGTERM");
    onTerm();
    await settle();
    onTerm();
    expect(exitCalls).toEqual([1]);
  });

  it("a signal during the crash teardown defers to it, then force-exits on the second", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    (ctx as { bExited?: boolean }).bExited = true;
    (ctx as { crashTeardownEngaged?: boolean }).crashTeardownEngaged = true;
    fake.b.exitCode = 0;
    // The crash path already stamped the truthful reason; the signal must
    // not clobber it (COMPATIBILITY: "the recorded reason stays crashed:*").
    ctx.state.exit_reason = "crashed:0";
    const onTerm = makeSignalHandler(ctx, "SIGTERM");
    onTerm();
    expect(ctx.state.exit_reason).toBe("crashed:0");
    await settle();
    expect(fake.stdinEnds).toBe(0);
    expect(exitCalls).toEqual([]);
    onTerm();
    expect(exitCalls).toEqual([1]);
  });
});

describe("observeBExit (B-exit invariant)", () => {
  it("latches bExited and fails every pending turn waiter; idempotent", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const outcomes: string[] = [];
    ctx.turnWaiters.set("turn_1", (o) => outcomes.push(o));
    ctx.turnWaiters.set("turn_2", (o) => outcomes.push(o));
    observeBExit(ctx);
    expect(ctx.bExited).toBe(true);
    expect(outcomes).toEqual(["failed", "failed"]);
    expect(ctx.turnWaiters.size).toBe(0);
    observeBExit(ctx);
    expect(outcomes).toEqual(["failed", "failed"]);
  });
});

describe("teardown finish holds for an in-flight rotation", () => {
  it("writes the terminal record only after rotationSettled settles (outcome-before-terminal on the stop path)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    let settleRotation!: () => void;
    ctx.rotationSettled = new Promise<void>((r) => (settleRotation = r));
    ctx.rotating = true;
    await handleRequest(ctx, { id: "s1", op: "stop_session" });
    await settle();
    fake.b.exitCode = 0;
    fake.emitter.emit("exit", 0, null);
    await settle();
    expect(await eventKinds()).not.toContain("session_stopped");
    expect(exitCalls).toEqual([]);
    settleRotation();
    await settleUntil(() => exitCalls.length > 0);
    expect(await eventKinds()).toContain("session_stopped");
    expect(exitCalls).toEqual([0]);
  });

  it("the hold is bounded: the terminal record proceeds after 30s even if the rotation never settles", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.rotationSettled = new Promise<void>(() => {});
    ctx.rotating = true;
    await handleRequest(ctx, { id: "s1", op: "stop_session" });
    await settle();
    fake.b.exitCode = 0;
    fake.emitter.emit("exit", 0, null);
    await settle();
    expect(exitCalls).toEqual([]);
    vi.advanceTimersByTime(30_000);
    await settleUntil(() => exitCalls.length > 0);
    expect(await eventKinds()).toContain("session_stopped");
  });
});
