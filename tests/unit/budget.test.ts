import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createBudgetTracker,
  checkBudget,
  budgetExceededReason,
  type Budget,
} from "../../src/runner/budget.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("checkBudget (pure cap-check)", () => {
  it("returns null when budget is undefined (unlimited)", () => {
    expect(
      checkBudget(undefined, { toolCalls: 1e6, elapsedSeconds: 1e6, consecutiveErrors: 1e6 })
    ).toBeNull();
  });

  it("returns null when every cap is within budget (at the cap is not over it)", () => {
    const b: Budget = { max_tool_calls: 10, max_wall_clock_seconds: 100, max_consecutive_errors: 3 };
    expect(checkBudget(b, { toolCalls: 10, elapsedSeconds: 100, consecutiveErrors: 3 })).toBeNull();
  });

  it("flags the breached cap (exceeding = strictly greater than the cap)", () => {
    expect(checkBudget({ max_tool_calls: 5 }, { toolCalls: 6, elapsedSeconds: 0, consecutiveErrors: 0 })).toBe("max_tool_calls");
    expect(checkBudget({ max_wall_clock_seconds: 5 }, { toolCalls: 0, elapsedSeconds: 5.1, consecutiveErrors: 0 })).toBe("max_wall_clock_seconds");
    expect(checkBudget({ max_consecutive_errors: 2 }, { toolCalls: 0, elapsedSeconds: 0, consecutiveErrors: 3 })).toBe("max_consecutive_errors");
  });

  it("an absent individual cap is unlimited", () => {
    expect(
      checkBudget({ max_consecutive_errors: 2 }, { toolCalls: 1e6, elapsedSeconds: 1e6, consecutiveErrors: 1 })
    ).toBeNull();
  });

  it("checks caps in a stable order (tool_calls, then wall_clock, then consecutive_errors)", () => {
    const b: Budget = { max_tool_calls: 1, max_wall_clock_seconds: 1, max_consecutive_errors: 1 };
    expect(checkBudget(b, { toolCalls: 2, elapsedSeconds: 2, consecutiveErrors: 2 })).toBe("max_tool_calls");
  });
});

describe("budgetExceededReason", () => {
  it("maps a cap to its exit_reason string", () => {
    expect(budgetExceededReason("max_tool_calls")).toBe("budget_exceeded:max_tool_calls");
    expect(budgetExceededReason("max_wall_clock_seconds")).toBe("budget_exceeded:max_wall_clock_seconds");
    expect(budgetExceededReason("max_consecutive_errors")).toBe("budget_exceeded:max_consecutive_errors");
  });
});

describe("createBudgetTracker — counters + breach", () => {
  it("max_tool_calls: breaches when cumulative tool-calls exceed the cap", () => {
    const t = createBudgetTracker({ max_tool_calls: 2 });
    t.recordToolCall();
    t.recordToolCall();
    expect(t.check(0)).toBeNull(); // 2, not > 2
    t.recordToolCall();
    expect(t.check(0)).toBe("max_tool_calls"); // 3 > 2
  });

  it("max_consecutive_errors: breaches when consecutive errors exceed the cap", () => {
    const t = createBudgetTracker({ max_consecutive_errors: 2 });
    t.recordError();
    t.recordError();
    expect(t.check(0)).toBeNull();
    t.recordError();
    expect(t.check(0)).toBe("max_consecutive_errors");
  });

  it("a clean turn resets the consecutive-error counter", () => {
    const t = createBudgetTracker({ max_consecutive_errors: 2 });
    t.recordError();
    t.recordError(); // 2
    t.recordCleanTurn(); // → 0
    t.recordError(); // 1
    expect(t.check(0)).toBeNull(); // a clean turn then one error does not breach a cap of 2
  });

  it("max_wall_clock_seconds: breaches via elapsed seconds (vitest fake timers)", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const t = createBudgetTracker({ max_wall_clock_seconds: 10 });
    vi.advanceTimersByTime(9_000);
    expect(t.check((Date.now() - start) / 1000)).toBeNull(); // 9s, within
    vi.advanceTimersByTime(2_000);
    expect(t.check((Date.now() - start) / 1000)).toBe("max_wall_clock_seconds"); // 11s > 10
  });

  it("an absent budget never breaches no matter the counters", () => {
    const t = createBudgetTracker(undefined);
    for (let i = 0; i < 1000; i++) {
      t.recordToolCall();
      t.recordError();
    }
    expect(t.check(1e9)).toBeNull();
  });

  it("exposes the current counters", () => {
    const t = createBudgetTracker({ max_tool_calls: 100 });
    t.recordToolCall();
    t.recordError();
    expect(t.counters).toEqual({ toolCalls: 1, consecutiveErrors: 1 });
  });
});
