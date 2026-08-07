import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { enforceBudget, afterEventBookkeeping, type RunnerContext } from "../../src/runner/runner.js";
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
  b: ChildProcess;
}

function makeFakeB(): FakeB {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const b = {
    pid: 424242,
    exitCode: null,
    signalCode: null,
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
  return { writes, emitter, b };
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

  it("breach latches exactly once (second event does not re-enter teardown)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.budget = createBudgetTracker({ max_cost_usd: 1.0 });
    ctx.budget.recordCost(2.0);
    await enforceBudget(ctx, turnCompleted("t1"));
    const evsAfterFirst = (await readEventsSince(eventsPath(SID), 0)).events.filter((e) => e.kind === "error").length;
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

describe("cost stamping (afterEventBookkeeping)", () => {
  it("stamps cost_usd = base + latest at turn completion", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { cost_usd_base: 2.0 });
    ctx.lastCostUsd = 0.5;
    await afterEventBookkeeping(ctx, turnCompleted("t1"));
    const persisted = await readState(statePath(SID));
    expect(persisted?.cost_usd).toBeCloseTo(2.5, 10);
  });

  it("stamps base alone when no reading arrived yet; stamps nothing without either", async () => {
    const fakeA = makeFakeB();
    const ctxA = await makeCtx(fakeA, { cost_usd_base: 2.0 });
    await afterEventBookkeeping(ctxA, turnCompleted("t1"));
    expect((await readState(statePath(SID)))?.cost_usd).toBeCloseTo(2.0, 10);

    const fakeB = makeFakeB();
    const ctxB = await makeCtx(fakeB); // fresh gen-1, no base
    await afterEventBookkeeping(ctxB, turnCompleted("t2"));
    expect((await readState(statePath(SID)))?.cost_usd).toBeUndefined();
  });
});
