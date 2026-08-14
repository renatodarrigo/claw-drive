import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createBudgetTracker,
  checkBudget,
  budgetExceededReason,
  warnCostOf,
  maxCostOf,
  crossedCostWarning,
  type Budget,
} from "../../src/runner/budget.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("checkBudget (pure cap-check)", () => {
  it("returns null when budget is undefined (unlimited)", () => {
    expect(
      checkBudget(undefined, { toolCalls: 1e6, elapsedSeconds: 1e6, consecutiveErrors: 1e6, costUsd: 0 })
    ).toBeNull();
  });

  it("returns null when every cap is within budget (at the cap is not over it)", () => {
    const b: Budget = { max_tool_calls: 10, max_wall_clock_seconds: 100, max_consecutive_errors: 3 };
    expect(checkBudget(b, { toolCalls: 10, elapsedSeconds: 100, consecutiveErrors: 3, costUsd: 0 })).toBeNull();
  });

  it("flags the breached cap (exceeding = strictly greater than the cap)", () => {
    expect(checkBudget({ max_tool_calls: 5 }, { toolCalls: 6, elapsedSeconds: 0, consecutiveErrors: 0, costUsd: 0 })).toBe("max_tool_calls");
    expect(checkBudget({ max_wall_clock_seconds: 5 }, { toolCalls: 0, elapsedSeconds: 5.1, consecutiveErrors: 0, costUsd: 0 })).toBe("max_wall_clock_seconds");
    expect(checkBudget({ max_consecutive_errors: 2 }, { toolCalls: 0, elapsedSeconds: 0, consecutiveErrors: 3, costUsd: 0 })).toBe("max_consecutive_errors");
  });

  it("an absent individual cap is unlimited", () => {
    expect(
      checkBudget({ max_consecutive_errors: 2 }, { toolCalls: 1e6, elapsedSeconds: 1e6, consecutiveErrors: 1, costUsd: 0 })
    ).toBeNull();
  });

  it("checks caps in a stable order (tool_calls, then wall_clock, then consecutive_errors)", () => {
    const b: Budget = { max_tool_calls: 1, max_wall_clock_seconds: 1, max_consecutive_errors: 1 };
    expect(checkBudget(b, { toolCalls: 2, elapsedSeconds: 2, consecutiveErrors: 2, costUsd: 0 })).toBe("max_tool_calls");
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
    expect(t.counters).toEqual({ toolCalls: 1, consecutiveErrors: 1, costUsd: 0 });
  });
});

describe("max_cost_usd (cost-cap)", () => {
  it("checkBudget: at the cap is not over it; strictly-greater breaches", () => {
    const b: Budget = { max_cost_usd: 1.5 };
    expect(checkBudget(b, { toolCalls: 0, elapsedSeconds: 0, consecutiveErrors: 0, costUsd: 1.5 })).toBeNull();
    expect(checkBudget(b, { toolCalls: 0, elapsedSeconds: 0, consecutiveErrors: 0, costUsd: 1.51 })).toBe("max_cost_usd");
  });

  it("checkBudget: cost is checked LAST in the stable order", () => {
    const b: Budget = { max_tool_calls: 1, max_cost_usd: 0.01 };
    expect(
      checkBudget(b, { toolCalls: 2, elapsedSeconds: 0, consecutiveErrors: 0, costUsd: 5 })
    ).toBe("max_tool_calls");
  });

  it("budgetExceededReason maps the new cap", () => {
    expect(budgetExceededReason("max_cost_usd")).toBe("budget_exceeded:max_cost_usd");
  });

  it("tracker: recordCost SETS the lineage total (idempotent, not additive)", () => {
    const t = createBudgetTracker({ max_cost_usd: 1.0 });
    t.recordCost(0.4);
    t.recordCost(0.9); // cumulative reading replaces, does not add
    expect(t.check(0)).toBeNull(); // 0.9 <= 1.0
    t.recordCost(1.01);
    expect(t.check(0)).toBe("max_cost_usd");
  });

  it("tracker: a regressed reading is taken as-is (undercount, no clamp)", () => {
    const t = createBudgetTracker({ max_cost_usd: 1.0 });
    t.recordCost(0.9);
    t.recordCost(0.5);
    expect(t.counters.costUsd).toBe(0.5);
  });

  it("tracker without a budget ignores recordCost", () => {
    const t = createBudgetTracker(undefined);
    t.recordCost(1e9);
    expect(t.check(0)).toBeNull();
  });
});

describe("cost-warning helpers", () => {
  it("warnCostOf / maxCostOf read the budget, bypass and absent blocks read undefined", () => {
    expect(warnCostOf("bypass")).toBeUndefined();
    expect(warnCostOf({})).toBeUndefined();
    expect(warnCostOf({ budget: { warn_cost_usd: 4 } })).toBe(4);
    expect(maxCostOf("bypass")).toBeUndefined();
    expect(maxCostOf({ budget: { warn_cost_usd: 4 } })).toBeUndefined();
    expect(maxCostOf({ budget: { max_cost_usd: 5 } })).toBe(5);
  });
  it("crossedCostWarning: at-or-over crosses; under, unconfigured, and unread never cross", () => {
    expect(crossedCostWarning(4, 4)).toBe(true);
    expect(crossedCostWarning(4, 4.2)).toBe(true);
    expect(crossedCostWarning(4, 3.99)).toBe(false);
    expect(crossedCostWarning(undefined, 100)).toBe(false);
    expect(crossedCostWarning(4, undefined)).toBe(false);
  });
  it("checkBudget ignores warn_cost_usd — a warning line is not a cap", () => {
    expect(checkBudget({ warn_cost_usd: 0.01 }, { toolCalls: 5, elapsedSeconds: 5, consecutiveErrors: 0, costUsd: 100 })).toBeNull();
  });
});

