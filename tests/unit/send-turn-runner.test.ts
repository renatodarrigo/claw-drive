import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  handleRequest,
  observeBExit,
  attachBStdinErrorAbsorber,
  afterEventBookkeeping,
  type RunnerContext,
} from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";
import { readEventsSince, type Event } from "../../src/lib/events.js";
import { eventsPath } from "../../src/lib/paths.js";
import { readFileSync } from "node:fs";
import { composeOutputMessage } from "../../src/runner/output-message.js";
import { HOOK_DELIVERY_MAX_BYTES, HOOK_DELIVERY_WINDOW_MS } from "../../src/lib/spawn-session.js";

// v1.4.1 ledger finding: send_turn (and provide_tool_output, which pipes a
// turn to B the same way) never checked whether B had already exited before
// emitting turn_started and writing to B's stdin — a phantom turn_started for
// a turn that can never run, plus a write on a closed pipe. rotate's own
// dead-B gate (runner.ts ~776-790) is the mirrored convention: key on
// ctx.bExited alone, refuse before any other work, plain error + no event.

const SID = "sess_sendturn001";

let root: string;
let prevHome: string | undefined;

interface FakeB {
  writes: string[];
  b: ChildProcess;
  /** The emitter backing b.stdin's on/once/listenerCount — exposed so tests
   * can attach the absorber via fake.b and then drive/inspect it directly
   * (emit("error", ...), listenerCount("error")) without reaching back
   * through the ChildProcess-shaped stdin stub. */
  stdin: EventEmitter;
}

function makeFakeB(): FakeB {
  const emitter = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  const writes: string[] = [];
  const stdin = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
    on: stdinEmitter.on.bind(stdinEmitter),
    once: stdinEmitter.once.bind(stdinEmitter),
    listenerCount: stdinEmitter.listenerCount.bind(stdinEmitter),
  };
  const b = {
    pid: 424242,
    exitCode: null,
    signalCode: null,
    stdin,
    kill: () => true,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
  } as unknown as ChildProcess;
  return { writes, b, stdin: stdinEmitter };
}

async function makeCtx(fake: FakeB, overrides?: Partial<RunnerContext>): Promise<RunnerContext> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "events.jsonl"), "");
  const state: SessionState = {
    session_id: SID,
    status: "running",
    cwd: "/tmp/x",
    policy: "bypass",
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
  const base = {
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
  return { ...base, ...overrides };
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sendturn-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

async function eventKinds(): Promise<string[]> {
  const { events } = await readEventsSince(eventsPath(SID), 0);
  return events.map((e) => e.kind);
}

const REFUSAL_MESSAGE = "session process has exited; turn cannot start — use recover";

function seedDeferred(ctx: RunnerContext, callId: string): void {
  ctx.deferredCalls.set(callId, {
    call_id: callId,
    turn_id: "turn_1",
    tool: "Bash",
    args: { command: "apt list --installed" },
    deferred_at: new Date().toISOString(),
    reason: "human will run this manually",
  });
}

describe("send_turn op — dead-B guard", () => {
  it("refuses a dead-B send: error result, no turn_started event, no stdin write, ctx left untouched", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: true });
    const resp = await handleRequest(ctx, { id: "t1", op: "send_turn", message: "hello" });
    expect(resp).toEqual({ id: "t1", ok: false, error: "SESSION_EXITED", message: REFUSAL_MESSAGE });
    expect(await eventKinds()).not.toContain("turn_started");
    expect(fake.writes).toEqual([]);
    // No phantom bookkeeping either — a refused send must be a full no-op.
    expect(ctx.state.turns).toBe(0);
    expect(ctx.turnInFlight).toBe(false);
    expect(ctx.currentTurnId).toBeNull();
  });

  it("live B: send_turn is unaffected — starts a turn, emits turn_started, writes stdin", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: false });
    const resp = await handleRequest(ctx, { id: "t2", op: "send_turn", message: "hello" });
    expect(resp).toMatchObject({ id: "t2", ok: true, result: { turn_id: "turn_1" } });
    expect(await eventKinds()).toContain("turn_started");
    expect(fake.writes).toHaveLength(1);
    expect(JSON.parse(fake.writes[0])).toMatchObject({
      type: "user",
      message: { role: "user", content: "hello" },
    });
  });

  it("a B death landing during the turn_started append refuses instead of writing a dead stream", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: false });
    // Un-awaited: runs synchronously into emitEvent's first await (the fs
    // append), then control returns here — the latch below is guaranteed to
    // land inside the residual window, before the op's continuation resumes.
    const pending = handleRequest(ctx, { id: "t3", op: "send_turn", message: "hello" });
    observeBExit(ctx);
    const resp = await pending;
    expect(resp).toEqual({ id: "t3", ok: false, error: "SESSION_EXITED", message: REFUSAL_MESSAGE });
    expect(fake.writes).toEqual([]);
    // The turn_started append had already committed when B died — the event is
    // the honest one-append residue, and the bookkeeping stays consistent with it.
    expect(await eventKinds()).toContain("turn_started");
    expect(ctx.state.turns).toBe(1);
  });
});

describe("provide_tool_output op — dead-B guard (twin of send_turn's)", () => {
  it("refuses a deferred call on a dead B: error result, no turn_started, no tool_output_provided, no stdin write", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: true });
    seedDeferred(ctx, "toolu_1");
    const resp = await handleRequest(ctx, {
      id: "p1",
      op: "provide_tool_output",
      call_id: "toolu_1",
      stdout: "ok",
    });
    expect(resp).toEqual({ id: "p1", ok: false, error: "SESSION_EXITED", message: REFUSAL_MESSAGE });
    const kinds = await eventKinds();
    expect(kinds).not.toContain("turn_started");
    expect(kinds).not.toContain("tool_output_provided");
    expect(fake.writes).toEqual([]);
    // Left in place rather than silently dropped — the record survives.
    expect(ctx.deferredCalls.has("toolu_1")).toBe(true);
  });

  it("an unknown call_id still reports CALL_NOT_FOUND on a dead B (lookup precedes the bExited guard)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: true });
    const resp = await handleRequest(ctx, { id: "p2", op: "provide_tool_output", call_id: "toolu_missing" });
    expect(resp).toMatchObject({ id: "p2", ok: false, error: "CALL_NOT_FOUND" });
  });

  it("a still-pending call auto-records as deferred even on a dead B, but the turn itself is refused", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: true });
    ctx.pendingApprovals.set("toolu_2", {
      call_id: "toolu_2",
      turn_id: "turn_1",
      tool: "Bash",
      args: { command: "echo hi" },
      default_action: "defer",
      paused_at: Date.now(),
      resolve: () => {},
    });
    const resp = await handleRequest(ctx, { id: "p3", op: "provide_tool_output", call_id: "toolu_2" });
    expect(resp).toMatchObject({ id: "p3", ok: false, error: "SESSION_EXITED" });
    const kinds = await eventKinds();
    expect(kinds).toContain("tool_decision_resolved"); // pre-existing bookkeeping, untouched by this guard
    expect(kinds).not.toContain("turn_started");
    expect(fake.writes).toEqual([]);
    expect(ctx.pendingApprovals.has("toolu_2")).toBe(false);
    expect(ctx.deferredCalls.has("toolu_2")).toBe(true);
  });

  it("live B: provide_tool_output is unaffected — starts a turn, emits both events, writes stdin", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: false });
    seedDeferred(ctx, "toolu_3");
    const resp = await handleRequest(ctx, {
      id: "p4",
      op: "provide_tool_output",
      call_id: "toolu_3",
      stdout: "done",
      exit_code: 0,
    });
    expect(resp).toEqual({ id: "p4", ok: true, result: { turn_id: "turn_1", via: "turn" } });
    const kinds = await eventKinds();
    expect(kinds).toContain("turn_started");
    expect(kinds).toContain("tool_output_provided");
    expect(fake.writes).toHaveLength(1);
    expect(ctx.deferredCalls.has("toolu_3")).toBe(false);
  });

  it("a B death landing during the turn_started append refuses instead of writing a dead stream (twin of send_turn's)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { bExited: false });
    seedDeferred(ctx, "toolu_4");
    // Un-awaited: same choreography as send_turn's twin — runs synchronously
    // into emitEvent's first await (the fs append), then control returns
    // here so the latch below lands inside the residual window, before the
    // op's continuation resumes.
    const pending = handleRequest(ctx, {
      id: "p5",
      op: "provide_tool_output",
      call_id: "toolu_4",
      stdout: "ok",
    });
    observeBExit(ctx);
    const resp = await pending;
    expect(resp).toEqual({ id: "p5", ok: false, error: "SESSION_EXITED", message: REFUSAL_MESSAGE });
    expect(fake.writes).toEqual([]);
    const kinds = await eventKinds();
    expect(kinds).toContain("turn_started");
    expect(kinds).not.toContain("tool_output_provided");
    // Never delivered to B, so the record survives rather than being deleted.
    expect(ctx.deferredCalls.has("toolu_4")).toBe(true);
  });
});

describe("send during rotation", () => {
  it("refuses ROTATION_IN_PROGRESS: no event, no stdin write, turns not bumped", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true });
    const resp = await handleRequest(ctx, { id: "s1", op: "send_turn", message: "hello" });
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    expect((resp as { message: string }).message).toContain("session_rotated");
    const evs = (await readEventsSince(eventsPath(SID), 0)).events;
    expect(evs.find((e) => e.kind === "turn_started")).toBeUndefined();
    expect(fake.writes).toHaveLength(0);
    expect(ctx.state.turns).toBe(0);
  });

  it("sends normally when no rotation is in flight", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const resp = await handleRequest(ctx, { id: "s2", op: "send_turn", message: "hello" });
    expect(resp).toMatchObject({ ok: true, result: { turn_id: "turn_1" } });
    expect(fake.writes).toHaveLength(1);
  });

  it("admits the rotation's own sanctioned handover send", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true, rotationSendId: "handover_1" });
    const resp = await handleRequest(ctx, { id: "handover_1", op: "send_turn", message: "handover instruction" });
    expect(resp).toMatchObject({ ok: true, result: { turn_id: "turn_1" } });
    expect(fake.writes).toHaveLength(1);
  });

  it("refuses a handover-shaped id when no sanctioned send is in flight", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true });
    const resp = await handleRequest(ctx, { id: "handover_1", op: "send_turn", message: "hello" });
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    expect(fake.writes).toHaveLength(0);
  });
});

describe("provide_tool_output during rotation (twin of the send guard)", () => {
  it("refuses a deferred call mid-rotation: no event, no stdin write, bookkeeping and record untouched", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true });
    seedDeferred(ctx, "toolu_r1");
    const resp = await handleRequest(ctx, {
      id: "pr1",
      op: "provide_tool_output",
      call_id: "toolu_r1",
      stdout: "ok",
    });
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    expect((resp as { message: string }).message).toContain("session_rotated");
    expect(await eventKinds()).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(ctx.state.turns).toBe(0);
    expect(ctx.currentTurnId).toBeNull();
    expect(ctx.deferredCalls.has("toolu_r1")).toBe(true);
  });

  it("refuses a still-PENDING call mid-rotation without auto-deferring it — the handover turn's own hook stays paused", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true });
    const resolveSpy = vi.fn();
    ctx.pendingApprovals.set("toolu_r2", {
      call_id: "toolu_r2",
      turn_id: "turn_1",
      tool: "Bash",
      args: { command: "echo hi" },
      default_action: "defer",
      paused_at: Date.now(),
      resolve: resolveSpy,
    });
    const resp = await handleRequest(ctx, { id: "pr2", op: "provide_tool_output", call_id: "toolu_r2" });
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(await eventKinds()).toEqual([]); // no tool_decision_resolved either
    expect(ctx.pendingApprovals.has("toolu_r2")).toBe(true);
    expect(ctx.deferredCalls.has("toolu_r2")).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("an unknown call_id keeps its CALL_NOT_FOUND diagnostic even mid-rotation", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true });
    const resp = await handleRequest(ctx, { id: "pr3", op: "provide_tool_output", call_id: "toolu_missing" });
    expect(resp).toMatchObject({ ok: false, error: "CALL_NOT_FOUND" });
  });

  it("the guard is a window, not a latch: the same provide succeeds once rotating clears", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, { rotating: true });
    seedDeferred(ctx, "toolu_r4");
    const refused = await handleRequest(ctx, { id: "pr4", op: "provide_tool_output", call_id: "toolu_r4", stdout: "ok" });
    expect(refused).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    ctx.rotating = false; // e.g. the rotation failed and the predecessor lives on
    const resp = await handleRequest(ctx, { id: "pr5", op: "provide_tool_output", call_id: "toolu_r4", stdout: "ok" });
    expect(resp).toMatchObject({ ok: true, result: { turn_id: "turn_1" } });
    expect(fake.writes).toHaveLength(1);
    expect(ctx.deferredCalls.has("toolu_r4")).toBe(false);
  });
});

// Every stdout line is stamped with ctx.currentTurnId at parse time, so a
// send that flips the id while a turn runs relabels the rest of that turn
// (reproduced on claude 2.1.280, which merges a mid-turn user line into the
// running turn). send_turn reads the latch afterEventBookkeeping
// maintains — rotate's TURN_IN_FLIGHT posture: plain error, no event.
describe("send during a running turn", () => {
  const IN_FLIGHT_3 =
    "turn_3 is in flight; a turn starts only at a turn boundary — wait for its turn_completed or turn_failed and retry";

  async function inFlightCtx(fake: FakeB, over: Partial<RunnerContext> = {}): Promise<RunnerContext> {
    const ctx = await makeCtx(fake, { turnInFlight: true, currentTurnId: "turn_3", ...over });
    ctx.state.turns = 3;
    return ctx;
  }

  const completed = (turn: string): Event =>
    ({ seq: 9, at: new Date().toISOString(), kind: "turn_completed", turn_id: turn, stop_reason: "success" }) as Event;
  const failed = (turn: string): Event =>
    ({ seq: 9, at: new Date().toISOString(), kind: "turn_failed", turn_id: turn, error: "error_during_execution" }) as Event;

  it("refuses TURN_IN_FLIGHT naming the running turn: no event, no stdin write, turns not bumped, stamp unchanged", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake);
    const resp = await handleRequest(ctx, { id: "s1", op: "send_turn", message: "next" });
    expect(resp).toEqual({ id: "s1", ok: false, error: "TURN_IN_FLIGHT", message: IN_FLIGHT_3 });
    expect(await eventKinds()).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(ctx.state.turns).toBe(3);
    expect(ctx.currentTurnId).toBe("turn_3");
    expect(ctx.turnInFlight).toBe(true);
  });

  it("admits the same send once turn_completed clears the latch through the real bookkeeping", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake);
    await afterEventBookkeeping(ctx, completed("turn_3"));
    const resp = await handleRequest(ctx, { id: "s2", op: "send_turn", message: "next" });
    expect(resp).toMatchObject({ id: "s2", ok: true, result: { turn_id: "turn_4" } });
    expect(await eventKinds()).toEqual(["turn_started"]);
    expect(fake.writes).toHaveLength(1);
  });

  it("admits after turn_failed likewise — the interrupt window closes on the aborted turn's result", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake);
    await afterEventBookkeeping(ctx, failed("turn_3"));
    const resp = await handleRequest(ctx, { id: "s3", op: "send_turn", message: "next" });
    expect(resp).toMatchObject({ ok: true, result: { turn_id: "turn_4" } });
  });

  it("two consecutive sends: the second is refused until the first turn completes (the start --brief then send case)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const first = await handleRequest(ctx, { id: "boot", op: "send_turn", message: "the brief" });
    expect(first).toMatchObject({ ok: true, result: { turn_id: "turn_1" } });
    const second = await handleRequest(ctx, { id: "s6", op: "send_turn", message: "next" });
    expect(second).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
    expect((second as { message: string }).message).toContain("turn_1 is in flight");
    await afterEventBookkeeping(ctx, completed("turn_1"));
    const third = await handleRequest(ctx, { id: "s7", op: "send_turn", message: "next" });
    expect(third).toMatchObject({ ok: true, result: { turn_id: "turn_2" } });
    expect(fake.writes).toHaveLength(2);
  });

  it("a dead B wins over the latch: SESSION_EXITED, not TURN_IN_FLIGHT", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake, { bExited: true });
    const resp = await handleRequest(ctx, { id: "s4", op: "send_turn", message: "next" });
    expect(resp).toMatchObject({ ok: false, error: "SESSION_EXITED" });
  });

  it("a rotation wins over the latch: ROTATION_IN_PROGRESS carries the successor hint", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake, { rotating: true });
    const resp = await handleRequest(ctx, { id: "s5", op: "send_turn", message: "next" });
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
  });

  it("the rotation's sanctioned handover send is admitted with the latch clear and refused with it set", async () => {
    const fake = makeFakeB();
    const clear = await makeCtx(fake, { rotating: true, rotationSendId: "handover_1" });
    const admitted = await handleRequest(clear, { id: "handover_1", op: "send_turn", message: "handover" });
    expect(admitted).toMatchObject({ ok: true, result: { turn_id: "turn_1" } });
    const fake2 = makeFakeB();
    const set = await inFlightCtx(fake2, { rotating: true, rotationSendId: "handover_2" });
    const refused = await handleRequest(set, { id: "handover_2", op: "send_turn", message: "handover" });
    expect(refused).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
    expect(fake2.writes).toEqual([]);
  });
});

// The twin: a call deferred earlier had its hook released long ago, so its
// output can only travel as a new user turn — and a new turn mid-turn
// mis-stamps the running one exactly like send_turn. Same gate, same posture;
// the deferred record survives for the retry at the boundary.
describe("provide_tool_output during a running turn (new-turn path)", () => {
  const OUTPUT_IN_FLIGHT_3 =
    "turn_3 is in flight; the output turn starts only at a turn boundary — wait for its turn_completed or turn_failed and retry provide_tool_output (the deferred record is kept)";
  const PROVIDE = { id: "p1", op: "provide_tool_output" as const, call_id: "toolu_3", stdout: "done", exit_code: 0 };

  async function inFlightCtx(fake: FakeB, over: Partial<RunnerContext> = {}): Promise<RunnerContext> {
    const ctx = await makeCtx(fake, { turnInFlight: true, currentTurnId: "turn_3", ...over });
    ctx.state.turns = 3;
    return ctx;
  }

  it("refuses TURN_IN_FLIGHT: no turn_started, no tool_output_provided, no stdin write, record kept", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake);
    seedDeferred(ctx, "toolu_3");
    const resp = await handleRequest(ctx, PROVIDE);
    expect(resp).toEqual({ id: "p1", ok: false, error: "TURN_IN_FLIGHT", message: OUTPUT_IN_FLIGHT_3 });
    expect(await eventKinds()).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(ctx.deferredCalls.has("toolu_3")).toBe(true);
    expect(ctx.state.turns).toBe(3);
  });

  it("the same call succeeds once turn_completed clears the latch, and says via: turn", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake);
    seedDeferred(ctx, "toolu_3");
    await afterEventBookkeeping(
      ctx,
      { seq: 9, at: new Date().toISOString(), kind: "turn_completed", turn_id: "turn_3", stop_reason: "success" } as Event
    );
    const resp = await handleRequest(ctx, PROVIDE);
    expect(resp).toEqual({ id: "p1", ok: true, result: { turn_id: "turn_4", via: "turn" } });
    expect(await eventKinds()).toEqual(["turn_started", "tool_output_provided"]);
    expect(fake.writes).toHaveLength(1);
    expect(ctx.deferredCalls.has("toolu_3")).toBe(false);
  });

  it("an unknown call keeps CALL_NOT_FOUND with the latch set", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake);
    const resp = await handleRequest(ctx, { ...PROVIDE, call_id: "toolu_nope" });
    expect(resp).toMatchObject({ ok: false, error: "CALL_NOT_FOUND" });
  });

  it("a dead B wins over the latch on the new-turn path", async () => {
    const fake = makeFakeB();
    const ctx = await inFlightCtx(fake, { bExited: true });
    seedDeferred(ctx, "toolu_3");
    const resp = await handleRequest(ctx, PROVIDE);
    expect(resp).toMatchObject({ ok: false, error: "SESSION_EXITED" });
    expect(ctx.deferredCalls.has("toolu_3")).toBe(true);
  });
});

// A call still paused in the approval hook can be answered THROUGH the hook:
// the approver renders the runner's deny message as the structured envelope
// and claude hands it to the model as the call's own tool_result (a 64 KB
// message arrived intact on 2.1.283). No turn is minted, so nothing can
// mis-stamp the running turn. A hook is answered only while its turn still
// runs, the approver is still alive (it self-times-out at 595 s) and the
// text fits the probed 64 KiB; anything else is stale and falls back to the
// new-turn path.
describe("provide_tool_output on a pending call delivers through the hook", () => {
  type Decision = { behavior: "allow" | "deny"; message?: string };
  const GATE_ARGS = { command: "echo 'CLAW-GATE: include the changelog?'" };

  function seedPending(
    ctx: RunnerContext,
    callId: string,
    resolve: (d: Decision) => void,
    pausedAt: number = Date.now()
  ): void {
    ctx.pendingApprovals.set(callId, {
      call_id: callId,
      turn_id: "turn_3",
      tool: "Bash",
      args: GATE_ARGS,
      default_action: "defer",
      paused_at: pausedAt,
      resolve,
    });
  }

  async function pendingCtx(fake: FakeB, over: Partial<RunnerContext> = {}): Promise<RunnerContext> {
    const ctx = await makeCtx(fake, { turnInFlight: true, currentTurnId: "turn_3", ...over });
    ctx.state.turns = 3;
    return ctx;
  }

  it("releases the paused hook with the composed output as a denial, inside the running turn", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d));
    const resp = await handleRequest(ctx, {
      id: "p7", op: "provide_tool_output", call_id: "toolu_7",
      stdout: "yes, include it", exit_code: 0, extra: "answered by the human",
    });
    expect(resp).toEqual({ id: "p7", ok: true, result: { turn_id: "turn_3", via: "hook" } });
    expect(decisions).toEqual([
      {
        behavior: "deny",
        message: composeOutputMessage({
          tool: "Bash", call_id: "toolu_7", args: GATE_ARGS,
          exit_code: 0, stdout: "yes, include it", stderr: "", extra: "answered by the human",
        }),
      },
    ]);
    // Nothing turn-shaped happened.
    expect(fake.writes).toEqual([]);
    expect(ctx.state.turns).toBe(3);
    expect(ctx.currentTurnId).toBe("turn_3");
    expect(ctx.turnInFlight).toBe(true);
    // Bookkeeping: the call left pending, no deferred record remains.
    expect(ctx.pendingApprovals.has("toolu_7")).toBe(false);
    expect(ctx.deferredCalls.has("toolu_7")).toBe(false);
  });

  it("emits tool_decision_resolved (defer, auto) and tool_output_provided on the running turn, and no turn_started", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    seedPending(ctx, "toolu_7", () => {});
    await handleRequest(ctx, { id: "p8", op: "provide_tool_output", call_id: "toolu_7", stdout: "out", stderr: "err", exit_code: 2 });
    const { events } = await readEventsSince(eventsPath(SID), 0);
    expect(events.map((e) => e.kind)).toEqual(["tool_decision_resolved", "tool_output_provided"]);
    expect(events[0]).toMatchObject({
      turn_id: "turn_3", call_id: "toolu_7", action: "defer",
      reason: "auto-deferred by provide_tool_output", resolved_by: "user_mcp_auto",
    });
    expect(events[1]).toMatchObject({ turn_id: "turn_3", call_id: "toolu_7", stdout_len: 3, stderr_len: 3, exit_code: 2 });
  });

  it("both events are on disk before the hook is released", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    let kindsAtRelease: string[] = [];
    seedPending(ctx, "toolu_7", () => {
      kindsAtRelease = readFileSync(eventsPath(SID), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { kind: string }).kind);
    });
    await handleRequest(ctx, { id: "p9", op: "provide_tool_output", call_id: "toolu_7", stdout: "x" });
    expect(kindsAtRelease).toEqual(["tool_decision_resolved", "tool_output_provided"]);
  });

  it("a pending entry whose turn has ended (latch clear) is stale: DEFERRED release, then the output goes in as a turn", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d));
    const resp = await handleRequest(ctx, { id: "p10", op: "provide_tool_output", call_id: "toolu_7", stdout: "late" });
    expect(resp).toEqual({ id: "p10", ok: true, result: { turn_id: "turn_1", via: "turn" } });
    expect(decisions).toEqual([{ behavior: "deny", message: "DEFERRED: human will run this command manually." }]);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    expect(events.map((e) => e.kind)).toEqual(["tool_decision_resolved", "turn_started", "tool_output_provided"]);
    expect(events[0]).toMatchObject({ reason: "auto-deferred by provide_tool_output (the paused turn has ended)" });
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toContain("late");
    expect(ctx.deferredCalls.has("toolu_7")).toBe(false);
  });

  it("a pending entry from an earlier turn while a newer turn runs is stale: TURN_IN_FLIGHT, record kept with the turn-ended reason", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    ctx.currentTurnId = "turn_4";
    ctx.state.turns = 4;
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d)); // stamped turn_3
    const resp = await handleRequest(ctx, { id: "p15", op: "provide_tool_output", call_id: "toolu_7", stdout: "x" });
    expect(resp).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
    expect(decisions).toEqual([{ behavior: "deny", message: "DEFERRED: human will run this command manually." }]);
    expect(await eventKinds()).toEqual(["tool_decision_resolved"]);
    expect(ctx.deferredCalls.get("toolu_7")).toMatchObject({ reason: "auto-deferred by provide_tool_output (the paused turn has ended)" });
  });

  function fill(n: number): string {
    // The probe call below passes stdout: "" to size the fixed scaffolding,
    // but composeOutputMessage substitutes the 7-byte "(empty)" placeholder
    // for any falsy stdout — a substitution the real call below never hits,
    // since its stdout is this function's (non-empty) return value. Add the
    // placeholder's length back so the literal `n` argument lands exactly on
    // the composed message's real byte length.
    const EMPTY_PLACEHOLDER_LEN = "(empty)".length;
    const base = Buffer.byteLength(
      composeOutputMessage({ tool: "Bash", call_id: "toolu_7", args: GATE_ARGS, exit_code: 0, stdout: "", stderr: "", extra: "" })
    );
    return "x".repeat(n - base + EMPTY_PLACEHOLDER_LEN);
  }

  it("an output that composes to exactly HOOK_DELIVERY_MAX_BYTES still goes through the hook", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d));
    const resp = await handleRequest(ctx, { id: "p16", op: "provide_tool_output", call_id: "toolu_7", stdout: fill(HOOK_DELIVERY_MAX_BYTES), exit_code: 0 });
    expect(resp).toEqual({ id: "p16", ok: true, result: { turn_id: "turn_3", via: "hook" } });
    expect(Buffer.byteLength(decisions[0]!.message!)).toBe(HOOK_DELIVERY_MAX_BYTES);
  });

  it("an output one byte over HOOK_DELIVERY_MAX_BYTES is kept off the hook: DEFERRED release, record with the size reason, TURN_IN_FLIGHT until the boundary", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d));
    const resp = await handleRequest(ctx, { id: "p17", op: "provide_tool_output", call_id: "toolu_7", stdout: fill(HOOK_DELIVERY_MAX_BYTES + 1), exit_code: 0 });
    expect(resp).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
    expect(decisions).toEqual([{ behavior: "deny", message: "DEFERRED: human will run this command manually." }]);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    expect(events.map((e) => e.kind)).toEqual(["tool_decision_resolved"]);
    expect(events[0]).toMatchObject({ reason: "auto-deferred by provide_tool_output (output too large for the hook)" });
    expect(ctx.deferredCalls.get("toolu_7")).toMatchObject({ reason: "auto-deferred by provide_tool_output (output too large for the hook)" });
    expect(fake.writes).toEqual([]);
  });

  it("a ghost hook (paused past the hook-delivery window) is refused TURN_IN_FLIGHT and keeps the auto-defer record for the retry", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake);
    seedPending(ctx, "toolu_7", () => {}, Date.now() - HOOK_DELIVERY_WINDOW_MS - 1);
    const resp = await handleRequest(ctx, { id: "p14", op: "provide_tool_output", call_id: "toolu_7", stdout: "late" });
    expect(resp).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
    expect(await eventKinds()).toEqual(["tool_decision_resolved"]);
    expect(fake.writes).toEqual([]);
    expect(ctx.deferredCalls.get("toolu_7")).toMatchObject({
      reason: "auto-deferred by provide_tool_output (approver hook timed out)",
    });
    const { events } = await readEventsSince(eventsPath(SID), 0);
    expect(events[0]).toMatchObject({ reason: "auto-deferred by provide_tool_output (approver hook timed out)" });
  });

  it("a dead B takes the auto-defer path: the call is recorded as deferred and the op refuses SESSION_EXITED", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake, { bExited: true });
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d));
    const resp = await handleRequest(ctx, { id: "p11", op: "provide_tool_output", call_id: "toolu_7", stdout: "x" });
    expect(resp).toMatchObject({ ok: false, error: "SESSION_EXITED" });
    expect(decisions).toEqual([{ behavior: "deny", message: "DEFERRED: human will run this command manually." }]);
    expect(await eventKinds()).toEqual(["tool_decision_resolved"]);
    expect(ctx.deferredCalls.get("toolu_7")).toMatchObject({ reason: "auto-deferred by provide_tool_output" });
    const { events } = await readEventsSince(eventsPath(SID), 0);
    expect(events[0]).toMatchObject({ reason: "auto-deferred by provide_tool_output" });
  });

  it("a rotation refuses before touching the hook (existing posture)", async () => {
    const fake = makeFakeB();
    const ctx = await pendingCtx(fake, { rotating: true });
    const decisions: Decision[] = [];
    seedPending(ctx, "toolu_7", (d) => decisions.push(d));
    const resp = await handleRequest(ctx, { id: "p12", op: "provide_tool_output", call_id: "toolu_7" });
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
    expect(decisions).toEqual([]);
    expect(ctx.pendingApprovals.has("toolu_7")).toBe(true);
  });
});

describe("attachBStdinErrorAbsorber", () => {
  it("attaches exactly one error listener and absorbs an emitted error, logging it to stderr", () => {
    const fake = makeFakeB();
    attachBStdinErrorAbsorber(fake.b);
    expect(fake.stdin.listenerCount("error")).toBe(1);
    // The spy swallows the absorber's log line (keeps suite output clean)
    // while pinning its format — a bare no-op error handler would absorb
    // the error but log nothing.
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => fake.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("b stdin error absorbed: EPIPE");
    } finally {
      spy.mockRestore();
    }
  });

  it("mechanism control: an un-attached stdin's emitted error throws (documents the crash the absorber prevents)", () => {
    const fake = makeFakeB();
    expect(() => fake.stdin.emit("error", new Error("EPIPE"))).toThrow();
  });
});
