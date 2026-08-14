import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
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
import { eventsPath, handoverPath, statePath } from "../../src/lib/paths.js";
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
    autoRotateLatched: false,
    costWarned: false,
  } as RunnerContext;
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
});
