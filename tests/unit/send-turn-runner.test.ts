import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { handleRequest, type RunnerContext } from "../../src/runner/runner.js";
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
  return { writes, b };
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
    ...overrides,
  } as RunnerContext;
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
});
