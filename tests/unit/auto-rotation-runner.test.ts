import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  afterEventBookkeeping,
  runStdoutLoop,
  handleRequest,
  type RunnerContext,
} from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";
import { readEventsSince } from "../../src/lib/events.js";
import type { Event } from "../../src/lib/events.js";
import { eventsPath, handoverPath, statePath, sessionDir } from "../../src/lib/paths.js";
import { readState } from "../../src/lib/state.js";

const SID = "sess_autorot001";

let root: string;
let stubDir: string;
let prevHome: string | undefined;
let prevPath: string | undefined;
let prevBin: string | undefined;
let exitCalls: Array<number | undefined>;

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
  // Stamp the exit like a real ChildProcess (exitCode is set by the time
  // 'exit' fires): a test may emit B's exit before the post-rotation
  // teardown's setImmediate has registered its once-listener, and only the
  // stamped exitCode lets that teardown's dead-B early path observe it.
  emitter.on("exit", (code: number | null, signal: string | null) => {
    (b as { exitCode: number | null }).exitCode = code;
    (b as { signalCode: string | null }).signalCode = signal ?? null;
  });
  return { writes, emitter, stdout, b };
}

/** Drain real macrotasks until `cond` holds (Date.now-bounded; timers are faked). */
async function settleUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached while settling");
    await new Promise((r) => setImmediate(r));
  }
}

/** A fixed number of macrotask drains, for asserting that nothing happened. */
async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** settleUntil for conditions that must read a file (async predicates). */
async function settleUntilAsync(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not reached while settling");
    await new Promise((r) => setImmediate(r));
  }
}

const resultLine = (cost: number): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost }) + "\n";

/** A main-loop assistant line whose usage yields the given context reading. */
const assistantWithUsage = (tokens: number): string =>
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [], usage: { input_tokens: tokens } },
  }) + "\n";

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

/** Complete the next handover attempt: wait for its waiter, optionally plant
 * the handover block, then resolve the turn — observed-output all the way. */
async function completeHandoverTurn(ctx: RunnerContext, turnId: string, withHandover: boolean): Promise<void> {
  await settleUntil(() => ctx.turnWaiters.has(turnId));
  if (withHandover) await appendAssistantHandover(turnId);
  const waiter = ctx.turnWaiters.get(turnId)!;
  ctx.turnWaiters.delete(turnId);
  waiter("completed");
}

async function makeCtx(fake: FakeB, statePatch?: Partial<SessionState>): Promise<RunnerContext> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "events.jsonl"), "");
  const state: SessionState = {
    session_id: SID,
    status: "running",
    cwd: "/tmp/x",
    policy: { rotation: { threshold_tokens: 1000, mode: "auto" } },
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
    checkpointTimer: null,
    checkpointInFlight: false,
    lastCheckpointedSeq: 0,
    checkpointEpoch: 0,
  } satisfies RunnerContext;
}

async function events(): Promise<Event[]> {
  return (await readEventsSince(eventsPath(SID), 0)).events;
}

function ofKind(evs: Event[], kind: string): Array<Record<string, unknown>> {
  return evs.filter((e) => e.kind === kind) as unknown as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  prevPath = process.env.PATH;
  prevBin = process.env.CLAW_DRIVE_BIN;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "autorot-"));
  process.env.CLAW_DRIVE_HOME = root;
  stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorot-stub-"));
  const stub = path.join(stubDir, "claude");
  await fs.writeFile(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.chmod(stub, 0o755);
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  process.env.CLAW_DRIVE_BIN = "/bin/false";
  exitCalls = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code);
  }) as never);
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

describe("rotation outcomes carry their initiator", () => {
  it("a commanded rotate's refusal is stamped initiated_by manual", async () => {
    const fake = makeFakeB();
    // First completed turn already over threshold → BOOTSTRAP refusal, no
    // handover turn involved (the cap's checkpoint path is exercised in the
    // max_generations test below).
    const ctx = await makeCtx(fake, { policy: { rotation: { threshold_tokens: 1000, mode: "manual" } } });
    ctx.firstTurnContextTokens = 5000;
    const resp = await handleRequest(ctx, { id: "r1", op: "rotate" });
    expect(resp).toMatchObject({ ok: false, error: "BOOTSTRAP_EXCEEDS_THRESHOLD" });
    const refused = ofKind(await events(), "rotation_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].initiated_by).toBe("manual");
  });

  it("a commanded rotate's success is stamped initiated_by manual", async () => {
    vi.useRealTimers();
    const stubRunner = path.join(stubDir, "fake-runner");
    await fs.writeFile(stubRunner, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', { mode: 0o755 });
    await fs.chmod(stubRunner, 0o755);
    process.env.CLAW_DRIVE_BIN = stubRunner;
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: { rotation: { threshold_tokens: 1000, mode: "manual" } } });
    const rotP = handleRequest(ctx, { id: "r1", op: "rotate" });
    await completeHandoverTurn(ctx, "turn_1", true);
    const resp = await rotP;
    expect(resp).toMatchObject({ ok: true });
    const rotated = ofKind(await events(), "session_rotated");
    expect(rotated).toHaveLength(1);
    expect(rotated[0].initiated_by).toBe("manual");
    fake.emitter.emit("exit", 0, null);
    await settleUntil(() => exitCalls.length > 0);
  });

  it("a provide_tool_output racing the handover is refused; the rotation completes unperturbed", async () => {
    vi.useRealTimers();
    const stubRunner = path.join(stubDir, "fake-runner");
    await fs.writeFile(stubRunner, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', { mode: 0o755 });
    await fs.chmod(stubRunner, 0o755);
    process.env.CLAW_DRIVE_BIN = stubRunner;
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: { rotation: { threshold_tokens: 1000, mode: "manual" } } });
    // A deferred call from before the rotation — the survives-into-rotation case.
    ctx.deferredCalls.set("toolu_d1", {
      call_id: "toolu_d1",
      turn_id: "turn_0",
      tool: "Bash",
      args: { command: "echo hi" },
      deferred_at: new Date().toISOString(),
      reason: "human will run this manually",
    });
    const rotP = handleRequest(ctx, { id: "r1", op: "rotate" });
    await settleUntil(() => ctx.rotating);
    const provided = await handleRequest(ctx, {
      id: "p1",
      op: "provide_tool_output",
      call_id: "toolu_d1",
      stdout: "output from the human",
    });
    expect(provided).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    await completeHandoverTurn(ctx, "turn_1", true);
    const resp = await rotP;
    expect(resp).toMatchObject({ ok: true });
    expect(ofKind(await events(), "session_rotated")).toHaveLength(1);
    // Exactly one stdin write ever happened: the sanctioned handover send.
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).not.toContain("toolu_d1");
    // The record survived the refusal untouched.
    expect(ctx.deferredCalls.has("toolu_d1")).toBe(true);
    fake.emitter.emit("exit", 0, null);
    await settleUntil(() => exitCalls.length > 0);
  });
});

const turnCompleted = (id: string): Event =>
  ({ seq: 0, at: new Date().toISOString(), kind: "turn_completed", turn_id: id, stop_reason: "success" } as Event);

/** Simulate a completed-turn boundary at the given context reading. */
async function boundary(ctx: RunnerContext, turnId: string, tokens: number): Promise<void> {
  ctx.lastContextTokens = tokens;
  await afterEventBookkeeping(ctx, turnCompleted(turnId));
}

describe("auto-rotation trigger", () => {
  it("rotates at the crossing boundary: threshold event first, then session_rotated initiated_by auto, exactly once", async () => {
    vi.useRealTimers();
    const stubRunner = path.join(stubDir, "fake-runner");
    await fs.writeFile(stubRunner, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', { mode: 0o755 });
    await fs.chmod(stubRunner, 0o755);
    process.env.CLAW_DRIVE_BIN = stubRunner;
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const loop = runStdoutLoop(ctx);
    const sendResp = await handleRequest(ctx, { id: "s1", op: "send_turn", message: "go" });
    expect(sendResp).toMatchObject({ ok: true, result: { turn_id: "turn_1" } });
    // Under threshold on the first turn (the bootstrap gate must not trip),
    // over on the second: crossing happens at turn_2's boundary.
    fake.stdout.write(assistantWithUsage(500) + resultLine(0.01));
    await settleUntil(() => ctx.completedTurns === 1);
    const send2 = await handleRequest(ctx, { id: "s2", op: "send_turn", message: "more" });
    expect(send2).toMatchObject({ ok: true, result: { turn_id: "turn_2" } });
    fake.stdout.write(assistantWithUsage(5000) + resultLine(0.02));
    // Handover turn is turn_3 (state.turns numbering). Complete it with a
    // handover block; the choreography then scaffolds the successor.
    await completeHandoverTurn(ctx, "turn_3", true);
    // The lineage pointer is written before session_rotated is appended, so
    // the observed condition is the event itself, on disk.
    await settleUntilAsync(async () => ofKind(await events(), "session_rotated").length > 0);
    const evs = await events();
    const rotated = ofKind(evs, "session_rotated");
    expect(rotated).toHaveLength(1);
    expect(rotated[0].initiated_by).toBe("auto");
    const idxThreshold = evs.findIndex((e) => e.kind === "context_threshold_reached");
    const idxRotated = evs.findIndex((e) => e.kind === "session_rotated");
    expect(idxThreshold).toBeGreaterThanOrEqual(0);
    expect(idxThreshold).toBeLessThan(idxRotated);
    expect((await readState(statePath(SID)))?.rotated_to).toBe(rotated[0].new_session_id);
    fake.stdout.end();
    await loop;
    fake.emitter.emit("exit", 0, null);
    await settleUntil(() => exitCalls.length > 0);
  });

  it("manual mode never auto-rotates: over-threshold boundaries emit threshold events only", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { policy: { rotation: { threshold_tokens: 1000, mode: "manual" } } });
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    await boundary(ctx, "t3", 6000);
    await settle();
    const evs = await events();
    expect(ofKind(evs, "context_threshold_reached")).toHaveLength(2);
    expect(ofKind(evs, "session_rotated")).toHaveLength(0);
    expect(ofKind(evs, "rotation_refused")).toHaveLength(0);
    expect(ofKind(evs, "rotation_failed")).toHaveLength(0);
    expect(ctx.rotating).toBe(false);
  });

  it("a send that wins the boundary race defers the attempt silently; the next boundary retries", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    // The attempt is queued behind setImmediate; a send that lands first
    // (synchronously marking the turn in flight) must make it a no-op.
    ctx.turnInFlight = true;
    await settle();
    let evs = await events();
    expect(ofKind(evs, "rotation_refused")).toHaveLength(0);
    expect(ofKind(evs, "rotation_failed")).toHaveLength(0);
    expect(ofKind(evs, "session_rotated")).toHaveLength(0);
    expect(ctx.autoRotateLatched).toBe(false);
    // The racing turn completes: the next boundary retries the attempt —
    // observed here through the rotation starting (its handover turn opens).
    ctx.turnInFlight = false;
    await boundary(ctx, "t3", 5000);
    await settleUntil(() => ctx.rotating);
    // Close the attempt deterministically: two handover tries, no handover
    // block → rotation_failed (exercised in depth below).
    await completeHandoverTurn(ctx, "turn_1", false);
    await completeHandoverTurn(ctx, "turn_2", false);
    await settleUntil(() => !ctx.rotating);
    evs = await events();
    expect(ofKind(evs, "rotation_failed")).toHaveLength(1);
  });
});

describe("auto-rotation latch", () => {
  it("bootstrap refusal fires once and latches; threshold events keep re-firing", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    await boundary(ctx, "t1", 5000); // FIRST completed turn over threshold
    await settleUntil(() => !ctx.rotating && ctx.autoRotateLatched);
    await boundary(ctx, "t2", 6000);
    await boundary(ctx, "t3", 7000);
    await settle();
    const evs = await events();
    const refused = ofKind(evs, "rotation_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBe("bootstrap_exceeds_threshold");
    expect(refused[0].initiated_by).toBe("auto");
    expect(ofKind(evs, "context_threshold_reached")).toHaveLength(3);
    expect(ofKind(evs, "session_rotated")).toHaveLength(0);
  });

  it("max_generations refusal runs the terminal-handover checkpoint once, then latches", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { generation: 10 });
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    // The cap's refusal choreography runs a real handover turn (turn_1 by
    // state.turns numbering — no send_turn ever bumped it here).
    await completeHandoverTurn(ctx, "turn_1", true);
    await settleUntil(() => !ctx.rotating && ctx.autoRotateLatched);
    await boundary(ctx, "t3", 6000);
    await settle();
    const evs = await events();
    const refused = ofKind(evs, "rotation_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBe("max_generations");
    expect(refused[0].initiated_by).toBe("auto");
    const handover = await fs.readFile(handoverPath(SID), "utf-8");
    expect(handover).toContain("state for the successor");
    expect(ofKind(evs, "session_rotated")).toHaveLength(0);
  });

  it("a failed rotation latches: handover-generation failure fires once, later boundaries stay quiet", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    await completeHandoverTurn(ctx, "turn_1", false);
    await completeHandoverTurn(ctx, "turn_2", false);
    await settleUntil(() => !ctx.rotating && ctx.autoRotateLatched);
    await boundary(ctx, "t3", 6000);
    await settle();
    const evs = await events();
    const failed = ofKind(evs, "rotation_failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0].reason)).toContain("handover_generation_failed");
    expect(failed[0].initiated_by).toBe("auto");
  });

  it("update_policy re-arms the latch iff the rotation block changes", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.autoRotateLatched = true;
    // Byte-identical rotation block → still latched.
    const same = await handleRequest(ctx, {
      id: "p1",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 1000, mode: "auto" } },
    });
    expect(same).toMatchObject({ ok: true });
    expect(ctx.autoRotateLatched).toBe(true);
    // Changed threshold → re-armed.
    const changed = await handleRequest(ctx, {
      id: "p2",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 200000, mode: "auto" } },
    });
    expect(changed).toMatchObject({ ok: true });
    expect(ctx.autoRotateLatched).toBe(false);
  });

  it("a crashed attempt (its own refusal emit throws) latches instead of leaking an unhandled rejection", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    await boundary(ctx, "t1", 5000); // FIRST completed turn over threshold —
    // queues the bootstrap-refusal attempt via setImmediate, not yet run:
    // boundary's own await chain has fully unwound by the time this line
    // runs, but the queued immediate only fires on the event loop's next
    // check phase, after this synchronous continuation finishes.
    rmSync(sessionDir(SID), { recursive: true, force: true });
    // performRotation's own rotation_refused emit now throws ENOENT (its
    // events.jsonl directory is gone) instead of completing. Observing the
    // latch land — rather than settleUntil timing out — is the proof the
    // dispatch chain's .catch, not just its .then, is wired: without it the
    // rejection would go unhandled and neither this assertion nor the test
    // process itself would survive to check it.
    await settleUntil(() => ctx.autoRotateLatched);
    expect(ctx.rotating).toBe(false);
  });
});

describe("policy-epoch guard on the latch", () => {
  // The MAX_GENERATIONS refusal choreography runs a real handover turn, so
  // the attempt window stays open until completeHandoverTurn — wide enough
  // to land an update_policy inside it deterministically.

  it("a rotation-block update mid-attempt keeps the stale refusal from latching; the next attempt latches under the new config", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { generation: 10 });
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    // Once rotating is observable, the dispatch has already captured its
    // epoch (both happen in the same synchronous segment).
    await settleUntil(() => ctx.rotating);
    const upd = await handleRequest(ctx, {
      id: "p1",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 2000, mode: "auto" } },
    });
    expect(upd).toMatchObject({ ok: true });
    await completeHandoverTurn(ctx, "turn_1", true);
    await settleUntil(() => !ctx.rotating);
    await settle();
    expect(ctx.autoRotateLatched).toBe(false); // stale-epoch outcome must not latch
    expect(ofKind(await events(), "rotation_refused")).toHaveLength(1);
    // The re-armed attempt runs under the NEW config at the next boundary —
    // still MAX_GENERATIONS, and THIS outcome (fresh epoch) latches.
    await boundary(ctx, "t3", 6000);
    await completeHandoverTurn(ctx, "turn_2", true);
    await settleUntil(() => ctx.autoRotateLatched);
    expect(ofKind(await events(), "rotation_refused")).toHaveLength(2);
  });

  it("a rotation-block update mid-attempt keeps a crashed attempt from latching (.catch path)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { generation: 10 });
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    await settleUntil(() => ctx.rotating);
    const upd = await handleRequest(ctx, {
      id: "p1",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 2000, mode: "auto" } },
    });
    expect(upd).toMatchObject({ ok: true });
    // Crash the attempt instead of letting it refuse cleanly: with the
    // session dir gone, readEventsSince tolerates the missing file (no
    // handover extracted) but attempt 2's turn_started emit throws ENOENT,
    // so performRotation rejects — the .catch path. The existing crashed-
    // attempt test pins that this machinery latches WITHOUT an update; this
    // pins that a stale epoch suppresses it.
    rmSync(sessionDir(SID), { recursive: true, force: true });
    await completeHandoverTurn(ctx, "turn_1", false);
    await settleUntil(() => !ctx.rotating);
    await settle();
    expect(ctx.autoRotateLatched).toBe(false);
  });

  it("an unrelated policy update mid-attempt does not disturb the latch (epoch bumps only on rotation-block change)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { generation: 10 });
    await boundary(ctx, "t1", 500);
    await boundary(ctx, "t2", 5000);
    await settleUntil(() => ctx.rotating);
    const upd = await handleRequest(ctx, {
      id: "p1",
      op: "update_policy",
      policy: { rotation: { threshold_tokens: 1000, mode: "auto" }, budget: { warn_cost_usd: 5 } },
    });
    expect(upd).toMatchObject({ ok: true });
    await completeHandoverTurn(ctx, "turn_1", true);
    // Rotation block byte-identical → no bump → the refusal latches normally.
    await settleUntil(() => ctx.autoRotateLatched);
    expect(ofKind(await events(), "rotation_refused")).toHaveLength(1);
  });
});
