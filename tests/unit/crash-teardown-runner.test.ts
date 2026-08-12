import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  handleRequest,
  handleUnexpectedBExit,
  type RunnerContext,
} from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";
import { readEventsSince } from "../../src/lib/events.js";
import { eventsPath } from "../../src/lib/paths.js";

// Dogfood 2026-08-04, gen-2 `crashed:0`: B died 42s into the rotate's handover
// turn. The rotate client hung (the turn waiter can never fire once B's stdout
// is closed), no rotation_failed was recorded, and the runner outlived its own
// session. These tests drive that choreography deterministically: a fake B, a
// real session dir under a synthetic CLAW_DRIVE_HOME, and
// handleUnexpectedBExit standing in for b.on("exit").

const SID = "sess_crashrot01";

let root: string;
let stubDir: string;
let prevHome: string | undefined;
let prevPath: string | undefined;
let prevBin: string | undefined;

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} did not settle within ${ms}ms`)),
      ms
    );
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Plant a valid <handover> as the given turn's assistant text in events.jsonl. */
async function appendAssistantHandover(turnId: string): Promise<void> {
  const line = JSON.stringify({
    seq: 90,
    at: new Date().toISOString(),
    kind: "assistant_text",
    turn_id: turnId,
    text: "<handover>\n## Current objective\ncontinue\n</handover>",
  });
  await fs.appendFile(eventsPath(SID), line + "\n");
}

async function eventKinds(): Promise<string[]> {
  const { events } = await readEventsSince(eventsPath(SID), 0);
  return events.map((e) => e.kind);
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  prevPath = process.env.PATH;
  prevBin = process.env.CLAW_DRIVE_BIN;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "crashrot-"));
  process.env.CLAW_DRIVE_HOME = root;
  // Distiller stub: the crash path spawns `claude -p` best-effort; a stub that
  // exits silently makes that path fast and token-free.
  stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "crashrot-stub-"));
  const stub = path.join(stubDir, "claude");
  await fs.writeFile(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.chmod(stub, 0o755);
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  // Successor spawns must never launch a real runner from a unit test.
  process.env.CLAW_DRIVE_BIN = "/bin/false";
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  if (prevBin === undefined) delete process.env.CLAW_DRIVE_BIN;
  else process.env.CLAW_DRIVE_BIN = prevBin;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(stubDir, { recursive: true, force: true });
});

describe("handleUnexpectedBExit — crash during rotate (dogfood gen-2)", () => {
  it("marks bExited and fails+clears every pending turn waiter", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const outcomes: Array<"completed" | "failed"> = [];
    ctx.turnWaiters.set("turn_1", (o) => outcomes.push(o));
    ctx.turnWaiters.set("turn_7", (o) => outcomes.push(o));
    await handleUnexpectedBExit(ctx, 0, null);
    expect((ctx as { bExited?: boolean }).bExited).toBe(true);
    expect(outcomes).toEqual(["failed", "failed"]);
    expect(ctx.turnWaiters.size).toBe(0);
  });

  it("settles an in-flight rotate promptly with ROTATION_FAILED (hung-client fix)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
    await waitUntil(() => ctx.turnWaiters.size === 1);
    await handleUnexpectedBExit(ctx, 0, null);
    const resp = await withTimeout(rotate, 2000, "rotate");
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
    expect((resp as { message: string }).message).toMatch(/exited/);
  });

  it("records rotation_failed BEFORE session_stopped, exactly once", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
    await waitUntil(() => ctx.turnWaiters.size === 1);
    await handleUnexpectedBExit(ctx, 0, null);
    await withTimeout(rotate, 2000, "rotate");
    const kinds = await eventKinds();
    expect(kinds.filter((k) => k === "rotation_failed")).toHaveLength(1);
    const rf = kinds.indexOf("rotation_failed");
    const ss = kinds.indexOf("session_stopped");
    expect(rf).toBeGreaterThanOrEqual(0);
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(rf).toBeLessThan(ss);
  });

  it("does not send a second handover attempt to a dead B", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
    await waitUntil(() => fake.writes.length === 1);
    await handleUnexpectedBExit(ctx, 0, null);
    await withTimeout(rotate, 2000, "rotate");
    expect(fake.writes).toHaveLength(1);
  });

  it("plain crash without a rotation in flight emits session_stopped only", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    await handleUnexpectedBExit(ctx, 137, null);
    const kinds = await eventKinds();
    expect(kinds).toContain("session_stopped");
    expect(kinds).not.toContain("rotation_failed");
    expect(ctx.state.exit_reason).toBe("crashed:137");
  });

  it(
    "aborts without a successor when B died right after the handover turn",
    async () => {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake);
      const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
      await waitUntil(() => ctx.turnWaiters.size === 1);
      // Plant a valid handover as the turn's text, then simulate B's death
      // being noticed between turn completion and the scaffold step (the
      // waiter resolves "completed" the way afterEventBookkeeping would).
      await appendAssistantHandover("turn_1");
      (ctx as { bExited?: boolean }).bExited = true;
      const waiter = ctx.turnWaiters.get("turn_1")!;
      ctx.turnWaiters.delete("turn_1");
      waiter("completed");
      const resp = await withTimeout(rotate, 8000, "rotate");
      expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
      expect((resp as { message: string }).message).toMatch(/exited/);
      const kinds = await eventKinds();
      expect(kinds.filter((k) => k === "rotation_failed")).toHaveLength(1);
      const dirs = await fs.readdir(path.join(root, "sessions"));
      expect(dirs).toEqual([SID]);
    },
    10_000
  );

  it("threads the predecessor's mcp.json mcpServers into a rotation successor", async () => {
    // Successor spawn "succeeds" via a stub runner bin that touches the ready
    // marker; the fake B then exits so the deferred self-teardown finishes.
    const stub = path.join(stubDir, "fake-runner");
    await fs.writeFile(stub, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', {
      mode: 0o755,
    });
    await fs.chmod(stub, 0o755);
    process.env.CLAW_DRIVE_BIN = stub;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake);
      await fs.writeFile(
        path.join(root, "sessions", SID, "mcp.json"),
        JSON.stringify({ mcpServers: { extra: { command: "x" } } })
      );
      const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
      await waitUntil(() => ctx.turnWaiters.size === 1);
      await appendAssistantHandover("turn_1");
      const waiter = ctx.turnWaiters.get("turn_1")!;
      ctx.turnWaiters.delete("turn_1");
      waiter("completed");
      const resp = await withTimeout(rotate, 8000, "rotate");
      expect(resp).toMatchObject({ ok: true });
      const newId = (resp as { result: { new_session_id: string } }).result.new_session_id;
      const mcp = JSON.parse(
        await fs.readFile(path.join(root, "sessions", newId, "mcp.json"), "utf-8")
      ) as { mcpServers: Record<string, unknown> };
      expect(mcp.mcpServers).toMatchObject({ extra: { command: "x" } });
      // Let the predecessor's deferred self-teardown run to completion.
      fake.emitter.emit("exit", 0, null);
      await waitUntil(() => exitSpy.mock.calls.length > 0);
    } finally {
      exitSpy.mockRestore();
    }
  }, 10_000);

  it("a crash during the attempt-2 settle window still records exactly one rotation_failed before session_stopped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const drain = async (rounds = 300) => {
      for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
    };
    try {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake);
      const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
      await drain();
      expect(fake.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600_000); // attempt 1 times out → SIGINT
      await drain();
      const waiter = ctx.turnWaiters.get("turn_1")!;
      waiter("failed"); // interrupted turn terminates late → 15s settle begins
      await drain();
      // B dies inside the settle window — no waiter is armed, so this is the
      // loop-top-discovery path. The crash teardown must hold session_stopped
      // until the woken rotate op has recorded the rotation's outcome.
      const crashDone = handleUnexpectedBExit(ctx, 0, null);
      await drain();
      expect(await eventKinds()).not.toContain("session_stopped");
      await vi.advanceTimersByTimeAsync(15_000); // settle elapses → loop-top sees bExited
      const resp = await withTimeout(rotate, 4000, "rotate");
      expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
      await crashDone;
      const kinds = await eventKinds();
      expect(kinds.filter((k) => k === "rotation_failed")).toHaveLength(1);
      expect(kinds.indexOf("rotation_failed")).toBeLessThan(kinds.indexOf("session_stopped"));
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("a rotate arriving after B's death refuses without appending post-terminal events", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    await handleUnexpectedBExit(ctx, 0, null); // session_stopped is the last event
    // The death killed an in-flight turn: turnInFlight stays latched (the
    // crash path bypasses afterEventBookkeeping). The refusal must still be
    // the truthful use-recover one, not TURN_IN_FLIGHT's unfollowable
    // "retry at the turn boundary".
    ctx.turnInFlight = true;
    const before = (await eventKinds()).length;
    const resp = await withTimeout(
      handleRequest(ctx, { id: "r2", op: "rotate" }),
      2000,
      "rotate"
    );
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
    expect((resp as { message: string }).message).toMatch(/recover/);
    expect((await eventKinds()).length).toBe(before);
    expect(fake.writes).toHaveLength(0);
  });

  it("a crash during the MAX_GENERATIONS terminal handover records rotation_refused, not rotation_failed", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    ctx.state.generation = 10; // at the default cap → rotate takes the refusal path
    const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
    await waitUntil(() => ctx.turnWaiters.size === 1); // terminal handover turn armed
    const crashDone = handleUnexpectedBExit(ctx, 0, null);
    const resp = await withTimeout(rotate, 4000, "rotate");
    expect(resp).toMatchObject({ ok: false, error: "MAX_GENERATIONS" });
    await crashDone;
    const kinds = await eventKinds();
    expect(kinds).toContain("rotation_refused");
    expect(kinds).not.toContain("rotation_failed");
    expect(kinds.indexOf("rotation_refused")).toBeLessThan(kinds.indexOf("session_stopped"));
  });

  it("handover attempt 2 waits out the interrupt settle window before sending (A3 kill pattern)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kills: Array<[number, string | number]> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      kills.push([pid, sig ?? "SIGTERM"]);
      return true;
    }) as never);
    // Real-time drains (timers are faked): drainUntil for progress,
    // drainFor to prove NOTHING happens across a genuine time window.
    const drainUntil = async (cond: () => boolean) => {
      const dl = Date.now() + 5000;
      while (!cond()) {
        if (Date.now() > dl) throw new Error("drainUntil: condition not reached");
        await new Promise((r) => setImmediate(r));
      }
    };
    const drainFor = async (ms: number) => {
      const dl = Date.now() + ms;
      while (Date.now() < dl) await new Promise((r) => setImmediate(r));
    };
    try {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake);
      const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
      await drainUntil(() => fake.writes.length === 1);
      // Attempt 1 times out (600s) → the runner SIGINTs B…
      await vi.advanceTimersByTimeAsync(600_000);
      await drainUntil(() => kills.some(([, sig]) => sig === "SIGINT"));
      // …and the interrupted turn terminates late, within the grace window.
      const waiter = ctx.turnWaiters.get("turn_1")!;
      waiter("failed");
      // Attempt 2 must NOT go out immediately — a just-SIGINT'd claude can
      // exit on its next stdin message. 500ms of real time is far more than
      // an immediate send would need to surface.
      await drainFor(500);
      expect(fake.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await drainUntil(() => fake.writes.length === 2);
      // Fail attempt 2's turn too: the rotation ends cleanly, no dangling op.
      const waiter2 = ctx.turnWaiters.get("turn_2")!;
      waiter2("failed");
      const resp = await rotate;
      expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  // Task 4 (behavior-minors wave, carried v1.4.1 residual finding). The test
  // "a crash during the attempt-2 settle window still records exactly one
  // rotation_failed before session_stopped" lands its crash in the settle
  // window that FOLLOWS ATTEMPT 1's own timeout+SIGINT — "no waiter is
  // armed" there because attempt 2 never sent. That death is discovered at
  // attempt 2's loop-top guard, which is the already-covered C0 selector
  // path. These two tests land the crash (or a stop) in the settle window
  // that follows ATTEMPT 2's OWN timeout+SIGINT instead: attempt 2 is the
  // loop's last iteration ([1, 2] is the whole loop), so there is no third
  // loop-top pass to observe it — the fall-through after the loop is what
  // has to catch it.
  it("a crash landing in attempt 2's OWN settle window reports b_exited, not the generic no-handover reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kills: Array<[number, string | number]> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      kills.push([pid, sig ?? "SIGTERM"]);
      return true;
    }) as never);
    // Time-bounded condition polling, not a fixed round count — send_turn's
    // own emitEvent is a REAL async fs write (append + writeState), and the
    // fs threadpool can lag arbitrarily under a parallel suite run (same
    // rationale as the sibling unit suites' own drainUntil helpers).
    const drainUntil = async (cond: () => boolean) => {
      const dl = Date.now() + 5000;
      while (!cond()) {
        if (Date.now() > dl) throw new Error("drainUntil: condition not reached");
        await new Promise((r) => setImmediate(r));
      }
    };
    try {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake);
      const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
      await drainUntil(() => fake.writes.length === 1); // attempt 1 sent
      // Attempt 1 fails outright (no timeout) — the loop advances straight
      // to attempt 2's send.
      const waiter1 = ctx.turnWaiters.get("turn_1")!;
      waiter1("failed");
      await drainUntil(() => fake.writes.length === 2); // attempt 2 sent
      // Attempt 2 times out (600s) → SIGINT.
      await vi.advanceTimersByTimeAsync(600_000);
      await drainUntil(() => kills.some(([, sig]) => sig === "SIGINT"));
      // B acknowledges the interrupt within its own grace period — turn_2
      // resolves, so this is NOT the wedged path; attempt 2's OWN 15s
      // settle begins.
      const waiter2 = ctx.turnWaiters.get("turn_2")!;
      waiter2("failed");
      await drainUntil(() => !ctx.turnWaiters.has("turn_2"));
      // B dies inside attempt 2's OWN settle window — a genuine crash, not
      // caused by the interrupt or a stop. Drives the real crash
      // choreography, not a forged flag set, so the terminal exit_reason
      // pin below is a genuine unclobbered assertion rather than an echo
      // of a test-set value.
      const crashDone = handleUnexpectedBExit(ctx, 0, null);
      await drainUntil(() => ctx.crashTeardownEngaged);
      expect(await eventKinds()).not.toContain("session_stopped");
      await vi.advanceTimersByTimeAsync(15_000);
      const resp = await withTimeout(rotate, 4000, "rotate");
      expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
      expect((resp as { message: string }).message).toMatch(/use recover/);
      await crashDone;
      const kinds = await eventKinds();
      expect(kinds.filter((k) => k === "rotation_failed")).toHaveLength(1);
      expect(kinds.indexOf("rotation_failed")).toBeLessThan(kinds.indexOf("session_stopped"));
      const { events } = await readEventsSince(eventsPath(SID), 0);
      const rf = events.find((e) => e.kind === "rotation_failed");
      expect((rf as unknown as { reason: string }).reason).toBe(
        "b_exited: session process exited during the handover turn"
      );
      // Unclobbered pin, same convention as the C0 selector's own crash
      // tests: the crash's own reason must survive untouched.
      expect(ctx.state.exit_reason).toBe("crashed:0");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("a stop (no crash) landing in attempt 2's OWN settle window reports session_stopping, not the generic no-handover reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kills: Array<[number, string | number]> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      kills.push([pid, sig ?? "SIGTERM"]);
      return true;
    }) as never);
    const drainUntil = async (cond: () => boolean) => {
      const dl = Date.now() + 5000;
      while (!cond()) {
        if (Date.now() > dl) throw new Error("drainUntil: condition not reached");
        await new Promise((r) => setImmediate(r));
      }
    };
    try {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake);
      const rotate = handleRequest(ctx, { id: "r1", op: "rotate" });
      await drainUntil(() => fake.writes.length === 1);
      const waiter1 = ctx.turnWaiters.get("turn_1")!;
      waiter1("failed");
      await drainUntil(() => fake.writes.length === 2);
      await vi.advanceTimersByTimeAsync(600_000);
      await drainUntil(() => kills.some(([, sig]) => sig === "SIGINT"));
      const waiter2 = ctx.turnWaiters.get("turn_2")!;
      waiter2("failed");
      await drainUntil(() => !ctx.turnWaiters.has("turn_2"));
      // A stop lands inside attempt 2's OWN settle window — no crash, so
      // stopping (not a death) owns the exit.
      await handleRequest(ctx, { id: "s1", op: "stop_session" });
      await drainUntil(() => ctx.stopping);
      expect(ctx.bExited).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      const resp = await withTimeout(rotate, 4000, "rotate");
      expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
      const { events } = await readEventsSince(eventsPath(SID), 0);
      const rf = events.find((e) => e.kind === "rotation_failed");
      expect((rf as unknown as { reason: string }).reason).toBe(
        "session_stopping: stop or circuit breaker engaged during the handover turn"
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("a refused handover send fails the attempt immediately with the truthful reason (no 600s strand)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake);
    // Un-awaited: the rotate op runs synchronously all the way into the
    // handover send's turn_started append (entry checks, gate, loop-top and
    // waiter registration have no awaits), then control returns here.
    const pending = handleRequest(ctx, { id: "r1", op: "rotate" });
    // Direct field write, deliberately NOT observeBExit: constructs the state
    // the discard defends against — bExited latched while THIS attempt's
    // waiter was never flushed (what a future await between the loop-top
    // guard and waiter registration would produce). The real death path
    // flushes the waiter and self-heals; this pin is the defensive twin.
    ctx.bExited = true;
    const resp = await pending;
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_FAILED" });
    expect((resp as { message?: string }).message).toBe(
      "session process exited during the handover turn; rotation cannot complete — use recover (a crash handover is distilled best-effort)"
    );
    // reason literal byte-identical to the loop-top cell's; exactly one
    // turn_started (attempt 2 never sends); the dropped waiter is gone.
    // rotation_failed reason === "b_exited: session process exited during the handover turn"
    expect(ctx.turnWaiters.size).toBe(0);
  });
});
