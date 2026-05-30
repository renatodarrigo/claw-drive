import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  scheduleDecisionTimeout,
  TIMEOUT_DEFER_MESSAGE,
  type DecisionTimeoutOptions,
} from "../../src/runner/decision-timeout.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Build a wiring object with vi.fn() spies for every injected side effect.
 * The unit under test (scheduleDecisionTimeout) is the real implementation;
 * only the runner collaborators it calls (onFire/emit/recordDeferred/resolve)
 * are spies, so each can be asserted independently.
 */
function wiring(
  overrides: Partial<DecisionTimeoutOptions> = {}
): DecisionTimeoutOptions {
  return {
    call_id: "call_1",
    turn_id: "turn_1",
    timeoutMs: 3000,
    defaultAction: "approve",
    onFire: vi.fn(),
    emit: vi.fn(),
    recordDeferred: vi.fn(),
    resolve: vi.fn(),
    ...overrides,
  };
}

describe("scheduleDecisionTimeout", () => {
  it("fires the approve default on timeout: emits resolved_by:timeout and allows the call", async () => {
    const w = wiring({ defaultAction: "approve" });
    scheduleDecisionTimeout(w);

    // Nothing happens before the deadline.
    expect(w.emit).not.toHaveBeenCalled();
    expect(w.resolve).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(w.onFire).toHaveBeenCalledTimes(1);
    expect(w.emit).toHaveBeenCalledTimes(1);
    expect(w.emit).toHaveBeenCalledWith({
      kind: "tool_decision_resolved",
      turn_id: "turn_1",
      call_id: "call_1",
      action: "approve",
      reason: "timeout → default",
      resolved_by: "timeout",
    });
    expect(w.recordDeferred).not.toHaveBeenCalled();
    expect(w.resolve).toHaveBeenCalledTimes(1);
    expect(w.resolve).toHaveBeenCalledWith({ behavior: "allow" });
  });

  it("fires the reject default on timeout: denies the call, no defer bookkeeping", async () => {
    const w = wiring({ defaultAction: "reject" });
    scheduleDecisionTimeout(w);

    await vi.advanceTimersByTimeAsync(3000);

    expect(w.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reject", resolved_by: "timeout" })
    );
    expect(w.recordDeferred).not.toHaveBeenCalled();
    expect(w.resolve).toHaveBeenCalledWith({ behavior: "deny" });
  });

  it("fires the defer default on timeout: records the deferred call and denies with the defer message", async () => {
    const w = wiring({ defaultAction: "defer" });
    scheduleDecisionTimeout(w);

    await vi.advanceTimersByTimeAsync(3000);

    expect(w.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "defer", resolved_by: "timeout" })
    );
    expect(w.recordDeferred).toHaveBeenCalledTimes(1);
    expect(w.resolve).toHaveBeenCalledWith({
      behavior: "deny",
      message: TIMEOUT_DEFER_MESSAGE,
    });
  });

  it("clear() before the deadline cancels the default: nothing fires after advancing past it", async () => {
    const w = wiring({ defaultAction: "approve" });
    const scheduled = scheduleDecisionTimeout(w);

    scheduled.clear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(w.onFire).not.toHaveBeenCalled();
    expect(w.emit).not.toHaveBeenCalled();
    expect(w.recordDeferred).not.toHaveBeenCalled();
    expect(w.resolve).not.toHaveBeenCalled();
  });
});
