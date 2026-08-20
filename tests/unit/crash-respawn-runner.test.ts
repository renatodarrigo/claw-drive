import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  handleUnexpectedBExit,
  maybeAutoRespawn,
  afterEventBookkeeping,
  type RunnerContext,
} from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";
import { readState } from "../../src/lib/state.js";
import { readEventsSince, type Event } from "../../src/lib/events.js";
import { eventsPath, statePath, crashHandoverPath } from "../../src/lib/paths.js";
import type { Policy } from "../../src/lib/policy.js";

// Crash auto-respawn (respawn.mode "auto"): handleUnexpectedBExit runs
// maybeAutoRespawn between the crash's terminal state write and its
// session_stopped emit, so a configured session spawns its own successor
// from inside the crash teardown — mirroring the rotate choreography's
// race-free ordering (successor pointer + narration BEFORE the terminal
// event) without a human ever running `recover`. These tests drive that
// choreography deterministically: a fake B, a real session dir under a
// synthetic CLAW_DRIVE_HOME, and handleUnexpectedBExit standing in for
// b.on("exit"), same harness convention as crash-teardown-runner.test.ts.

const SID = "sess_crashresp01";

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
  // Stamp the exit like a real ChildProcess (exitCode is set by the time
  // 'exit' fires): a test may emit B's exit before an exit listener is
  // registered, and only the stamped exitCode lets teardown's dead-B
  // early path observe it.
  emitter.on("exit", (code: number | null, signal: string | null) => {
    (b as { exitCode: number | null }).exitCode = code;
    (b as { signalCode: string | null }).signalCode = signal ?? null;
  });
  return { writes, emitter, b };
}

async function makeCtx(fake: FakeB, policy: Policy): Promise<RunnerContext> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "events.jsonl"), "");
  const state: SessionState = {
    session_id: SID,
    status: "running",
    cwd: "/tmp/x",
    policy,
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "crashresp-"));
  process.env.CLAW_DRIVE_HOME = root;
  stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "crashresp-stub-"));
  // Distiller stub: the crash path spawns `claude -p` best-effort; a stub
  // that exits silently makes that path fast and token-free.
  const claudeStub = path.join(stubDir, "claude");
  await fs.writeFile(claudeStub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.chmod(claudeStub, 0o755);
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
  // Fake-runner stub: unlike crash-teardown-runner.test.ts (which defaults
  // CLAW_DRIVE_BIN to /bin/false and opts individual tests into a working
  // stub), almost every test here exercises a successful respawn, so the
  // working stub is the default — it touches the successor's ready marker
  // so recoverSession's waitForReady resolves without a real runner.
  const runnerStub = path.join(stubDir, "fake-runner");
  await fs.writeFile(runnerStub, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', {
    mode: 0o755,
  });
  await fs.chmod(runnerStub, 0o755);
  process.env.CLAW_DRIVE_BIN = runnerStub;
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

const AUTO = { respawn: { mode: "auto" as const } };

function kindsOf(events: Event[]): string[] {
  return events.map((e) => e.kind);
}

describe("crash auto-respawn choreography (handleUnexpectedBExit)", () => {
  it("respawns: rotated_to and session_recovered land BEFORE session_stopped; successor carries streak 1", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    await fs.writeFile(crashHandoverPath(SID), "## Current objective\nresume");
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const kinds = kindsOf(events);
    expect(kinds[kinds.length - 1]).toBe("session_stopped");
    const rec = events.find(
      (e): e is Extract<Event, { kind: "session_recovered" }> => e.kind === "session_recovered"
    );
    expect(rec).toBeDefined();
    expect(kinds.indexOf("session_recovered")).toBeLessThan(kinds.indexOf("session_stopped"));
    expect(rec!.initiated_by).toBe("auto");
    expect(rec!.generation).toBe(2);
    expect(rec!.watch_command).toContain(rec!.new_session_id);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const pred = await readState(statePath(SID));
    expect(pred?.rotated_to).toBe(rec!.new_session_id);
    expect(pred?.exit_reason).toBe("crashed:137");
    const succ = await readState(statePath(rec!.new_session_id));
    expect(succ?.respawn_streak).toBe(1);
    expect(succ?.rotated_from).toBe(SID);
  });

  it("transfers the alias and reports it in session_recovered", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.state.alias = "worker";
    await fs.writeFile(crashHandoverPath(SID), "## Current objective\nresume");
    await handleUnexpectedBExit(ctx, 1, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const rec = events.find(
      (e): e is Extract<Event, { kind: "session_recovered" }> => e.kind === "session_recovered"
    );
    expect(rec?.alias).toBe("worker");
    expect((await readState(statePath(rec!.new_session_id)))?.alias).toBe("worker");
  });

  it("stays silent without an auto respawn block: only session_stopped is written", async () => {
    for (const policy of [
      { rotation: { threshold_tokens: 100_000 } },
      { respawn: { mode: "manual" as const } },
      { respawn: {} },
    ]) {
      const fake = makeFakeB();
      const ctx = await makeCtx(fake, policy);
      await handleUnexpectedBExit(ctx, 137, null);
      const { events } = await readEventsSince(eventsPath(SID), 0);
      expect(kindsOf(events)).toEqual(["session_stopped"]);
      await fs.rm(path.join(root, "sessions", SID), { recursive: true, force: true });
    }
  });

  it("widened distill condition: a respawn-only policy still writes crash-handover.md", async () => {
    // Distiller stub that actually produces a handover for this test.
    const stub = path.join(stubDir, "claude");
    await fs.writeFile(stub, '#!/bin/sh\nprintf "<handover>## Current objective\\nok</handover>\\n"\n', {
      mode: 0o755,
    });
    await fs.chmod(stub, 0o755);
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.seq = 2;
    await fs.appendFile(
      eventsPath(SID),
      JSON.stringify({ seq: 2, at: new Date().toISOString(), kind: "turn_started", turn_id: "turn_1", message: "x" }) + "\n"
    );
    await handleUnexpectedBExit(ctx, 137, null);
    const handover = await fs.readFile(crashHandoverPath(SID), "utf-8");
    expect(handover).toContain("## Current objective");
  });

  it("narrates recover_failed(session_stopping:) when a stop engaged during the crash", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.stopping = true;
    await fs.writeFile(crashHandoverPath(SID), "## Current objective\nresume");
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const fail = events.find(
      (e): e is Extract<Event, { kind: "recover_failed" }> => e.kind === "recover_failed"
    );
    expect(fail?.reason).toMatch(/^session_stopping: /);
    expect(fail?.initiated_by).toBe("auto");
    expect(kindsOf(events).indexOf("recover_failed")).toBeLessThan(
      kindsOf(events).indexOf("session_stopped")
    );
    expect((await readState(statePath(SID)))?.rotated_to).toBeUndefined();
  });

  it("maybeAutoRespawn resolves (never rejects) when the narrated-blocker path's event append fails", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.stopping = true; // narrated-blocker path: session_stopping
    // Force the narration's appendEvent to fail deterministically: replace
    // events.jsonl with a directory of the same name so fs.appendFile
    // rejects (EISDIR). Calls maybeAutoRespawn directly (not through
    // handleUnexpectedBExit) — its own terminal appendEvent would hit the
    // same swapped path and confound the result; this isolates the one
    // guarantee under test: maybeAutoRespawn itself never rejects.
    await fs.rm(eventsPath(SID), { force: true });
    await fs.mkdir(eventsPath(SID));
    await expect(maybeAutoRespawn(ctx)).resolves.toBeUndefined();
  });

  it("skips silently when rotated_to is already set — even with a stop engaged", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.state.rotated_to = "sess_20200101T000000_succ01";
    ctx.stopping = true;
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    expect(kindsOf(events)).toEqual(["session_stopped"]);
  });

  it("narrates max_attempts_exhausted at the default streak budget", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.state.respawn_streak = 2;
    await fs.writeFile(crashHandoverPath(SID), "## Current objective\nresume");
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const fail = events.find(
      (e): e is Extract<Event, { kind: "recover_failed" }> => e.kind === "recover_failed"
    );
    expect(fail?.reason).toMatch(/^max_attempts_exhausted: /);
  });

  it("a below-budget streak respawns and stamps streak+1 on the successor", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.state.respawn_streak = 1;
    await fs.writeFile(crashHandoverPath(SID), "## Current objective\nresume");
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const rec = events.find(
      (e): e is Extract<Event, { kind: "session_recovered" }> => e.kind === "session_recovered"
    );
    expect(rec).toBeDefined();
    expect((await readState(statePath(rec!.new_session_id)))?.respawn_streak).toBe(2);
  });

  it("narrates max_generations with the default cap when no rotation block exists", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.state.generation = 10;
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const fail = events.find(
      (e): e is Extract<Event, { kind: "recover_failed" }> => e.kind === "recover_failed"
    );
    expect(fail?.reason).toMatch(/^max_generations: /);
  });

  it("narrates budget_exceeded when the inherited lineage cost exceeds the cap", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, {
      ...AUTO,
      budget: { max_cost_usd: 5 },
    });
    ctx.state.cost_usd = 6;
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const fail = events.find(
      (e): e is Extract<Event, { kind: "recover_failed" }> => e.kind === "recover_failed"
    );
    expect(fail?.reason).toMatch(/^budget_exceeded: /);
  });

  it("maps a recover error to recover_failed (no handover, no events → no_record:)", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const fail = events.find(
      (e): e is Extract<Event, { kind: "recover_failed" }> => e.kind === "recover_failed"
    );
    expect(fail?.reason).toMatch(/^no_record: /);
    expect(kindsOf(events)[kindsOf(events).length - 1]).toBe("session_stopped");
  });

  it("maps a dead successor spawn to recover_failed(successor_not_ready:)", async () => {
    // /bin/false never touches the ready marker, so recoverSession's
    // waitForReady burns its full 5s budget — this cell's ~5s runtime is by
    // design (vitest testTimeout is 30s). afterEach restores CLAW_DRIVE_BIN.
    process.env.CLAW_DRIVE_BIN = "/bin/false";
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    await fs.writeFile(crashHandoverPath(SID), "## Current objective\nresume");
    await handleUnexpectedBExit(ctx, 137, null);
    const { events } = await readEventsSince(eventsPath(SID), 0);
    const fail = events.find(
      (e): e is Extract<Event, { kind: "recover_failed" }> => e.kind === "recover_failed"
    );
    expect(fail?.reason).toMatch(/^successor_not_ready: /);
    expect((await readState(statePath(SID)))?.rotated_to).toBeUndefined();
  });
});

describe("respawn_streak clear on proof of life (afterEventBookkeeping)", () => {
  it("deletes and persists the streak on a completed turn; absent stays absent", async () => {
    const fake = makeFakeB();
    const ctx = await makeCtx(fake, AUTO);
    ctx.state.respawn_streak = 2;
    await afterEventBookkeeping(ctx, {
      seq: 2,
      at: new Date().toISOString(),
      kind: "turn_completed",
      turn_id: "turn_1",
      stop_reason: "end_turn",
    } as Event);
    expect(ctx.state.respawn_streak).toBeUndefined();
    expect((await readState(statePath(SID)))?.respawn_streak).toBeUndefined();
    const before = await fs.stat(statePath(SID));
    // A same-millisecond rewrite would be invisible to mtimeMs; give the
    // clock one tick so a rewrite MUST move it.
    await new Promise((r) => setTimeout(r, 10));
    await afterEventBookkeeping(ctx, {
      seq: 3,
      at: new Date().toISOString(),
      kind: "turn_completed",
      turn_id: "turn_2",
      stop_reason: "end_turn",
    } as Event);
    expect(ctx.state.respawn_streak).toBeUndefined();
    // The streak was already absent, so the second pass had nothing to
    // persist — state.json must not be rewritten.
    const after = await fs.stat(statePath(SID));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
