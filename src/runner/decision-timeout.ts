import type { DecisionAction, Event } from "../lib/events.js";

/**
 * The tool_decision_resolved payload the unit builds when the timeout fires.
 * seq/at are stamped by the runner's emit sink (emitEvent), so the unit
 * produces everything except those two fields.
 */
export type TimeoutResolvedEvent = Omit<
  Extract<Event, { kind: "tool_decision_resolved" }>,
  "seq" | "at"
>;

/**
 * Wiring for a single escalated decision's timeout. The unit owns the timer
 * and the resolved-by-timeout semantics (which event to emit, which behaviour
 * to apply); every side effect that touches runner state is an injected
 * callback so the unit is deterministically testable with fake timers.
 */
export interface DecisionTimeoutOptions {
  /** The escalated call's id, echoed into the resolved event. */
  call_id: string;
  /** The in-flight turn id, echoed into the resolved event. */
  turn_id: string;
  /** How long to wait before firing the default action. */
  timeoutMs: number;
  /** The rule's default action, fired when the human doesn't resolve in time. */
  defaultAction: DecisionAction;
  /**
   * Drop the call from pendingApprovals. Invoked synchronously on fire,
   * before emit — mirrors the inline order so a manual resolve racing during
   * the (async) emit still finds nothing pending, exactly as before.
   */
  onFire: () => void;
  /** Sink for the resolved-by-timeout event the unit builds (e.g. emitEvent). */
  emit: (event: TimeoutResolvedEvent) => void | Promise<void>;
  /** Record the deferred call. Invoked only for a defer default, before resolve. */
  recordDeferred: () => void;
  /** Release the paused approver with the default action's behaviour/message. */
  resolve: (resolution: { behavior: "allow" | "deny"; message?: string }) => void;
}

export interface ScheduledDecisionTimeout {
  /** Cancel the pending default-action firing — call when the decision is resolved manually. */
  clear: () => void;
}

/** Default-deny message handed to B when a defer default fires on timeout. */
export const TIMEOUT_DEFER_MESSAGE =
  "DEFERRED (timeout default). Human will run this; wait for a follow-up user turn.";

/**
 * Schedule the default action for an escalated decision and return a handle
 * whose clear() cancels it. On fire (after timeoutMs): drop the call from
 * pending, emit tool_decision_resolved(resolved_by:"timeout"), and apply the
 * default action — allow for approve, deny for reject, and deny + record the
 * deferred call for defer.
 */
export function scheduleDecisionTimeout(
  opts: DecisionTimeoutOptions
): ScheduledDecisionTimeout {
  const timer = setTimeout(async () => {
    opts.onFire();
    await opts.emit({
      kind: "tool_decision_resolved",
      turn_id: opts.turn_id,
      call_id: opts.call_id,
      action: opts.defaultAction,
      reason: "timeout → default",
      resolved_by: "timeout",
    });

    if (opts.defaultAction === "defer") {
      opts.recordDeferred();
      opts.resolve({ behavior: "deny", message: TIMEOUT_DEFER_MESSAGE });
      return;
    }

    opts.resolve({
      behavior: opts.defaultAction === "approve" ? "allow" : "deny",
    });
  }, opts.timeoutMs);

  return { clear: () => clearTimeout(timer) };
}
