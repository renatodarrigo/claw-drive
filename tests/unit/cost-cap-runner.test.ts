import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { enforceBudget, afterEventBookkeeping, runStdoutLoop, handleRequest, type RunnerContext } from "../../src/runner/runner.js";
import { createBudgetTracker } from "../../src/runner/budget.js";
import type { SessionState } from "../../src/lib/state.js";
import { readEventsSince } from "../../src/lib/events.js";
import { eventsPath, statePath } from "../../src/lib/paths.js";
import { readState } from "../../src/lib/state.js";
import type { Event } from "../../src/lib/events.js";

const SID = "sess_costcap001";

let root: string;
let stubDir: string;
let prevHome: string | undefined;
let prevPath: string | undefined;
let prevBin: string | undefined;
let exitCalls: Array<number | undefined>;
let processKills: Array<[number, string | number]>;

interface FakeB {
  writes: string[];
  emitter: EventEmitter;
  stdout: PassThrough;
  b: ChildProcess;
}

function makeFakeB(): FakeB {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const stdout = new PassThrough();
  const b = {
    pid: 424242,
    exitCode: null,
    signalCode: null,
    stdout,
    stdin: {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => {},
    },
    kill: () => true,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
  } as unknown as ChildProcess;
  return { writes, emitter, stdout, b };
}

/** Let real (non-faked) macrotasks — setImmediate, fs callbacks — drain. */
async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Drain real macrotasks until `cond` holds (Date.now-bounded; timers are faked). */
async function settleUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached while settling");
    await new Promise((r) => setImmediate(r));
  }
}

const resultLine = (cost: number, opts?: { error?: boolean }): string =>
  JSON.stringify(
    opts?.error
      ? { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: cost }
      : { type: "result", subtype: "success", is_error: false, total_cost_usd: cost }
  ) + "\n";

async function appendAssistantHandover(turnId: string): Promise<void> {
  const line = JSON.stringify({
    seq: 90,
    at: new Date().toISOString(),
    kind: "assistant_text",
    turn_id: turnId,
    text: "<handover>state for the successor</handover>",
  });
  await fs.appendFile(eventsPath(SID), line + "\n");
}

async function makeCtx(fake: FakeB, statePatch?: Partial<SessionState>): Promise<RunnerContext> {
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
    ...statePatch,
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
    lastCostUsd: null,
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
    rotationSendId: null,
    autoRotateLatched: false,
    costWarned: false,
    rotationPolicyEpoch: 0,
  } satisfies RunnerContext;
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  prevPath = process.env.PATH;
  prevBin = process.env.CLAW_DRIVE_BIN;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "costcap-"));
  process.env.CLAW_DRIVE_HOME = root;
  // Distiller stub: the crash path spawns `claude -p` best-effort; a stub that
  // exits silently makes that path fast and token-free.
  stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "costcap-stub-"));
  const stub = path.join(stubDir, "claude");
  await fs.writeFile(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.chmod(stub, 0o755);
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  // Successor spawns must never launch a real runner from a unit test.
  process.env.CLAW_DRIVE_BIN = "/bin/false";
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
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  if (prevBin === undefined) delete process.env.CLAW_DRIVE_BIN;
  else process.env.CLAW_DRIVE_BIN = prevBin;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(stubDir, { recursive: true, force: true });
});

const turnCompleted = (id: string): Event =>
  ({ seq: 0, at: new Date().toISOString(), kind: "turn_completed", turn_id: id, stop_reason: "success" } as Event);

describe("cost-cap breach (enforceBudget)", () => {
  it("breaches when the lineage total exceeds max_cost_usd: latch + exit_reason + error event + teardown", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.budget = createBudgetTracker({ max_cost_usd: 1.0 });
    ctx.budget.recordCost(1.25);
    await enforceBudget(ctx, turnCompleted("t1"));
    expect(ctx.budgetBreached).toBe(true);
    expect(ctx.state.exit_reason).toBe("budget_exceeded:max_cost_usd");
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    const err = evs.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toContain("max_cost_usd");
    expect(ctx.tearingDown).toBe(true);
  });

  it("no reading, no trip: an unpriced stream can never breach the cost cap", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.budget = createBudgetTracker({ max_cost_usd: 0.01 });
    // no recordCost at all — counter stays 0
    await enforceBudget(ctx, turnCompleted("t1"));
    expect(ctx.budgetBreached).toBe(false);
    expect(ctx.tearingDown).toBe(false);
  });

  it("breach latches exactly once, independent of ctx.stopping (second event does not re-enter teardown)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.budget = createBudgetTracker({ max_cost_usd: 1.0 });
    ctx.budget.recordCost(2.0);
    await enforceBudget(ctx, turnCompleted("t1"));
    const evsAfterFirst = (await readEventsSince(eventsPath(SID), 0)).events.filter((e) => e.kind === "error").length;
    expect(evsAfterFirst).toBe(1); // exactly one breach action emitted
    // teardownSession (called by the first breach) also sets ctx.stopping,
    // which is its OWN independent no-op guard on enforceBudget. Clear it so
    // the second call's no-op is attributable ONLY to the budgetBreached
    // latch this test means to pin — otherwise ctx.stopping alone would
    // satisfy the assertion below even if the latch itself were broken.
    ctx.stopping = false;
    await enforceBudget(ctx, turnCompleted("t2"));
    const evsAfterSecond = (await readEventsSince(eventsPath(SID), 0)).events.filter((e) => e.kind === "error").length;
    expect(evsAfterSecond).toBe(evsAfterFirst);
  });

  it("a breach during the rotate choreography still latches through the shared path (rotating does not suppress the breaker)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.rotating = true;
    ctx.budget = createBudgetTracker({ max_cost_usd: 1.0 });
    ctx.budget.recordCost(1.5);
    await enforceBudget(ctx, turnCompleted("handover_turn"));
    expect(ctx.budgetBreached).toBe(true);
    expect(ctx.state.exit_reason).toBe("budget_exceeded:max_cost_usd");
    // Teardown ordering vs. rotationSettled is pinned by the existing
    // crash/stop teardown suites — the breach rides teardownSession itself.
  });
});

describe("cost stamping at the source (runStdoutLoop)", () => {
  it("stamps cost_usd = base + reading on a success result line, persisted by the same line's events", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { cost_usd_base: 2.0 });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(0.5));
    fake.stdout.end();
    await loop;
    expect(ctx.state.cost_usd).toBeCloseTo(2.5, 10);
    expect((await readState(statePath(SID)))?.cost_usd).toBeCloseTo(2.5, 10);
  });

  it("a FAILED turn's result line still stamps — error results carry cost", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(0.75, { error: true }));
    fake.stdout.end();
    await loop;
    expect(ctx.state.cost_usd).toBeCloseTo(0.75, 10);
    expect((await readState(statePath(SID)))?.cost_usd).toBeCloseTo(0.75, 10);
  });

  it("afterEventBookkeeping no longer stamps cost (single stamping site)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { cost_usd_base: 2.0 });
    ctx.lastCostUsd = 0.5;
    await afterEventBookkeeping(ctx, turnCompleted("t1"));
    expect(ctx.state.cost_usd).toBeUndefined(); // in-memory: no unpersisted set either
    expect((await readState(statePath(SID)))?.cost_usd).toBeUndefined();
  });
});

describe("breach on the handover turn's own result line", () => {
  it("aborts the rotation at the checkpoint before any successor exists", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.budget = createBudgetTracker({ max_cost_usd: 1.0 });
    const loop = runStdoutLoop(ctx);
    const rotP = handleRequest(ctx, { id: "r1", op: "rotate" });
    await settleUntil(() => ctx.turnWaiters.has("turn_1"));
    await appendAssistantHandover("turn_1");
    fake.stdout.write(resultLine(1.5));
    fake.stdout.end();
    await loop;
    const resp = await rotP;
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
    expect(ctx.state.exit_reason).toBe("budget_exceeded:max_cost_usd");
    expect(ctx.state.cost_usd).toBeCloseTo(1.5, 10);
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    const rf = evs.find((e) => e.kind === "rotation_failed");
    expect(rf).toBeDefined();
    expect((rf as unknown as { reason: string }).reason).toBe(
      "session_stopping: stop or circuit breaker engaged after the handover turn; successor not started"
    );
    const dirs = await fs.readdir(path.join(root, "sessions"));
    expect(dirs).toEqual([SID]);
  });
});

describe("cost carried across the rotation handoff", () => {
  // Real timers: the successor spawn is a real child process, and the
  // handoff's readiness wait polls the ready marker on a real 50ms timer.
  // Stub runner: touching the ready marker is all the handoff waits for.
  let fake: FakeB;
  beforeEach(async () => {
    vi.useRealTimers();
    const stubRunner = path.join(stubDir, "fake-runner");
    await fs.writeFile(stubRunner, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', {
      mode: 0o755,
    });
    await fs.chmod(stubRunner, 0o755);
    process.env.CLAW_DRIVE_BIN = stubRunner;
    fake = makeFakeB();
  });

  it("hands the inherited base to the successor when no reading of its own was ever stamped", async () => {
    // A session dir written before successors were born carrying cost_usd: it
    // holds the base it inherited and nothing else, and no priced result line
    // during the handover turn ever stamps a cost_usd of its own.
    const ctx = await makeCtx(fake, { cost_usd_base: 2.5 });
    expect(ctx.state.cost_usd).toBeUndefined();
    const rotP = handleRequest(ctx, { id: "r1", op: "rotate" });
    await settleUntil(() => ctx.turnWaiters.has("turn_1"));
    await appendAssistantHandover("turn_1");
    const waiter = ctx.turnWaiters.get("turn_1")!;
    ctx.turnWaiters.delete("turn_1");
    waiter("completed");
    const resp = await rotP;
    expect(resp).toMatchObject({ ok: true });
    const newId = (resp as { result: { new_session_id: string } }).result.new_session_id;
    const succ = await readState(statePath(newId));
    expect(succ?.cost_usd_base).toBeCloseTo(2.5, 10);
    expect(succ?.cost_usd).toBeCloseTo(2.5, 10);
    // Selected, never summed: the predecessor's own state is untouched.
    expect(ctx.state.cost_usd).toBeUndefined();
    expect(ctx.state.cost_usd_base).toBeCloseTo(2.5, 10);
    // Let the predecessor's deferred self-teardown run to completion.
    fake.emitter.emit("exit", 0, null);
    await settleUntil(() => exitCalls.length > 0);
  });

  it("prefers the predecessor's own cost_usd over its inherited base", async () => {
    const ctx = await makeCtx(fake, { cost_usd_base: 2.5, cost_usd: 4.0 });
    const rotP = handleRequest(ctx, { id: "r1", op: "rotate" });
    await settleUntil(() => ctx.turnWaiters.has("turn_1"));
    await appendAssistantHandover("turn_1");
    const waiter = ctx.turnWaiters.get("turn_1")!;
    ctx.turnWaiters.delete("turn_1");
    waiter("completed");
    const resp = await rotP;
    expect(resp).toMatchObject({ ok: true });
    const newId = (resp as { result: { new_session_id: string } }).result.new_session_id;
    const succ = await readState(statePath(newId));
    expect(succ?.cost_usd_base).toBeCloseTo(4.0, 10);
    fake.emitter.emit("exit", 0, null);
    await settleUntil(() => exitCalls.length > 0);
  });

  it("omits the successor's base when the predecessor carried neither field", async () => {
    const ctx = await makeCtx(fake);
    const rotP = handleRequest(ctx, { id: "r1", op: "rotate" });
    await settleUntil(() => ctx.turnWaiters.has("turn_1"));
    await appendAssistantHandover("turn_1");
    const waiter = ctx.turnWaiters.get("turn_1")!;
    ctx.turnWaiters.delete("turn_1");
    waiter("completed");
    const resp = await rotP;
    expect(resp).toMatchObject({ ok: true });
    const newId = (resp as { result: { new_session_id: string } }).result.new_session_id;
    const succ = await readState(statePath(newId));
    expect(succ?.cost_usd_base).toBeUndefined();
    expect(succ?.cost_usd).toBeUndefined();
    fake.emitter.emit("exit", 0, null);
    await settleUntil(() => exitCalls.length > 0);
  });
});

describe("enforcement-site base term (lineage total = base + reading)", () => {
  it("breaches when the inherited base pushes an under-cap reading over the cap", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { cost_usd_base: 4.0 });
    ctx.budget = createBudgetTracker({ max_cost_usd: 5.0 });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(1.5));
    fake.stdout.end();
    await loop;
    expect(ctx.budgetBreached).toBe(true);
    expect(ctx.state.exit_reason).toBe("budget_exceeded:max_cost_usd");
    expect(ctx.state.cost_usd).toBeCloseTo(5.5, 10);
  });
});

describe("cost_threshold_reached warning", () => {
  const warnPolicy = {
    rotation: { threshold_tokens: 100_000 },
    budget: { warn_cost_usd: 1.0, max_cost_usd: 5.0 },
  };

  it("fires at the crossing completed-turn boundary with the full payload", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: warnPolicy, generation: 3 });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(1.25));
    fake.stdout.end();
    await loop;
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    const warns = evs.filter((e) => e.kind === "cost_threshold_reached") as unknown as Array<Record<string, unknown>>;
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      cost_usd: 1.25,
      warn_cost_usd: 1.0,
      generation: 3,
      max_cost_usd: 5.0,
    });
    // Emitted AFTER the boundary event it rode in on.
    const idxTurn = evs.findIndex((e) => e.kind === "turn_completed");
    const idxWarn = evs.findIndex((e) => e.kind === "cost_threshold_reached");
    expect(idxTurn).toBeGreaterThanOrEqual(0);
    expect(idxWarn).toBeGreaterThan(idxTurn);
  });

  it("fires on a FAILED turn's boundary — error results carry cost", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: warnPolicy });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(1.5, { error: true }));
    fake.stdout.end();
    await loop;
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    expect(evs.filter((e) => e.kind === "cost_threshold_reached")).toHaveLength(1);
    expect(evs.find((e) => e.kind === "turn_failed")).toBeDefined();
  });

  it("fires once per runner process: staying above re-fires nothing", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: warnPolicy });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(1.25));
    fake.stdout.write(resultLine(1.5));
    fake.stdout.write(resultLine(2.0));
    fake.stdout.end();
    await loop;
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    expect(evs.filter((e) => e.kind === "cost_threshold_reached")).toHaveLength(1);
  });

  it("update_policy re-arms iff warn_cost_usd changes", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: warnPolicy });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(1.25));
    fake.stdout.end();
    await loop;
    // Same warn value → still warned; changed warn value → re-armed.
    const same = await handleRequest(ctx, {
      id: "p1",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 100_000 }, budget: { warn_cost_usd: 1.0, max_cost_usd: 5.0 } },
    });
    expect(same).toMatchObject({ ok: true });
    expect(ctx.costWarned).toBe(true);
    const changed = await handleRequest(ctx, {
      id: "p2",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 100_000 }, budget: { warn_cost_usd: 2.0, max_cost_usd: 5.0 } },
    });
    expect(changed).toMatchObject({ ok: true });
    expect(ctx.costWarned).toBe(false);
  });

  it("omits max_cost_usd from the payload when no cap is configured, and stays silent when warn is unconfigured", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: { rotation: { threshold_tokens: 100_000 }, budget: { warn_cost_usd: 1.0 } } });
    const loop = runStdoutLoop(ctx);
    fake.stdout.write(resultLine(1.25));
    fake.stdout.end();
    await loop;
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    const warn = evs.find((e) => e.kind === "cost_threshold_reached") as unknown as Record<string, unknown>;
    expect(warn).toBeDefined();
    expect("max_cost_usd" in warn).toBe(false);

    // A policy with no budget at all never warns (makeCtx starts a fresh
    // events file, so any warning here would be this stream's own).
    const fake2 = makeFakeB();
    const ctx2 = await makeCtx(fake2);
    const loop2 = runStdoutLoop(ctx2);
    fake2.stdout.write(resultLine(99));
    fake2.stdout.end();
    await loop2;
    const evs2 = (await readEventsSince(eventsPath(SID), 0)).events;
    expect(evs2.filter((e) => e.kind === "cost_threshold_reached")).toHaveLength(0);
  });
});
