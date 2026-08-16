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
  type RunnerContext,
} from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";
import { readEventsSince } from "../../src/lib/events.js";
import { eventsPath } from "../../src/lib/paths.js";

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
    expect(resp).toMatchObject({ id: "p4", ok: true, result: { turn_id: "turn_1" } });
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
