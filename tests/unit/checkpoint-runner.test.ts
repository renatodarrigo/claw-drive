import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performCheckpoint, armCheckpointTimer, handleRequest, type RunnerContext } from "../../src/runner/runner.js";
import { createBudgetTracker } from "../../src/runner/budget.js";
import type { SessionState } from "../../src/lib/state.js";
import { writeState } from "../../src/lib/state.js";
import { appendEvent, readEventsSince, type Event } from "../../src/lib/events.js";
import { eventsPath, statePath, sessionDir, crashHandoverPath } from "../../src/lib/paths.js";

const SID = "sess_checkpoint01";

let root: string;
let stubDir: string | undefined;
let prevHome: string | undefined;
let prevClawHome: string | undefined;
let prevPath: string | undefined;

// Monomorphic wrapper so ReturnType below infers the concrete spy type
// vi.spyOn(process, "exit") actually produces (a bare `ReturnType<typeof
// vi.spyOn>` on the overloaded function itself resolves to a generic,
// incompatible fallback signature — TS2322 on assignment).
function spyOnExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
}
let exitSpy: ReturnType<typeof spyOnExit> | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd-checkpoint-"));
  prevHome = process.env.HOME;
  process.env.HOME = root;
  prevClawHome = process.env.CLAW_DRIVE_HOME;
  process.env.CLAW_DRIVE_HOME = root;
  await fs.mkdir(sessionDir(SID), { recursive: true });
  // The breaker path ends in process.exit; never let it kill the worker.
  exitSpy = spyOnExit();
});

afterEach(async () => {
  exitSpy?.mockRestore();
  exitSpy = undefined;
  if (prevPath !== undefined) { process.env.PATH = prevPath; prevPath = undefined; }
  process.env.HOME = prevHome;
  if (prevClawHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevClawHome;
  await fs.rm(root, { recursive: true, force: true });
  stubDir = undefined;
});

async function installClaudeStub(script: string): Promise<void> {
  stubDir = path.join(root, "stub-bin");
  await fs.mkdir(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, "claude");
  await fs.writeFile(stubPath, script, { mode: 0o755 });
  prevPath = process.env.PATH;
  process.env.PATH = `${stubDir}${path.delimiter}${prevPath ?? ""}`;
}

const GOOD_STUB =
  "#!/bin/sh\ncat > /dev/null\nprintf '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.2,\"result\":\"<handover>CHECKPOINT BODY</handover>\"}'\n";

function baseState(extra: Partial<SessionState> = {}): SessionState {
  return {
    session_id: SID, status: "running", cwd: "/tmp", policy: { checkpoint: { interval_seconds: 60 } },
    decision_timeout_seconds: 3600, model: null, runner_pid: 1, started_at: new Date().toISOString(),
    last_event_at: null, turns: 1, exit_code: null, exit_reason: null, original_brief: "the mission",
    ...extra,
  } as SessionState;
}

function makeCtx(state: SessionState): RunnerContext {
  // Teardown-safe minimal ctx: the at-cap test's checkpoint_written emit runs
  // the REAL budget breaker (enforceBudget -> teardownSession), so b must be
  // stubbed and the Maps must exist. process.exit is stubbed in beforeEach.
  return {
    sessionId: SID, state, seq: 0, lastCostUsd: null, currentTurnId: null,
    b: { pid: 424242, kill: () => true, on: () => {}, once: () => {} },
    pendingApprovals: new Map(), deferredCalls: new Map(), turnWaiters: new Map(),
    rotationSettled: null,
    budget: createBudgetTracker(state.policy !== "bypass" ? state.policy.budget : undefined),
    budgetBreached: false, stopping: false, tearingDown: false, bExited: false,
    checkpointTimer: null, checkpointInFlight: false, lastCheckpointedSeq: 0, checkpointEpoch: 0,
  } as unknown as RunnerContext;
}

async function seedTurnEvents(): Promise<void> {
  await appendEvent(eventsPath(SID), { seq: 1, at: "t1", kind: "session_started", cwd: "/tmp", policy_digest: "p" } as Event);
  await appendEvent(eventsPath(SID), { seq: 2, at: "t2", turn_id: "turn_1", kind: "turn_started", message: "go" } as Event);
  await appendEvent(eventsPath(SID), { seq: 3, at: "t3", turn_id: "turn_1", kind: "assistant_text", text: "done" } as Event);
}

async function kinds(): Promise<string[]> {
  const { events } = await readEventsSince(eventsPath(SID), 0);
  return events.map((e) => e.kind);
}

/** Drain real macrotasks until `cond` holds. The at-cap test's
 * checkpoint_written emit runs the REAL budget breaker
 * (enforceBudget -> teardownSession), whose finish() continuation is
 * fire-and-forget by design (same as every other cap-crossing event in the
 * runner — this drain-until-condition helper has the same shape as
 * cost-cap-runner.test.ts's settleUntil, which drains a different condition
 * there). Without draining, this test races that continuation:
 * process.exit(0) can land after this test's own afterEach has already
 * restored the real process.exit, turning a passing assertion into an
 * unhandled rejection. */
async function settleUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached while settling");
    await new Promise((r) => setImmediate(r));
  }
}

describe("performCheckpoint", () => {
  it("writes the handover, meters cost, advances the seq mark, and emits checkpoint_written", async () => {
    await installClaudeStub(GOOD_STUB);
    const state = baseState({ cost_usd_base: 1.0 });
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    const ctx = makeCtx(state);
    ctx.seq = 3;
    await performCheckpoint(ctx);
    expect(await fs.readFile(crashHandoverPath(SID), "utf-8")).toBe("CHECKPOINT BODY");
    expect(ctx.lastCheckpointedSeq).toBe(3);
    expect(state.cost_usd_base).toBeCloseTo(1.2);
    expect(state.cost_usd).toBeCloseTo(1.2); // lastCostUsd null → base only
    const { events } = await readEventsSince(eventsPath(SID), 3);
    const written = events.find((e) => e.kind === "checkpoint_written") as Extract<Event, { kind: "checkpoint_written" }>;
    expect(written).toBeDefined();
    expect(written.handover_path).toBe(crashHandoverPath(SID));
    expect(written.distill_cost_usd).toBeCloseTo(0.2);
    expect(written.cost_usd).toBeCloseTo(1.2);
  });

  it("passes checkpoint.model to the distiller argv", async () => {
    const argsFile = path.join(root, "distill-argv.txt");
    await installClaudeStub(`#!/bin/sh\nprintf '%s ' "$@" > "${argsFile}"\ncat > /dev/null\nprintf '{"type":"result","result":"<handover>MODELED</handover>"}'\n`);
    const state = baseState({ policy: { checkpoint: { interval_seconds: 60, model: "haiku" } } });
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    const ctx = makeCtx(state);
    ctx.seq = 3;
    await performCheckpoint(ctx);
    expect(await fs.readFile(argsFile, "utf-8")).toContain("--model haiku");
  });

  it("emits checkpoint_written without distill_cost_usd when the envelope reports no cost", async () => {
    await installClaudeStub("#!/bin/sh\ncat > /dev/null\nprintf '{\"type\":\"result\",\"result\":\"<handover>NO COST</handover>\"}'\n");
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    const ctx = makeCtx(state);
    ctx.seq = 3;
    await performCheckpoint(ctx);
    const { events } = await readEventsSince(eventsPath(SID), 3);
    const written = events.find((e) => e.kind === "checkpoint_written");
    expect(written).toBeDefined();
    expect(written).not.toHaveProperty("distill_cost_usd");
    expect(ctx.state.cost_usd_base).toBeUndefined(); // nothing metered
  });

  it("quiet guard: lifecycle-only traffic since the last checkpoint is a silent skip", async () => {
    await installClaudeStub(GOOD_STUB);
    const state = baseState();
    await writeState(statePath(SID), state);
    await appendEvent(eventsPath(SID), { seq: 1, at: "t1", kind: "session_started", cwd: "/tmp", policy_digest: "p" } as Event);
    const ctx = makeCtx(state);
    ctx.seq = 1;
    await performCheckpoint(ctx);
    await expect(fs.readFile(crashHandoverPath(SID), "utf-8")).rejects.toThrow();
    expect(await kinds()).toEqual(["session_started"]); // no events emitted
  });

  it("quiet guard: a second run with no new digestible events skips; new traffic re-enables", async () => {
    await installClaudeStub(GOOD_STUB);
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    const ctx = makeCtx(state);
    ctx.seq = 3;
    await performCheckpoint(ctx);
    const afterFirst = (await kinds()).filter((k) => k === "checkpoint_written").length;
    await performCheckpoint(ctx); // nothing new → skip
    expect((await kinds()).filter((k) => k === "checkpoint_written").length).toBe(afterFirst);
    await appendEvent(eventsPath(SID), { seq: ctx.seq + 1, at: "t9", turn_id: "turn_2", kind: "turn_started", message: "more" } as Event);
    ctx.seq += 1;
    await performCheckpoint(ctx);
    expect((await kinds()).filter((k) => k === "checkpoint_written").length).toBe(afterFirst + 1);
  });

  it("budget gate: over the cap skips silently before any read or spend", async () => {
    await installClaudeStub(GOOD_STUB);
    // Consistent seed: total = base (lastCostUsd null), just past the cap.
    const over = baseState({ cost_usd: 5.01, cost_usd_base: 5.01, policy: { checkpoint: { interval_seconds: 60 }, budget: { max_cost_usd: 5 } } });
    await writeState(statePath(SID), over);
    await seedTurnEvents();
    const ctxOver = makeCtx(over);
    ctxOver.seq = 3;
    await performCheckpoint(ctxOver);
    await expect(fs.readFile(crashHandoverPath(SID), "utf-8")).rejects.toThrow();
    expect(await kinds()).not.toContain("checkpoint_written");
  });

  it("at exactly the cap the checkpoint runs (strict-exceed), and its crossing engages the breaker AFTER the attribution event", async () => {
    await installClaudeStub(GOOD_STUB);
    const at = baseState({ cost_usd: 5, cost_usd_base: 5, policy: { checkpoint: { interval_seconds: 60 }, budget: { max_cost_usd: 5 } } });
    await writeState(statePath(SID), at);
    await seedTurnEvents();
    const ctx = makeCtx(at);
    ctx.seq = 3;
    await performCheckpoint(ctx);
    expect(await fs.readFile(crashHandoverPath(SID), "utf-8")).toBe("CHECKPOINT BODY");
    expect(at.cost_usd).toBeCloseTo(5.2); // metered past the cap, honestly
    // The breach's teardown (finish()) is fire-and-forget from enforceBudget;
    // let it fully settle (through session_stopped and its own process.exit
    // call against the still-installed spy) before reading events back.
    await settleUntil(() => (exitSpy?.mock.calls.length ?? 0) > 0);
    // Ordering pin: the crossing is recorded first, then the breaker acts —
    // checkpoint_written precedes the budget error and the terminal event.
    const ks = await kinds();
    const iWritten = ks.indexOf("checkpoint_written");
    const iError = ks.indexOf("error");
    const iStopped = ks.indexOf("session_stopped");
    expect(iWritten).toBeGreaterThanOrEqual(0);
    expect(iError).toBeGreaterThan(iWritten);
    expect(iStopped).toBeGreaterThan(iError);
    expect(ctx.budgetBreached).toBe(true);
  });

  it("failure: distiller null emits checkpoint_failed and preserves the previous file", async () => {
    await installClaudeStub("#!/bin/sh\ncat > /dev/null\nprintf 'not json'\n");
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    await fs.writeFile(crashHandoverPath(SID), "PREVIOUS CHECKPOINT");
    const ctx = makeCtx(state);
    ctx.seq = 3;
    await performCheckpoint(ctx);
    expect(await fs.readFile(crashHandoverPath(SID), "utf-8")).toBe("PREVIOUS CHECKPOINT");
    expect(await kinds()).toContain("checkpoint_failed");
    expect(ctx.lastCheckpointedSeq).toBe(0); // failed run does not advance the mark
  });

  it("failure: an internal throw is swallowed but logged via console.error", async () => {
    await installClaudeStub(GOOD_STUB);
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    // A directory at the handover path makes the try's fs.writeFile throw
    // (EISDIR), driving the best-effort catch.
    await fs.mkdir(crashHandoverPath(SID), { recursive: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = makeCtx(state);
      ctx.seq = 3;
      await performCheckpoint(ctx); // must not throw
      expect(spy).toHaveBeenCalledWith("checkpoint failed:", expect.anything());
      expect(ctx.checkpointInFlight).toBe(false); // finally still releases the flag
      const ks = await kinds();
      expect(ks).not.toContain("checkpoint_written"); // deliberately log-only —
      expect(ks).not.toContain("checkpoint_failed"); // no emit from inside the catch
    } finally {
      spy.mockRestore();
    }
  });

  it("in-flight and lifecycle gates: inFlight/stopping/tearingDown/bExited all skip before reading", async () => {
    await installClaudeStub(GOOD_STUB);
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    for (const patch of [{ checkpointInFlight: true }, { stopping: true }, { tearingDown: true }, { bExited: true }]) {
      // Spread, not Object.assign: TS's inference of Object.assign(T, U) for
      // an un-annotated 4-way union U resolves to `never` here (isolated,
      // reproduced outside this file); a spread with the identical operands
      // type-checks cleanly and is behaviorally identical (makeCtx(state) is
      // a fresh object each iteration, never aliased elsewhere).
      const ctx = { ...makeCtx(state), ...patch };
      ctx.seq = 3;
      await performCheckpoint(ctx);
      await expect(fs.readFile(crashHandoverPath(SID), "utf-8")).rejects.toThrow();
    }
  });

  it("stale settle: a distill finishing after bExited discards its result (crash path owns the file)", async () => {
    await installClaudeStub("#!/bin/sh\ncat > /dev/null\nsleep 0.3\nprintf '{\"type\":\"result\",\"result\":\"<handover>STALE</handover>\",\"total_cost_usd\":0.2}'\n");
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    const ctx = makeCtx(state);
    ctx.seq = 3;
    const p = performCheckpoint(ctx);
    setTimeout(() => { ctx.bExited = true; }, 50);
    await p;
    await expect(fs.readFile(crashHandoverPath(SID), "utf-8")).rejects.toThrow();
    expect((await kinds()).some((k) => k === "checkpoint_written" || k === "checkpoint_failed")).toBe(false);
    expect(ctx.checkpointInFlight).toBe(false); // flag released even on discard
  });

  it("stale settle: an epoch bump mid-distill (checkpoint policy changed) discards the result", async () => {
    await installClaudeStub("#!/bin/sh\ncat > /dev/null\nsleep 0.3\nprintf '{\"type\":\"result\",\"result\":\"<handover>STALE</handover>\",\"total_cost_usd\":0.2}'\n");
    const state = baseState();
    await writeState(statePath(SID), state);
    await seedTurnEvents();
    const ctx = makeCtx(state);
    ctx.seq = 3;
    const p = performCheckpoint(ctx);
    setTimeout(() => { ctx.checkpointEpoch += 1; }, 50);
    await p;
    await expect(fs.readFile(crashHandoverPath(SID), "utf-8")).rejects.toThrow();
    expect((await kinds()).some((k) => k === "checkpoint_written" || k === "checkpoint_failed")).toBe(false);
    expect(ctx.lastCheckpointedSeq).toBe(0); // a discarded settle does not advance the mark
    expect(ctx.checkpointInFlight).toBe(false);
  });
});

describe("armCheckpointTimer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("no checkpoint block → no timer", () => {
    const ctx = makeCtx(baseState({ policy: {} }));
    const run = vi.fn(async () => {});
    armCheckpointTimer(ctx, run);
    expect(ctx.checkpointTimer).toBeNull();
    vi.advanceTimersByTime(3_600_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("the recurring timer is unref'd so it cannot hold the process open (real timers — fake ones don't model hasRef)", () => {
    vi.useRealTimers();
    const ctx = makeCtx(baseState());
    const run = vi.fn(async () => {});
    armCheckpointTimer(ctx, run);
    expect(ctx.checkpointTimer).not.toBeNull();
    expect(ctx.checkpointTimer!.hasRef()).toBe(false);
    clearInterval(ctx.checkpointTimer!);
  });

  it("fires at t=interval (not t=0) and on every interval after", () => {
    const ctx = makeCtx(baseState()); // interval_seconds: 60
    const run = vi.fn(async () => {});
    armCheckpointTimer(ctx, run);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("re-arm replaces the old timer (no double firing) and disarm-by-config stops it", () => {
    const ctx = makeCtx(baseState());
    const run = vi.fn(async () => {});
    armCheckpointTimer(ctx, run);
    ctx.state.policy = { checkpoint: { interval_seconds: 120 } };
    armCheckpointTimer(ctx, run); // re-arm under the new interval
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled(); // old 60s cadence is gone
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    ctx.state.policy = {};
    armCheckpointTimer(ctx, run); // block removed → disarm
    expect(ctx.checkpointTimer).toBeNull();
    vi.advanceTimersByTime(600_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("update_policy: only a CHANGED checkpoint block re-arms the timer, bumps the epoch once, and a byte-identical update leaves both alone", async () => {
    const state = baseState({ policy: {} });
    await writeState(statePath(SID), state);
    const ctx = makeCtx(state);
    expect(ctx.checkpointTimer).toBeNull();
    const epoch0 = ctx.checkpointEpoch;

    const added = await handleRequest(ctx, {
      id: "p1",
      op: "update_policy",
      policy: { checkpoint: { interval_seconds: 60 } },
    });
    expect(added).toMatchObject({ ok: true });
    expect(ctx.checkpointTimer).not.toBeNull();
    expect(ctx.checkpointEpoch).toBe(epoch0 + 1);

    const epochAfterAdd = ctx.checkpointEpoch;
    const same = await handleRequest(ctx, {
      id: "p2",
      op: "update_policy",
      policy: { checkpoint: { interval_seconds: 60 } },
    });
    expect(same).toMatchObject({ ok: true });
    expect(ctx.checkpointEpoch).toBe(epochAfterAdd); // byte-identical → cadence untouched

    const removed = await handleRequest(ctx, {
      id: "p3",
      op: "update_policy",
      policy: {},
    });
    expect(removed).toMatchObject({ ok: true });
    expect(ctx.checkpointTimer).toBeNull();
  });
});
