import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { handleRequest, type RunnerContext } from "../../src/runner/runner.js";
import type { SessionState } from "../../src/lib/state.js";

function fakeCtx(overrides: Partial<RunnerContext> & { policy?: SessionState["policy"] }): RunnerContext {
  const state: SessionState = {
    session_id: "sess_test",
    status: "ready",
    cwd: "/tmp/x",
    policy: overrides.policy ?? { rotation: { threshold_tokens: 100000 } },
    decision_timeout_seconds: 3600,
    model: null,
    runner_pid: 1,
    started_at: new Date().toISOString(),
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
  };
  return {
    sessionId: "sess_test",
    state,
    b: {} as ChildProcess,
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
    bootstrapExceeded: false,
    rotating: false,
    turnWaiters: new Map(),
    ...overrides,
  } as RunnerContext;
}

const ROTATE = { id: "t", op: "rotate" as const };

describe("rotate op — pre-I/O gate paths", () => {
  it("errors NO_ROTATION_CONFIG without a rotation block", async () => {
    const resp = await handleRequest(fakeCtx({ policy: "bypass" }), ROTATE);
    expect(resp).toMatchObject({ ok: false, error: "NO_ROTATION_CONFIG" });
  });

  it("errors TURN_IN_FLIGHT mid-turn", async () => {
    const resp = await handleRequest(fakeCtx({ turnInFlight: true }), ROTATE);
    expect(resp).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
  });

  it("errors DECISIONS_PENDING naming the call_ids", async () => {
    const ctx = fakeCtx({});
    ctx.pendingApprovals.set("toolu_9", {} as never);
    const resp = await handleRequest(ctx, ROTATE);
    expect(resp).toMatchObject({ ok: false, error: "DECISIONS_PENDING" });
    expect((resp as { message: string }).message).toContain("toolu_9");
  });

  it("errors ROTATION_IN_PROGRESS on re-entry", async () => {
    const resp = await handleRequest(fakeCtx({ rotating: true }), ROTATE);
    expect(resp).toMatchObject({ ok: false, error: "ROTATION_IN_PROGRESS" });
  });
});
