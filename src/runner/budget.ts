/**
 * CD-4 — session budget / circuit-breaker tracker.
 *
 * A small extracted unit (modelled on CD-2's decision-timeout extraction) so
 * the aggregate run-level caps are unit-testable without a real claude process.
 * The runner holds one tracker per session, records counter-affecting events,
 * and after each relevant event calls check() with the elapsed wall-clock; a
 * non-null result is the breached cap, which the runner turns into an
 * exit_reason and a teardown.
 */

export type BudgetCap =
  | "max_tool_calls"
  | "max_wall_clock_seconds"
  | "max_consecutive_errors";

export interface Budget {
  max_tool_calls?: number;
  max_wall_clock_seconds?: number;
  max_consecutive_errors?: number;
}

export interface BudgetCounters {
  toolCalls: number;
  elapsedSeconds: number;
  consecutiveErrors: number;
}

/**
 * Pure cap-check. Returns the first breached cap, or null when within budget
 * (or when there is no budget). "Exceeding" a cap is strictly greater than it,
 * so a cap of N permits exactly N. Caps are checked in a stable order:
 * tool_calls, then wall_clock, then consecutive_errors.
 */
export function checkBudget(
  budget: Budget | undefined,
  counters: BudgetCounters
): BudgetCap | null {
  if (!budget) return null;
  if (budget.max_tool_calls !== undefined && counters.toolCalls > budget.max_tool_calls) {
    return "max_tool_calls";
  }
  if (budget.max_wall_clock_seconds !== undefined && counters.elapsedSeconds > budget.max_wall_clock_seconds) {
    return "max_wall_clock_seconds";
  }
  if (budget.max_consecutive_errors !== undefined && counters.consecutiveErrors > budget.max_consecutive_errors) {
    return "max_consecutive_errors";
  }
  return null;
}

/** Map a breached cap to the state.exit_reason / session_stopped reason string. */
export function budgetExceededReason(cap: BudgetCap): string {
  return `budget_exceeded:${cap}`;
}

export interface BudgetTracker {
  /** Cumulative tool-call count +1 (call on tool_call_requested). */
  recordToolCall(): void;
  /** Consecutive-error count +1 (error / turn_failed / is-error tool_call_result). */
  recordError(): void;
  /** Reset the consecutive-error count to 0 (call on a clean turn_completed). */
  recordCleanTurn(): void;
  /** Check the caps against the current counters and the given elapsed seconds. */
  check(elapsedSeconds: number): BudgetCap | null;
  /** Current counter snapshot (wall-clock is supplied per check, not held). */
  readonly counters: { toolCalls: number; consecutiveErrors: number };
}

/**
 * Build a stateful tracker over an optional budget. An undefined budget makes
 * every check a no-op (null), so existing sessions are unaffected.
 */
export function createBudgetTracker(budget: Budget | undefined): BudgetTracker {
  let toolCalls = 0;
  let consecutiveErrors = 0;
  return {
    recordToolCall() {
      toolCalls += 1;
    },
    recordError() {
      consecutiveErrors += 1;
    },
    recordCleanTurn() {
      consecutiveErrors = 0;
    },
    check(elapsedSeconds: number): BudgetCap | null {
      return checkBudget(budget, { toolCalls, elapsedSeconds, consecutiveErrors });
    },
    get counters() {
      return { toolCalls, consecutiveErrors };
    },
  };
}
