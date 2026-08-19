import * as fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import {
  eventsPath,
  mcpConfigPath,
  readyMarkerPath,
  runnerPidPath,
  settingsPath,
  socketPath,
  statePath,
  handoverPath,
  crashHandoverPath,
  sessionDir,
  clawDriveBinPath,
} from "../lib/paths.js";
import { readState, writeState, type SessionState } from "../lib/state.js";
import * as path from "node:path";
import { appendEvent, readEventsSince, type Event } from "../lib/events.js";
import { policyDigest, matchPolicy, validatePolicy, coercePolicy, planResolveRemember, compositionDenyMessage, type DecisionAction, type Policy, type PolicyObject } from "../lib/policy.js";
import { parseClaudeLine } from "./stream-parser.js";
import { startSocketServer } from "./socket-server.js";
import { buildClaudeArgs } from "./runner-args.js";
import { scheduleDecisionTimeout } from "./decision-timeout.js";
import { createBudgetTracker, budgetExceededReason, warnCostOf, maxCostOf, crossedCostWarning, type BudgetTracker } from "./budget.js";
import { rotationConfigOf, isOverThreshold, checkRotateGate, effectiveMaxGenerations, INTERRUPT_GRACE_MS, shouldAttemptAutoRotation, autoOutcomeLatches, respawnConfigOf, checkRespawnGate } from "./context-tracker.js";
import { buildHandoverInstruction, extractHandover, composeSuccessorBrief } from "../lib/handover.js";
import { buildCrashDigest, buildDistillerPrompt, runDistiller } from "../lib/distill.js";
import { newSessionId, readSessionMcpServers, scaffoldSessionDir, spawnRunnerDetached, waitForReady } from "../lib/spawn-session.js";
import { recoverSession } from "../lib/recover.js";
import type { ControlRequest, ControlResponse } from "../lib/socket-protocol.js";
import { buildDecisionContext } from "../lib/decision-context.js";
import { installRunnerLogCapture } from "../lib/runner-log.js";

/** CD-8: the most recent assistant_text in `turnId`, scanning the session's events back-to-front. */
async function findPriorAssistantText(sessionId: string, turnId: string): Promise<string | undefined> {
  const { events } = await readEventsSince(eventsPath(sessionId), 0);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" && (e as { turn_id?: string }).turn_id === turnId) {
      return (e as { text: string }).text;
    }
  }
  return undefined;
}

/**
 * CD-8: rationale (preceding assistant_text) + diff (Edit/Write) for an escalated
 * call, capped at source. Exported + dependency-light (sessionId + cwd, not the
 * full RunnerContext) so it's unit-testable against a synthetic CLAW_DRIVE_HOME.
 */
export async function buildEscalationContext(
  sessionId: string,
  cwd: string,
  turnId: string,
  tool: string,
  args: unknown
): Promise<{ rationale?: string; diff?: string }> {
  const priorAssistantText = await findPriorAssistantText(sessionId, turnId);
  let existingFileContent: string | undefined;
  if (tool === "Write") {
    const fp = (args as { file_path?: unknown } | null)?.file_path;
    if (typeof fp === "string") {
      try {
        existingFileContent = await fs.readFile(path.resolve(cwd, fp), "utf-8");
      } catch {
        existingFileContent = undefined;
      }
    }
  }
  return buildDecisionContext({ tool, args, priorAssistantText, existingFileContent });
}

interface DeferredCall {
  call_id: string;
  turn_id: string;
  tool: string;
  args: Record<string, unknown>;
  deferred_at: string;
  reason: string;
}

export interface RunnerContext {
  sessionId: string;
  state: SessionState;
  b: ChildProcess;
  currentTurnId: string | null;
  seq: number;
  pendingApprovals: Map<string, PendingApproval>;
  deferredCalls: Map<string, DeferredCall>;
  /** Set to true by stop_session handler so the main loop's b.on("exit") yields. */
  stopping: boolean;
  /** CD-4 run-level circuit-breaker; null when no budget is configured. */
  budget: BudgetTracker | null;
  /** Set once a budget cap is breached so the breaker fires exactly once. */
  budgetBreached: boolean;
  /** context-rotation rotation tracking. lastContextTokens: latest main-loop usage reading
   * (null until the first assistant line with usage). completedTurns counts
   * turn_completed events. turnInFlight flips on send/provide and off on
   * turn_completed/turn_failed. firstTurnContextTokens is the context reading
   * of the FIRST completed turn (null until then); the bootstrap gate
   * recomputes it against the CURRENT threshold so a live update_policy raise
   * takes effect without a restart. rotating guards re-entry and
   * suppresses threshold re-fires during the handover turn. turnWaiters lets
   * the rotate choreography await a specific turn's completion. */
  lastContextTokens: number | null;
  /** Cost-cap: latest cumulative USD reading from B's result lines, stamped
   * in runStdoutLoop whenever a result line carries a finite total_cost_usd
   * (null until then). Write-only — nothing reads it back anywhere. cost_usd
   * (the lineage total) is stamped at that same site from the reading
   * directly, not derived from this field. One test sets it directly as
   * setup, to assert afterEventBookkeeping does not derive cost_usd from
   * it. */
  lastCostUsd: number | null;
  completedTurns: number;
  turnInFlight: boolean;
  firstTurnContextTokens: number | null;
  rotating: boolean;
  turnWaiters: Map<string, (outcome: "completed" | "failed") => void>;
  /** Set synchronously the moment B's exit is observed, on any path (see
   * observeBExit for the enumeration of call sites). Once true no turn can
   * ever terminate again — handover attempts and the rotate choreography
   * must fail fast instead of waiting out turn timeouts. */
  bExited: boolean;
  /** Latched synchronously at handleUnexpectedBExit's entry — distinct from
   * bExited, which also latches on the stop path (a B death raced against a
   * pending stop) and so does not by itself imply the crash path is running.
   * teardownSession's early-return keys on this flag alone: the crash path
   * owns this teardown whenever it is set. */
  crashTeardownEngaged: boolean;
  /** Set by teardownSession's first engagement; later engagements (a second
   * stop, a signal after a stop) are no-ops instead of re-arming timers or
   * double-emitting the terminal event. */
  tearingDown: boolean;
  /** Epoch ms of the last interrupt_turn SIGINT; null when none happened or a
   * later turn_completed proved B alive. Gates rotate (INTERRUPT_GRACE) —
   * an interrupted claude process can exit on its next turn. */
  lastInterruptAt: number | null;
  /** Resolves when the in-flight rotate op settles (success, refusal, or
   * failure). The crash teardown and teardownSession's finish await this
   * (bounded) before writing session_stopped: the rotate op is the single
   * owner of rotation-outcome events, and the terminal event must come last.
   * Null when no rotate is in flight. */
  rotationSettled: Promise<void> | null;
  /** The id of the rotation choreography's own in-flight handover send — the
   * one send_turn the rotating-guard admits. Null outside that window. */
  rotationSendId: string | null;
  /** Auto-rotation one-shot latch: set after an auto attempt ends in a policy
   * refusal or a failure (autoOutcomeLatches) — both are futile or expensive
   * to retry — cleared by an update_policy that changes the rotation block.
   * An attempt that settles under a stale rotationPolicyEpoch never latches.
   * Manual rotate never consults it. */
  autoRotateLatched: boolean;
  /** Cost warning once-per-process latch: set when cost_threshold_reached is
   * emitted; cleared by an update_policy that changes warn_cost_usd. */
  costWarned: boolean;
  /** Rotation-config generation: bumped by every update_policy that CHANGES
   * the rotation block — the same condition that re-arms autoRotateLatched.
   * maybeAutoRotate captures it at dispatch and compares before latching in
   * .then and .catch alike, so the latch may only encode an outcome produced
   * under the current rotation config; a stale attempt settles without
   * latching and the next boundary retries under the new config. */
  rotationPolicyEpoch: number;
}

// Placeholder type; populated in Task 13 when the approval flow lands.
interface PendingApproval {
  call_id: string;
  turn_id: string;
  tool: string;
  args: Record<string, unknown>;
  default_action: DecisionAction;
  resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
}

/**
 * Append an event to events.jsonl with auto-assigned seq + at, and update
 * last_event_at in state.json. Only called from the runner's single-writer
 * context — no locking needed.
 */
async function emitEvent(
  ctx: RunnerContext,
  partial: Omit<Event, "seq" | "at">
): Promise<void> {
  ctx.seq += 1;
  const ev = { ...partial, seq: ctx.seq, at: new Date().toISOString() } as Event;
  await appendEvent(eventsPath(ctx.sessionId), ev);
  ctx.state.last_event_at = ev.at;
  await writeState(statePath(ctx.sessionId), ctx.state);
  await enforceBudget(ctx, ev);
}

/**
 * Tear down Session B: stop input, escalate SIGTERM→SIGKILL, and on exit write
 * the terminal state + a session_stopped(reason) event and exit the runner.
 * Shared by the stop_session control op, the CD-4 budget breaker, the rotate
 * choreography's self-stop, and the runner's signal handlers. Idempotent — a
 * second stop or signal never re-arms timers or double-emits — and safe
 * against a B that is already dead (the once("exit") of a dead child never
 * fires; waiting on it is how a stop used to wedge forever). When a rotate op
 * is in flight, the terminal record holds (bounded) until it settles, so the
 * rotation outcome is recorded first. Exported for unit tests; production
 * callers are all module-internal.
 */
export function teardownSession(ctx: RunnerContext, reason: string): void {
  ctx.stopping = true;
  if (ctx.tearingDown) return;
  ctx.tearingDown = true;
  if (ctx.crashTeardownEngaged) {
    // The crash teardown (handleUnexpectedBExit → runRunner's exit path)
    // already owns the terminal record and the process exit. bExited alone
    // does NOT imply this — a B death raced against a pending stop also
    // latches bExited (main-loop exit handler), but never engages the crash
    // choreography, so this dead-B teardown must still finish below.
    return;
  }
  const finish = async (code: number | null) => {
    if (ctx.rotationSettled) {
      // An in-flight rotate op owns the rotation-outcome event; hold the
      // terminal record until it settles (bounded) so the outcome is
      // recorded first — crash-path parity.
      await Promise.race([ctx.rotationSettled, sleepTimeout(ROTATION_SETTLE_HOLD_MS)]);
    }
    try {
      ctx.state.status = "stopped";
      ctx.state.exit_code = code;
      await writeState(statePath(ctx.sessionId), ctx.state);
      await emitEvent(ctx, {
        kind: "session_stopped",
        reason,
        exit_code: code,
      } as Omit<Event, "seq" | "at">);
      await fs.rm(readyMarkerPath(ctx.sessionId), { force: true });
    } catch {
      // A failed terminal write (dir gone, disk full) must not leave the
      // runner alive-but-wedged as an unhandled rejection.
      process.exit(1);
    }
    process.exit(0);
  };
  if (ctx.b.exitCode !== null || ctx.b.signalCode !== null) {
    // B died without the crash path running (it exited on the same tick a
    // stop landed, before any listener registered) — the terminal record
    // must still be written; an exit event will never be observed.
    observeBExit(ctx);
    void finish(ctx.b.exitCode);
    return;
  }
  try {
    ctx.b.stdin?.end();
  } catch { /* */ }
  const killSigterm = setTimeout(() => {
    if (ctx.b.pid) {
      try { process.kill(ctx.b.pid, "SIGTERM"); } catch { /* */ }
    }
  }, 10_000);
  const killSigkill = setTimeout(() => {
    if (ctx.b.pid) {
      try { process.kill(ctx.b.pid, "SIGKILL"); } catch { /* */ }
    }
  }, 20_000);
  ctx.b.once("exit", (code) => {
    // Record the exit here too. The socket serves before runRunner attaches
    // its own b.on("exit"), so a stop landing in that boot window leaves this
    // handler as the SOLE observer of B's death — without this the invariant
    // ("every exit path observes B's exit") would hold only by sibling-
    // listener ordering. observeBExit latches once, so double-observation
    // alongside that sibling is a no-op by design.
    observeBExit(ctx);
    clearTimeout(killSigterm);
    clearTimeout(killSigkill);
    void finish(code);
  });
}

/**
 * CD-4 circuit-breaker. Update the budget counters for this event, then check
 * the caps; on the first breach set exit_reason, emit an error describing it,
 * and reap B via the shared teardown. No-op without a budget, once a breach is
 * recorded, or once a stop is already in flight.
 */
export async function enforceBudget(ctx: RunnerContext, ev: Event): Promise<void> {
  // bExited: nothing is left to enforce against a dead B, and a breach here
  // would clobber the crash teardown's exit_reason and re-enter teardown.
  if (!ctx.budget || ctx.budgetBreached || ctx.stopping || ctx.bExited) return;
  switch (ev.kind) {
    case "tool_call_requested":
      ctx.budget.recordToolCall();
      break;
    case "error":
    case "turn_failed":
      ctx.budget.recordError();
      break;
    case "tool_call_result":
      if (ev.is_error) ctx.budget.recordError();
      break;
    case "turn_completed":
      ctx.budget.recordCleanTurn();
      break;
  }
  const startedMs = Date.parse(ctx.state.started_at);
  const elapsedSeconds = Number.isFinite(startedMs) ? (Date.now() - startedMs) / 1000 : 0;
  const cap = ctx.budget.check(elapsedSeconds);
  if (!cap) return;

  // Record the breach before emitting so the nested emit below short-circuits.
  ctx.budgetBreached = true;
  ctx.state.exit_reason = budgetExceededReason(cap);
  await emitEvent(ctx, {
    kind: "error",
    message: `session budget exceeded: ${cap} — reaping the session (exit_reason: ${ctx.state.exit_reason})`,
    recoverable: false,
  } as Omit<Event, "seq" | "at">);
  teardownSession(ctx, ctx.state.exit_reason);
}

/**
 * Read-loop over B's stdout: each line is claude stream-json, fed through
 * parseClaudeLine and emitted as Events to events.jsonl.
 *
 * The `currentTurnId` on ctx is stamped on parsed events so each event is
 * associated with the in-flight user turn (set by the send_turn handler in
 * Task 12). If no turn is in flight (e.g. during startup before any user
 * turn), events are stamped with turn_id "turn_unknown".
 */
export async function runStdoutLoop(ctx: RunnerContext): Promise<void> {
  const stdout = ctx.b.stdout!;
  stdout.setEncoding("utf-8");
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        await emitEvent(ctx, {
          kind: "error",
          message: "unparseable stream-json line",
          recoverable: true,
        } as Omit<Event, "seq" | "at">);
        continue;
      }
      const out = parseClaudeLine(parsed, ctx.currentTurnId ?? "turn_unknown");
      if (out.main_context_tokens !== undefined) {
        ctx.lastContextTokens = out.main_context_tokens;
      }
      if (out.cumulative_cost_usd !== undefined) {
        ctx.lastCostUsd = out.cumulative_cost_usd;
        // Lineage total, maintained at the source and recorded BEFORE the
        // same line's events are emitted: the turn_completed/turn_failed
        // carried by this very result line is enforced against the updated
        // total, the same line's writeState persists the stamp, and a
        // breach's terminal state always carries the reading that tripped
        // it — failed turns included (error results carry cost too).
        const lineageTotal = (ctx.state.cost_usd_base ?? 0) + out.cumulative_cost_usd;
        ctx.state.cost_usd = lineageTotal;
        ctx.budget?.recordCost(lineageTotal);
      }
      if (out.compact_boundary) {
        // Native auto-compact won the race (or rotation isn't configured).
        ctx.state.compactions = (ctx.state.compactions ?? 0) + 1;
        await writeState(statePath(ctx.sessionId), ctx.state);
      }
      for (const partial of out.events) {
        await emitEvent(ctx, partial as Omit<Event, "seq" | "at">);
        await afterEventBookkeeping(ctx, partial as Event);
      }
    }
  }
}

/**
 * Cost-warning check, run at every turn boundary — completed AND failed
 * (error results carry cost; a session burning money through failing turns
 * warns the same). Fires once per runner process: the crossing is one fact,
 * and each successor announces the inherited pressure once in its own
 * stream. Cleared by an update_policy that changes warn_cost_usd. Latched
 * before emitting, the breaker's own ordering.
 */
async function maybeWarnCost(ctx: RunnerContext, turnId: string | undefined): Promise<void> {
  if (ctx.costWarned) return;
  const warn = warnCostOf(ctx.state.policy);
  if (!crossedCostWarning(warn, ctx.state.cost_usd)) return;
  ctx.costWarned = true;
  const maxCost = maxCostOf(ctx.state.policy);
  await emitEvent(ctx, {
    kind: "cost_threshold_reached",
    ...(turnId !== undefined ? { turn_id: turnId } : {}),
    cost_usd: ctx.state.cost_usd as number,
    warn_cost_usd: warn as number,
    generation: ctx.state.generation ?? 1,
    ...(maxCost !== undefined ? { max_cost_usd: maxCost } : {}),
  } as Omit<Event, "seq" | "at">);
}

/**
 * context-rotation turn-boundary bookkeeping, run after each parsed event is emitted:
 * maintains turnInFlight / completedTurns / turnWaiters, persists
 * context_tokens, records the first completed turn's reading for the
 * bootstrap gate, and re-fires context_threshold_reached on every completed
 * turn while above threshold (suppressed during the rotate choreography's
 * own handover turn).
 */
export async function afterEventBookkeeping(ctx: RunnerContext, ev: Event): Promise<void> {
  if (ev.kind !== "turn_completed" && ev.kind !== "turn_failed") return;
  ctx.turnInFlight = false;
  const turnId = (ev as { turn_id?: string }).turn_id;
  if (turnId) {
    const waiter = ctx.turnWaiters.get(turnId);
    if (waiter) {
      ctx.turnWaiters.delete(turnId);
      waiter(ev.kind === "turn_completed" ? "completed" : "failed");
    }
  }
  await maybeWarnCost(ctx, turnId);
  if (ev.kind !== "turn_completed") return;
  // Proof of life: a COMPLETED turn means B survived any earlier interrupt —
  // clear the rotate gate's grace window. A failed turn proves nothing (the
  // dogfood's post-interrupt abort WAS a turn_failed, seconds before B died).
  ctx.lastInterruptAt = null;
  ctx.completedTurns += 1;
  if (ctx.state.respawn_streak !== undefined) {
    // Crash auto-respawn proof of life: a completed turn resets the
    // consecutive-respawn streak. Persisted at once so state.json stays
    // truthful for external readers; the crash path itself reads the
    // in-memory copy.
    delete ctx.state.respawn_streak;
    await writeState(statePath(ctx.sessionId), ctx.state);
  }
  if (ctx.lastContextTokens !== null) {
    // cost_usd is stamped at the reading site (runStdoutLoop) and at
    // scaffold birth — nothing cost-shaped left to do at the turn boundary.
    ctx.state.context_tokens = ctx.lastContextTokens;
    await writeState(statePath(ctx.sessionId), ctx.state);
  }
  if (ctx.completedTurns === 1) {
    // Store the reading unconditionally — whether or not it's over
    // threshold, and regardless of whether rotation is configured yet (a
    // later update_policy may add a rotation block, and the bootstrap gate
    // still needs this turn's reading to check against it). The gate is
    // what judges the reading against the — possibly since-raised —
    // threshold, not this bookkeeping step.
    ctx.firstTurnContextTokens = ctx.lastContextTokens;
  }
  const cfg = rotationConfigOf(ctx.state.policy);
  if (!cfg) return;
  const over = isOverThreshold(cfg, ctx.lastContextTokens);
  if (over && !ctx.rotating) {
    await emitEvent(ctx, {
      kind: "context_threshold_reached",
      turn_id: turnId,
      context_tokens: ctx.lastContextTokens as number,
      threshold_tokens: cfg.threshold_tokens,
      generation: ctx.state.generation ?? 1,
    } as Omit<Event, "seq" | "at">);
    maybeAutoRotate(ctx);
  }
}

/**
 * Auto-rotation dispatch, run at an over-threshold completed-turn boundary.
 * Advisory pre-check only — the rotate gate inside performRotation is the
 * single authority: a transient blocker there (a send won the race, decisions
 * pending) returns without an event and the next boundary retries for free.
 * Policy refusals and failures latch further attempts off (autoOutcomeLatches)
 * until an update_policy changes the rotation block — a crashed attempt
 * latches the same way, since retrying an attempt that just threw is no more
 * promising than retrying a policy refusal.
 * Latching is epoch-guarded: the attempt captures rotationPolicyEpoch at
 * dispatch and latches only if the rotation config is unchanged when it
 * settles — a stale outcome settles without latching and the next
 * boundary retries under the new config.
 * Dispatched via setImmediate —
 * the choreography's handover turn needs the stdout loop this bookkeeping
 * runs inside, so it must never be awaited from here.
 */
function maybeAutoRotate(ctx: RunnerContext): void {
  if (
    !shouldAttemptAutoRotation({
      cfg: rotationConfigOf(ctx.state.policy),
      contextTokens: ctx.lastContextTokens,
      latched: ctx.autoRotateLatched,
      rotating: ctx.rotating,
    })
  ) {
    return;
  }
  setImmediate(() => {
    // Captured in the same synchronous segment as performRotation's entry
    // config read: an outcome may latch only if the rotation config it ran
    // under is still current when it settles — on the .catch path too, since
    // a crash under a stale config is no evidence about the new one.
    const epoch = ctx.rotationPolicyEpoch;
    void performRotation(ctx, "auto")
      .then((out) => {
        if (!out.ok && autoOutcomeLatches(out.error) && ctx.rotationPolicyEpoch === epoch) {
          ctx.autoRotateLatched = true;
        }
      })
      .catch(() => {
        if (ctx.rotationPolicyEpoch === epoch) ctx.autoRotateLatched = true;
      });
  });
}

const HANDOVER_TURN_TIMEOUT_MS = 600_000;
/** Bound on how long a terminal record waits for an in-flight rotate op to
 * settle (crash path and teardown finish alike). Every rotate path fails
 * fast once bExited/stopping is set, so the bound has ample headroom. */
const ROTATION_SETTLE_HOLD_MS = 30_000;
/**
 * After a timed-out attempt's SIGINT, how long to wait for the INTERRUPTED
 * turn to actually terminate before giving up on it. See runHandoverTurn's
 * docstring for why this can't just be skipped.
 */
const HANDOVER_INTERRUPT_GRACE_MS = 15_000;

function sleepTimeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    t.unref();
  });
}

/** Concatenated assistant_text of one turn, read back from events.jsonl (CD-8 pattern). */
async function turnAssistantText(sessionId: string, turnId: string): Promise<string> {
  const { events } = await readEventsSince(eventsPath(sessionId), 0);
  return events
    .filter((e) => e.kind === "assistant_text" && (e as { turn_id?: string }).turn_id === turnId)
    .map((e) => (e as { text: string }).text)
    .join("\n");
}

/**
 * Context rotation: inject the handover instruction as a normal user turn, await its
 * completion (via turnWaiters), and extract the <handover> body. Two attempts,
 * 600s each; a timed-out attempt SIGINTs B (interrupt_turn semantics) before
 * the retry.
 *
 * Every parsed stdout line is stamped with ctx.currentTurnId AT PARSE TIME, and
 * send_turn flips currentTurnId synchronously. So after a timeout+SIGINT we
 * must NOT immediately advance to attempt 2's send_turn — the interrupted
 * turn's own terminating output may still be in flight, and if it arrives
 * after currentTurnId has already flipped, it gets mis-stamped with attempt
 * 2's turn id: mis-resolving attempt 2's waiter with the wrong outcome, or
 * bleeding stray text into attempt 2's extracted transcript. Instead we grant
 * the INTERRUPTED turn a bounded grace period (on its own still-registered
 * waiter) to actually terminate before proceeding. If it never does (wedged),
 * we abort the rotation entirely rather than risk a second send_turn racing
 * the still-in-flight first one — returning null here, same as the
 * both-attempts-exhausted case, so the caller leaves B running (the guiding
 * invariant).
 *
 * `flags`, if given, is set to `{ wedged: true }` on the wedged-abort path
 * specifically (distinct from the genuine both-attempts-no-markers failure)
 * so the caller can report a truthful reason instead of a generic one that
 * implies attempt 2 ran when it never did. `bExited`/`stopping` are set
 * wherever a death or an engaging stop/breaker teardown is what actually
 * aborted the rotation — the loop-top guard, and the fall-through after
 * both attempts (which also catches one the loop-top guard structurally
 * cannot: attempt 2 dying in its own post-interrupt settle sleep, since
 * attempt 2 is the loop's last iteration). A send refused mid-attempt (B
 * died in the turn_started-append race the entry guard cannot cover) also
 * aborts through that same fall-through: the attempt breaks out of the loop
 * immediately, dropping its never-resolvable waiter, rather than racing the
 * full attempt timeout for a turn that was never written to B.
 */
async function runHandoverTurn(
  ctx: RunnerContext,
  flags?: { wedged?: boolean; bExited?: boolean; stopping?: boolean }
): Promise<string | null> {
  for (const attempt of [1, 2] as const) {
    if (ctx.bExited || ctx.stopping) {
      // B is dead (observeBExit fails the pending waiter), or a stop/breaker
      // teardown is in flight and stdin may already be ended. This can
      // already hold before attempt 1 ever sends a turn (e.g. a stop
      // latched just as rotate began), not only after a killed attempt
      // loops back here for attempt 2. Never send another turn at a closed
      // stdin, and never wait out a turn timeout that cannot fire.
      // Precedence: a stop/breaker teardown that OWNS the exit is the
      // truthful cause when both flags hold — B's exit is that teardown's own
      // doing (stdin EOF races the real process's exit ahead of this check,
      // dogfood e2e). A crash owns the exit whenever crashTeardownEngaged is
      // set, and a stop landing inside the crash teardown's settle-hold marks
      // ctx.stopping before deferring to it — so that cell, like the bare
      // crash, must report the death (and its "use recover" hint).
      if (flags) {
        if (ctx.stopping && !ctx.crashTeardownEngaged) flags.stopping = true;
        else flags.bExited = true;
      }
      return null;
    }
    const turnId = `turn_${ctx.state.turns + 1}`;
    const done = new Promise<"completed" | "failed">((resolve) =>
      ctx.turnWaiters.set(turnId, resolve)
    );
    ctx.rotationSendId = `handover_${attempt}`;
    const resp = await handleRequest(ctx, {
      id: `handover_${attempt}`,
      op: "send_turn",
      message: buildHandoverInstruction({ attempt }),
    }).finally(() => {
      ctx.rotationSendId = null;
    });
    if (!resp.ok) {
      // The send refused (dead-B SESSION_EXITED surface) — no turn was
      // written to B, so nothing can ever resolve this attempt's waiter
      // except an exit-path flush that may not have seen it. Never race a
      // waiter for a turn that was refused: drop it and fall through to the
      // selector below the loop, which reports the truthful reason.
      ctx.turnWaiters.delete(turnId);
      break;
    }
    const outcome = await Promise.race([done, sleepTimeout(HANDOVER_TURN_TIMEOUT_MS)]);
    if (outcome === "timeout") {
      if (ctx.b.pid) {
        try { process.kill(ctx.b.pid, "SIGINT"); } catch { /* already dead */ }
      }
      // Grace period on the SAME waiter — the interrupted turn's id is still
      // current, so its real terminating event (if it ever arrives) resolves
      // `done` via afterEventBookkeeping, which also deletes the map entry.
      const grace = await Promise.race([done, sleepTimeout(HANDOVER_INTERRUPT_GRACE_MS)]);
      ctx.turnWaiters.delete(turnId); // no-op if afterEventBookkeeping already resolved+deleted it
      if (grace === "timeout") {
        // Wedged: B never acknowledged the interrupt. Abort rather than let a
        // second send_turn race the still-unterminated first one.
        if (flags) flags.wedged = true;
        return null;
      }
      // Ignore the interrupted turn's actual outcome (completed or failed) —
      // attempt 2 starts fresh regardless. But give B the same settle window
      // the rotate gate enforces after an external interrupt
      // (INTERRUPT_GRACE_MS): a just-SIGINT'd claude can exit on its very
      // next stdin message (dogfood 2026-08-04) — sending attempt 2
      // immediately would reproduce exactly that kill pattern. After
      // attempt 1's own settle here, the loop-top bExited/stopping guard
      // covers a death or an engaging stop/breaker teardown during it, on
      // attempt 2's next pass. Attempt 2 has no such next pass — see the
      // fall-through check below the loop.
      await sleepTimeout(INTERRUPT_GRACE_MS);
      continue;
    }
    ctx.turnWaiters.delete(turnId); // no-op (afterEventBookkeeping already deleted it on resolve)
    if (outcome === "failed") continue;
    const handover = extractHandover(await turnAssistantText(ctx.sessionId, turnId));
    if (handover) return handover;
  }
  // Both attempts exhausted with no handover ever extracted. This is also
  // where attempt 2 lands if IT timed out, got SIGINT'd, and B died (or a
  // stop/breaker teardown engaged) during attempt 2's OWN post-interrupt
  // settle sleep above: attempt 2 is the loop's last iteration, so unlike
  // the same window after attempt 1, there is no third loop-top pass to
  // observe it. Apply the identical selector here so that case still
  // reports the truthful reason instead of the generic no-handover one; a
  // genuine both-attempts exhaustion with B still alive and not stopping
  // leaves flags untouched, exactly as before.
  if (flags && (ctx.bExited || ctx.stopping)) {
    if (ctx.stopping && !ctx.crashTeardownEngaged) flags.stopping = true;
    else flags.bExited = true;
  }
  return null;
}

export type RotationOutcome =
  | {
      ok: true;
      result: {
        new_session_id: string;
        alias?: string;
        generation: number;
        handover_path: string;
        watch_command: string;
      };
    }
  | { ok: false; error: string; message: string };

/**
 * The rotate choreography, callable by the rotate request handler and by the
 * auto-rotation dispatch alike: gate → refusal choreography (terminal
 * handover at the cap) → handover turn → successor scaffold → lineage
 * pointer → session_rotated → predecessor self-teardown, with the
 * compensation and settle lifecycle unchanged. Returns a structured outcome;
 * the request handler maps it onto the response envelope. initiatedBy stamps
 * every outcome event (initiated_by).
 */
export async function performRotation(ctx: RunnerContext, initiatedBy: "manual" | "auto"): Promise<RotationOutcome> {
  if (ctx.bExited) {
    // Checked BEFORE the gate: a death that killed an in-flight turn
    // leaves turnInFlight latched, and TURN_IN_FLIGHT's "retry at the
    // turn boundary" advice is unfollowable on a dead session. Keyed on
    // bExited alone, however it latched — a crash (teardown in flight),
    // or a stop/breaker teardown that already observed B's exit. Either
    // way the session process is gone and its events are terminal — a
    // rotation can never start. Plain error, no event.
    return {
      ok: false,
      error: "ROTATION_FAILED",
      message: "session process has exited; rotation cannot start — use recover",
    };
  }
  const cfg = rotationConfigOf(ctx.state.policy);
  const blocker = checkRotateGate({
    cfg,
    turnInFlight: ctx.turnInFlight,
    pendingCallIds: [...ctx.pendingApprovals.keys()],
    generation: ctx.state.generation ?? 1,
    firstTurnContextTokens: ctx.firstTurnContextTokens,
    msSinceInterrupt:
      ctx.lastInterruptAt === null ? null : Date.now() - ctx.lastInterruptAt,
  });
  if (
    blocker &&
    (blocker.code === "NO_ROTATION_CONFIG" ||
      blocker.code === "TURN_IN_FLIGHT" ||
      blocker.code === "DECISIONS_PENDING" ||
      blocker.code === "INTERRUPT_GRACE")
  ) {
    // Transient / config blockers: plain error, no event.
    return { ok: false, error: blocker.code, message: blocker.message };
  }
  if (ctx.rotating) {
    return {
      ok: false,
      error: "ROTATION_IN_PROGRESS",
      message: "a rotation is already running for this session",
    };
  }
  ctx.rotating = true;
  let settleRotation!: () => void;
  ctx.rotationSettled = new Promise<void>((r) => (settleRotation = r));
  try {
    if (blocker) {
      // MAX_GENERATIONS or BOOTSTRAP_EXCEEDS_THRESHOLD — policy-level
      // refusals: emit rotation_refused; at the cap, checkpoint a terminal
      // handover FIRST (best-effort) so the human's re-brief starts from
      // B's own report, not a post-hoc distillation.
      let detail = blocker.message;
      if (blocker.code === "MAX_GENERATIONS") {
        const terminal = await runHandoverTurn(ctx);
        if (terminal) {
          // Best-effort: a write failure here must not prevent the
          // refusal from completing — note it in the detail instead.
          try {
            await fs.writeFile(handoverPath(ctx.sessionId), terminal);
            detail += ` Terminal handover written to ${handoverPath(ctx.sessionId)}.`;
          } catch (err) {
            detail += ` (best-effort terminal handover write failed: ${err instanceof Error ? err.message : String(err)})`;
          }
        }
      }
      await emitEvent(ctx, {
        kind: "rotation_refused",
        reason:
          blocker.code === "MAX_GENERATIONS" ? "max_generations" : "bootstrap_exceeds_threshold",
        detail,
        initiated_by: initiatedBy,
      } as Omit<Event, "seq" | "at">);
      return { ok: false, error: blocker.code, message: detail };
    }

    // Happy path: handover → persist → successor → lineage → self-stop.
    // freedAlias / scaffoldedId track in-flight side effects so an
    // UNEXPECTED throw (caught below) can best-effort compensate — the
    // guiding invariant is that a failed rotation never leaves the
    // still-running predecessor worse off than before the attempt.
    let freedAlias: string | undefined;
    let scaffoldedId: string | undefined;
    try {
      const handoverFlags: { wedged?: boolean; bExited?: boolean; stopping?: boolean } = {};
      const handover = await runHandoverTurn(ctx, handoverFlags);
      if (!handover) {
        if (handoverFlags.bExited) {
          // This op owns the rotation-outcome event; the crash teardown
          // holds session_stopped until this op settles, so the failure
          // is recorded first.
          await emitEvent(ctx, {
            kind: "rotation_failed",
            reason: "b_exited: session process exited during the handover turn",
            initiated_by: initiatedBy,
          } as Omit<Event, "seq" | "at">);
          return {
            ok: false,
            error: "ROTATION_FAILED",
            message:
              "session process exited during the handover turn; rotation cannot complete — use recover (a crash handover is distilled best-effort)",
          };
        }
        if (handoverFlags.stopping) {
          // This op owns the rotation-outcome event; teardown's finish
          // holds session_stopped until this op settles, so the failure
          // is recorded first.
          await emitEvent(ctx, {
            kind: "rotation_failed",
            reason: "session_stopping: stop or circuit breaker engaged during the handover turn",
            initiated_by: initiatedBy,
          } as Omit<Event, "seq" | "at">);
          return {
            ok: false,
            error: "ROTATION_FAILED",
            message: "session is stopping; rotation cannot complete",
          };
        }
        // Truthful reason: the wedged-interrupt abort never ran attempt 2,
        // so it must not be reported as the genuine both-attempts case.
        const reason = handoverFlags.wedged
          ? "handover_turn_wedged: interrupted turn never terminated within grace"
          : "handover_generation_failed: no extractable <handover> block after 2 attempts";
        await emitEvent(ctx, {
          kind: "rotation_failed",
          reason,
          initiated_by: initiatedBy,
        } as Omit<Event, "seq" | "at">);
        return {
          ok: false,
          error: "ROTATION_FAILED",
          message: handoverFlags.wedged
            ? "handover turn never terminated after interrupt; session left running"
            : "handover generation failed after 2 attempts; session left running",
        };
      }
      await fs.writeFile(handoverPath(ctx.sessionId), handover);
      if (ctx.bExited || ctx.stopping) {
        // B died — or a stop/breaker teardown engaged — between
        // completing the handover turn and the successor scaffold.
        // Abort: a successor must never be spawned by a rotation whose
        // predecessor-side choreography (alias handoff, self-teardown)
        // can no longer run. The handover text survives in handover.md
        // and events.jsonl, so recover's distillation loses nothing.
        // Precedence: a stop/breaker teardown that OWNS the exit is the
        // truthful cause when both hold — B's exit is that teardown's own
        // doing (stdin EOF races the real process's exit ahead of this
        // check, dogfood e2e). A crash owns the exit whenever
        // crashTeardownEngaged is set, and a stop landing inside the crash
        // teardown's settle-hold marks ctx.stopping before deferring to
        // it — so that cell, like the bare crash, must report the death
        // (and its "use recover" hint).
        const stopOwnsExit = ctx.stopping && !ctx.crashTeardownEngaged;
        await emitEvent(ctx, {
          kind: "rotation_failed",
          reason: stopOwnsExit
            ? "session_stopping: stop or circuit breaker engaged after the handover turn; successor not started"
            : "b_exited: session process exited after the handover turn; successor not started",
          initiated_by: initiatedBy,
        } as Omit<Event, "seq" | "at">);
        return {
          ok: false,
          error: "ROTATION_FAILED",
          message: stopOwnsExit
            ? "session is stopping after writing the handover; successor not started"
            : "session process exited after writing the handover; successor not started — use recover",
        };
      }

      const generation = ctx.state.generation ?? 1;
      const maxG = effectiveMaxGenerations(cfg!);
      const newId = newSessionId();
      // The lineage's TRUE original mission — never re-derive it from a
      // predecessor's scenario_brief once that predecessor is itself a
      // successor (that brief is already a composed handover, not the
      // original; see original_brief's doc comment in state.ts).
      const originalBrief =
        ctx.state.original_brief ??
        (ctx.state as unknown as { scenario_brief?: string }).scenario_brief ??
        "(no original brief was recorded at session start)";
      // Best-known lineage total to hand the successor: cost_usd once any
      // priced result line has been read, else the base this session was
      // itself born with — a session that has read no price of its own has
      // still spent every inherited dollar. Selected, never summed: a
      // chain of costless handoffs carries the same base unchanged.
      // Mirrors recover's inheritedCost; omit the key when neither is set.
      const inheritedCost = ctx.state.cost_usd ?? ctx.state.cost_usd_base;
      const alias = ctx.state.alias;
      if (alias !== undefined) {
        // Free the alias BEFORE scaffolding the successor: alias uniqueness
        // is among live sessions, and we are still live at this moment.
        delete ctx.state.alias;
        await writeState(statePath(ctx.sessionId), ctx.state);
        freedAlias = alias;
      }
      scaffoldedId = newId;
      await scaffoldSessionDir({
        sessionId: newId,
        cwd: ctx.state.cwd,
        policy: ctx.state.policy,
        decisionTimeoutSeconds: ctx.state.decision_timeout_seconds,
        model: ctx.state.model,
        scenarioBrief: composeSuccessorBrief({
          originalBrief,
          handover,
          generation: generation + 1,
          maxGenerations: maxG,
          predecessorId: ctx.sessionId,
          predecessorEventsPath: eventsPath(ctx.sessionId),
        }),
        originalBrief,
        wrapper: ctx.state.wrapper,
        alias,
        mcpServers: await readSessionMcpServers(ctx.sessionId),
        lineage: {
          generation: generation + 1,
          root_session_id: ctx.state.root_session_id ?? ctx.sessionId,
          rotated_from: ctx.sessionId,
          ...(inheritedCost !== undefined ? { cost_usd_base: inheritedCost } : {}),
        },
      });
      spawnRunnerDetached(newId);
      if (!(await waitForReady(newId, 5000))) {
        // Restore the alias BEFORE the rm — fs.rm can itself throw
        // (EACCES etc.), and the predecessor's alias must already be back
        // before that risk is taken, not after.
        if (alias !== undefined) {
          ctx.state.alias = alias;
          await writeState(statePath(ctx.sessionId), ctx.state);
          freedAlias = undefined;
        }
        await fs.rm(sessionDir(newId), { recursive: true, force: true });
        scaffoldedId = undefined;
        await emitEvent(ctx, {
          kind: "rotation_failed",
          reason: "successor_not_ready: runner did not become ready within 5s",
          initiated_by: initiatedBy,
        } as Omit<Event, "seq" | "at">);
        return {
          ok: false,
          error: "ROTATION_FAILED",
          message: "successor runner did not become ready; predecessor left running",
        };
      }
      // Past this point the successor is live and OWNS its session dir
      // and the alias. Clear both compensation trackers so a throw from
      // the remaining writeState/emitEvent below can never rm a running
      // successor's state dir nor restore the alias into a two-live-
      // holder conflict — the catch below would then just emit
      // rotation_failed(internal_error:*) and return ROTATION_FAILED:
      // loud, non-destructive, predecessor left alive and untorn (a
      // dangling-but-recoverable lineage pointer on an extremely narrow
      // path).
      scaffoldedId = undefined;
      freedAlias = undefined;
      ctx.state.rotated_to = newId;
      await writeState(statePath(ctx.sessionId), ctx.state);
      const watchCommand = `${clawDriveBinPath()} watch ${newId}`;
      await emitEvent(ctx, {
        kind: "session_rotated",
        new_session_id: newId,
        ...(alias !== undefined ? { alias } : {}),
        generation: generation + 1,
        handover_path: handoverPath(ctx.sessionId),
        watch_command: watchCommand,
        initiated_by: initiatedBy,
      } as Omit<Event, "seq" | "at">);
      setImmediate(() => teardownSession(ctx, `rotated:${newId}`));
      return {
        ok: true,
        result: {
          new_session_id: newId,
          ...(alias !== undefined ? { alias } : {}),
          generation: generation + 1,
          handover_path: handoverPath(ctx.sessionId),
          watch_command: watchCommand,
        },
      };
    } catch (err) {
      // Unexpected throw (e.g. ENOSPC/EACCES out of scaffoldSessionDir, or
      // any other stray fs error) — best-effort compensate so the
      // still-running predecessor is never left worse off than before the
      // attempt, then report a clean structured failure instead of letting
      // the exception escape as a raw HANDLER_ERROR with no event at all.
      if (freedAlias !== undefined) {
        try {
          ctx.state.alias = freedAlias;
          await writeState(statePath(ctx.sessionId), ctx.state);
        } catch { /* best-effort */ }
      }
      if (scaffoldedId !== undefined) {
        try {
          await fs.rm(sessionDir(scaffoldedId), { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
      const message = `internal_error: ${err instanceof Error ? err.message : String(err)}`;
      try {
        await emitEvent(ctx, {
          kind: "rotation_failed",
          reason: message,
          initiated_by: initiatedBy,
        } as Omit<Event, "seq" | "at">);
      } catch { /* best-effort */ }
      return { ok: false, error: "ROTATION_FAILED", message };
    }
  } finally {
    ctx.rotating = false;
    ctx.rotationSettled = null;
    settleRotation();
  }
}

export async function handleRequest(
  ctx: RunnerContext,
  req: ControlRequest
): Promise<ControlResponse> {
  switch (req.op) {
    case "ping":
      return { id: req.id, ok: true, result: { alive: true } };

    case "send_turn": {
      if (ctx.bExited) {
        // Checked BEFORE any state change, mirroring rotate's dead-B gate
        // (same ctx.bExited latch, same "use recover" hint): B is gone, so a
        // turn_started here would be a phantom (no turn can ever run) and the
        // stdin write below would hit a closed pipe. Plain error, no event.
        return {
          id: req.id,
          ok: false,
          error: "SESSION_EXITED",
          message: "session process has exited; turn cannot start — use recover",
        };
      }
      if (ctx.rotating && req.id !== ctx.rotationSendId) {
        // A rotation owns the session: its handover turn is running (or its
        // teardown is imminent) and a user turn written to stdin now would
        // interleave with the handover. Refuse before any state change —
        // the dead-B gate's posture. The successor named by session_rotated
        // is the retry target (an alias-addressed send lands there itself).
        // One exception: the choreography's own handover send, identified by
        // the sanctioned id in ctx.rotationSendId, is admitted.
        return {
          id: req.id,
          ok: false,
          error: "ROTATION_IN_PROGRESS",
          message:
            "a rotation is in flight for this session; wait for session_rotated and send to the successor",
        };
      }
      const turnId = `turn_${ctx.state.turns + 1}`;
      ctx.state.turns += 1;
      ctx.currentTurnId = turnId;
      ctx.turnInFlight = true;
      await emitEvent(ctx, {
        kind: "turn_started",
        turn_id: turnId,
        message: req.message,
      } as Omit<Event, "seq" | "at">);
      if (ctx.bExited) {
        // B died during the turn_started append above — the one-emit residual
        // window the entry guard cannot cover. The event is already on disk
        // (honest residue; state.turns agrees with it), but nothing may be
        // written to a dead stream. No await may ever sit between this check
        // and the write below — the synchronous segment is what closes the
        // pre-write race. Same refusal surface as the entry guard.
        return {
          id: req.id,
          ok: false,
          error: "SESSION_EXITED",
          message: "session process has exited; turn cannot start — use recover",
        };
      }
      // Write the user turn to B's stdin as stream-json
      const payload = {
        type: "user",
        message: { role: "user", content: req.message },
      };
      ctx.b.stdin!.write(JSON.stringify(payload) + "\n");
      return { id: req.id, ok: true, result: { turn_id: turnId } };
    }

    case "approve_tool": {
      const call_id = String(req.pretooluse.tool_use_id);
      const tool = String(req.pretooluse.tool_name);
      const args = (req.pretooluse.tool_input ?? {}) as Record<string, unknown>;
      const decision = matchPolicy(ctx.state.policy, { tool, args });
      const turnId = ctx.currentTurnId ?? "turn_unknown";

      if (decision.decision === "approve_silent") {
        await emitEvent(ctx, {
          kind: "tool_decision_resolved",
          turn_id: turnId,
          call_id,
          action: "approve",
          reason: decision.matched_rule?.name ?? "auto_approve",
          resolved_by: "policy",
        } as Omit<Event, "seq" | "at">);
        return { id: req.id, ok: true, result: { behavior: "allow" } };
      }

      if (decision.decision === "deny_silent") {
        const ruleName = decision.matched_rule?.name;
        const teach = compositionDenyMessage(ruleName);
        await emitEvent(ctx, {
          kind: "tool_decision_resolved",
          turn_id: turnId,
          call_id,
          action: "reject",
          reason: ruleName ?? "escalate_default=false",
          resolved_by: "policy",
        } as Omit<Event, "seq" | "at">);
        return {
          id: req.id,
          ok: true,
          result: { behavior: "deny", message: teach ?? "denied by policy" },
        };
      }

      // decision.decision === "escalate" — emit required, pause on socket
      const timeoutSec = ctx.state.decision_timeout_seconds ?? 3600;
      const timeoutMs = timeoutSec * 1000;
      const defaultAt = new Date(Date.now() + timeoutMs).toISOString();
      const decisionContext = await buildEscalationContext(
        ctx.sessionId,
        ctx.state.cwd,
        turnId,
        tool,
        args
      );
      await emitEvent(ctx, {
        kind: "tool_decision_required",
        turn_id: turnId,
        call_id,
        tool,
        args,
        severity: decision.severity,
        default_action: decision.default_action,
        matched_rule: decision.matched_rule?.name,
        default_at: defaultAt,
        ...decisionContext,
      } as Omit<Event, "seq" | "at">);

      return new Promise<ControlResponse>((resolve) => {
        // The decision-timeout unit owns the timer + resolved-by-timeout
        // semantics; the runner supplies the state side effects it fires.
        const scheduled = scheduleDecisionTimeout({
          call_id,
          turn_id: turnId,
          timeoutMs,
          defaultAction: decision.default_action,
          onFire: () => ctx.pendingApprovals.delete(call_id),
          emit: (event) => emitEvent(ctx, event as Omit<Event, "seq" | "at">),
          recordDeferred: () =>
            ctx.deferredCalls.set(call_id, {
              call_id,
              turn_id: turnId,
              tool,
              args,
              deferred_at: new Date().toISOString(),
              reason: "timeout → auto-defer",
            }),
          resolve: (result) => resolve({ id: req.id, ok: true, result }),
        });

        ctx.pendingApprovals.set(call_id, {
          call_id,
          turn_id: turnId,
          tool,
          args,
          default_action: decision.default_action,
          resolve: (dec) => {
            scheduled.clear();
            resolve({ id: req.id, ok: true, result: dec });
          },
        });
      });
    }

    case "resolve_tool_call": {
      const pending = ctx.pendingApprovals.get(req.call_id);
      if (!pending) {
        return {
          id: req.id,
          ok: false,
          error: "NOT_PENDING",
          message: "call_id not awaiting resolution",
        };
      }

      const plan = planResolveRemember({
        action: req.action,
        previewOnly: req.preview_only,
        rememberAsPolicy: req.remember_as_policy,
        rememberedRule: req.remembered_rule,
        tool: pending.tool,
        args: pending.args as Record<string, unknown>,
        policy: ctx.state.policy,
      });

      if (plan.mode === "error") {
        return { id: req.id, ok: false, error: plan.code, message: plan.message };
      }

      if (plan.mode === "preview") {
        return {
          id: req.id,
          ok: true,
          result: {
            would_remember: plan.rule,
            list: plan.list,
            source: plan.source,
            ...(plan.bypass ? { bypass: true } : {}),
          },
        };
      }

      // plan.mode === "commit" — resolve the call for real.
      ctx.pendingApprovals.delete(req.call_id);

      await emitEvent(ctx, {
        kind: "tool_decision_resolved",
        turn_id: pending.turn_id,
        call_id: req.call_id,
        action: req.action,
        reason: req.reason,
        resolved_by: "user_mcp",
      } as Omit<Event, "seq" | "at">);

      if (plan.appendRule) {
        const p = ctx.state.policy as PolicyObject;
        const updated = { ...p, [plan.list]: [...(p[plan.list] ?? []), plan.appendRule] };
        ctx.state.policy = updated;
        await writeState(statePath(ctx.sessionId), ctx.state);
      }

      if (req.action === "defer") {
        // Move into deferredCalls tracking; release approver with DEFERRED reason
        ctx.deferredCalls.set(req.call_id, {
          call_id: req.call_id,
          turn_id: pending.turn_id,
          tool: pending.tool,
          args: pending.args as Record<string, unknown>,
          deferred_at: new Date().toISOString(),
          reason: req.reason,
        });
        pending.resolve({
          behavior: "deny",
          message: `DEFERRED: ${req.reason}. Human will run this command manually; wait for a follow-up user turn with the output.`,
        });
        return { id: req.id, ok: true };
      }

      pending.resolve({
        behavior: req.action === "approve" ? "allow" : "deny",
        message: req.reason,
      });
      return { id: req.id, ok: true };
    }

    case "update_policy": {
      const policy = coercePolicy(req.policy);
      const v = validatePolicy(policy);
      if (!v.ok) {
        return {
          id: req.id,
          ok: false,
          error: "INVALID_POLICY",
          message: v.error,
        };
      }
      // Auto-rotation latch re-arm: only a CHANGED rotation block re-arms —
      // a byte-identical no-op update must not summon a duplicate
      // deterministic refusal.
      const oldRot = rotationConfigOf(ctx.state.policy);
      const newRot = rotationConfigOf(policy as Policy);
      if (
        oldRot?.threshold_tokens !== newRot?.threshold_tokens ||
        oldRot?.max_generations !== newRot?.max_generations ||
        oldRot?.mode !== newRot?.mode
      ) {
        ctx.autoRotateLatched = false;
        ctx.rotationPolicyEpoch += 1;
      }
      if (warnCostOf(ctx.state.policy) !== warnCostOf(policy as Policy)) {
        ctx.costWarned = false;
      }
      ctx.state.policy = policy as Policy;
      await writeState(statePath(ctx.sessionId), ctx.state);
      return { id: req.id, ok: true };
    }

    case "interrupt_turn": {
      // Stamp first, unconditionally: rotate's INTERRUPT_GRACE gate must
      // cover the request even when the SIGINT itself is a no-op.
      ctx.lastInterruptAt = Date.now();
      if (ctx.b.pid) {
        try {
          process.kill(ctx.b.pid, "SIGINT");
        } catch {
          /* already dead */
        }
      }
      return { id: req.id, ok: true };
    }

    case "stop_session": {
      // Mark stopping so the main loop's b.on("exit") yields control to us.
      ctx.stopping = true;
      // Return first (so the caller sees ok:true promptly), then tear down.
      setImmediate(() => teardownSession(ctx, "stop_session"));
      return { id: req.id, ok: true };
    }

    case "rotate": {
      const out = await performRotation(ctx, "manual");
      return out.ok
        ? { id: req.id, ok: true, result: out.result }
        : { id: req.id, ok: false, error: out.error, message: out.message };
    }

    case "provide_tool_output": {
      if (
        ctx.rotating &&
        (ctx.deferredCalls.has(req.call_id) || ctx.pendingApprovals.has(req.call_id))
      ) {
        // A rotation owns the session: the composed output turn below pipes
        // into B's stdin exactly like send_turn, and its turn bookkeeping
        // would mis-stamp the handover turn's parse-time output — so refuse
        // in the send guard's posture, before any state change: no event, no
        // stdin write, no auto-defer. Guarded only for KNOWN calls so an
        // unknown call_id keeps its CALL_NOT_FOUND diagnostic; a still-
        // pending call here is necessarily the handover turn's own (the
        // rotate gate refused DECISIONS_PENDING at entry), and auto-
        // deferring it would release the handover's hook with deny. The
        // deferred record survives the refusal, but not the rotation — the
        // handover narrates it, so the successor takes the output as a
        // normal turn.
        return {
          id: req.id,
          ok: false,
          error: "ROTATION_IN_PROGRESS",
          message:
            "a rotation is in flight for this session; wait for session_rotated, then send the output to the successor as a normal turn",
        };
      }
      let deferred = ctx.deferredCalls.get(req.call_id);

      // If still pending (not yet resolved), auto-resolve as defer.
      if (!deferred) {
        const pending = ctx.pendingApprovals.get(req.call_id);
        if (pending) {
          ctx.pendingApprovals.delete(req.call_id);
          await emitEvent(ctx, {
            kind: "tool_decision_resolved",
            turn_id: pending.turn_id,
            call_id: req.call_id,
            action: "defer",
            reason: "auto-deferred by provide_tool_output",
            resolved_by: "user_mcp_auto",
          } as Omit<Event, "seq" | "at">);
          pending.resolve({
            behavior: "deny",
            message: "DEFERRED: human will run this command manually.",
          });
          deferred = {
            call_id: req.call_id,
            turn_id: pending.turn_id,
            tool: pending.tool,
            args: pending.args as Record<string, unknown>,
            deferred_at: new Date().toISOString(),
            reason: "auto-deferred by provide_tool_output",
          };
          ctx.deferredCalls.set(req.call_id, deferred);
        }
      }

      if (!deferred) {
        return {
          id: req.id,
          ok: false,
          error: "CALL_NOT_FOUND",
          message: "no deferred or pending call with this call_id",
        };
      }

      if (ctx.bExited) {
        // Deliberate order: CALL_NOT_FOUND and the auto-defer block above
        // always run before this check, so an unknown call_id keeps its
        // diagnostic and a still-pending call's decision record settles the
        // same way on a dead session as on a live one — not an oversight.
        //
        // Same phantom-emission hole as send_turn, same guard: this op pipes
        // its composed message to B exactly like send_turn does (turn_started
        // + a stdin write). The call is left in deferredCalls rather than
        // deleted — its record survives for inspection.
        return {
          id: req.id,
          ok: false,
          error: "SESSION_EXITED",
          message: "session process has exited; turn cannot start — use recover",
        };
      }

      const stdout = req.stdout ?? "";
      const stderr = req.stderr ?? "";
      const exit_code = typeof req.exit_code === "number" ? req.exit_code : null;
      const extra = req.extra ?? "";

      const userMessage =
        `[claw-drive] The deferred \`${deferred.tool}\` call (call_id: ${deferred.call_id}) was executed by the human.\n\n` +
        `Original args: ${JSON.stringify(deferred.args)}\n\n` +
        `Exit code: ${exit_code === null ? "(not provided)" : String(exit_code)}\n\n` +
        `Stdout:\n${stdout || "(empty)"}\n\n` +
        `Stderr:\n${stderr || "(empty)"}\n\n` +
        `Notes: ${extra || "(none)"}\n\n` +
        `Please continue from where you left off, using this as the tool's output.`;

      // Compose the user turn and pipe it to B's stdin (same path as send_turn).
      const turnId = `turn_${ctx.state.turns + 1}`;
      ctx.state.turns += 1;
      ctx.currentTurnId = turnId;
      ctx.turnInFlight = true;
      await emitEvent(ctx, {
        kind: "turn_started",
        turn_id: turnId,
        message: userMessage,
      } as Omit<Event, "seq" | "at">);
      if (ctx.bExited) {
        // B died during the turn_started append above — the one-emit residual
        // window the entry guard cannot cover. The event is already on disk
        // (honest residue; state.turns agrees with it), but nothing may be
        // written to a dead stream. No await may ever sit between this check
        // and the write below — the synchronous segment is what closes the
        // pre-write race. Same refusal surface as the entry guard. This
        // return also skips the tool_output_provided emit and keeps the
        // deferred record — the output was never delivered to B.
        return {
          id: req.id,
          ok: false,
          error: "SESSION_EXITED",
          message: "session process has exited; turn cannot start — use recover",
        };
      }
      const payload = {
        type: "user",
        message: { role: "user", content: userMessage },
      };
      ctx.b.stdin!.write(JSON.stringify(payload) + "\n");

      // Emit the tool_output_provided audit event.
      await emitEvent(ctx, {
        kind: "tool_output_provided",
        turn_id: deferred.turn_id,
        call_id: deferred.call_id,
        stdout_len: stdout.length,
        stderr_len: stderr.length,
        exit_code,
      } as Omit<Event, "seq" | "at">);

      ctx.deferredCalls.delete(req.call_id);

      return { id: req.id, ok: true, result: { turn_id: turnId } };
    }

    default: {
      const unknown = req as unknown as ControlRequest;
      return {
        id: unknown.id,
        ok: false,
        error: "UNKNOWN_OP",
        message: `unimplemented op: ${unknown.op}`,
      };
    }
  }
}

/**
 * Runner signal handling (SIGTERM/SIGINT). First signal: graceful teardown
 * through teardownSession — stdin EOF, SIGTERM→SIGKILL escalation, terminal
 * state + session_stopped("runner_sigterm"/"runner_sigint"), process exit.
 * Second signal (or a signal while a stop is already engaged): the operator
 * insists — force-exit immediately. Before this, the signal path sent B a
 * single unescalated SIGTERM and never exited by itself, so a runner whose B
 * ignored SIGTERM — or one already past its main loop — absorbed every
 * subsequent SIGTERM forever (July's orphaned runners needed SIGKILL).
 * Exported for unit tests; runRunner registers the returned closure.
 */
export function makeSignalHandler(
  ctx: RunnerContext,
  signal: "SIGTERM" | "SIGINT"
): () => void {
  return () => {
    if (ctx.stopping) {
      process.exit(1);
      return;
    }
    const reason = signal === "SIGTERM" ? "runner_sigterm" : "runner_sigint";
    if (!ctx.bExited) {
      // Never clobber a crash's truthful reason: a signal landing during the
      // crash teardown (≤180s distillation window) defers to it, and the
      // recorded reason must stay crashed:* (COMPATIBILITY promises this).
      ctx.state.exit_reason = reason;
    }
    teardownSession(ctx, reason);
  };
}

/**
 * Absorb async errors from B's stdin (EPIPE from a write in flight when B
 * died; write-after-end from a send racing a stop's stdin.end()). Without a
 * listener these surface as an unhandled stream "error" event and crash the
 * runner — the socket server's try/catch sees only synchronous throws. Log
 * and continue: the exit paths own exit observation (observeBExit) and the
 * dead-B guards own refusals; this listener must never latch state.
 * Exported for unit tests; runRunner attaches it once at spawn.
 */
export function attachBStdinErrorAbsorber(b: ChildProcess): void {
  b.stdin?.on("error", (err: Error) => {
    process.stderr.write(`b stdin error absorbed: ${err.message}\n`);
  });
}

/**
 * The single fact-recording step for a B exit, shared by every observer: the
 * main loop's exit handler, the crash choreography, teardown's dead-B fast
 * path (B already exited before teardown ran), and teardown's own live-B
 * exit handler (B exits after teardown started tearing it down). Latches
 * bExited and fails every pending turn waiter — B's stdout is closed, so no
 * terminating event can ever arrive, and anything awaiting a turn must
 * unblock now. Idempotent: re-latching and re-flushing an empty map are
 * no-ops, so observers may call it in any order.
 */
export function observeBExit(ctx: RunnerContext): void {
  ctx.bExited = true;
  const waiters = [...ctx.turnWaiters.values()];
  ctx.turnWaiters.clear();
  for (const w of waiters) w("failed");
}

/**
 * Context rotation: the UNEXPECTED B-death path — best-effort crash
 * distillation (the crash handover serves rotation-configured AND
 * respawn-configured sessions), then crash auto-respawn (maybeAutoRespawn),
 * then terminal state + session_stopped. Exported so the crash choreography
 * is unit-testable without spawning a real runner; runRunner's b.on("exit")
 * handler is the only production caller.
 */
export async function handleUnexpectedBExit(
  ctx: RunnerContext,
  code: number | null,
  signal: NodeJS.Signals | null
): Promise<void> {
  // Mark the death and fail every pending turn waiter FIRST, synchronously:
  // B's stdout is closed, so no terminating event can ever arrive — an
  // in-flight rotate must unblock now, not at its 600s handover timeout
  // (dogfood 2026-08-04: the hung rotate client).
  observeBExit(ctx);
  ctx.crashTeardownEngaged = true;
  const sess = ctx.state;
  // Capture the truthful reason in a local: concurrent stampers (a signal
  // handler, the budget breaker) must not be able to falsify the terminal
  // record written below.
  const exitReason = `crashed:${code ?? signal ?? "unknown"}`;
  sess.exit_code = code;
  sess.status = "stopped";
  sess.exit_reason = exitReason;
  if (ctx.rotating && ctx.rotationSettled) {
    // The woken rotate op owns the rotation-outcome event (rotation_failed,
    // rotation_refused, or session_rotated — only it knows the outcome).
    // Hold the terminal session_stopped until it settles so the outcome is
    // recorded first. Bounded: every rotate path fails fast once bExited is
    // set (worst case one settle-window sleep plus a successor spawn wait).
    await Promise.race([ctx.rotationSettled, sleepTimeout(ROTATION_SETTLE_HOLD_MS)]);
  }
  let handover_path: string | undefined;
  if (rotationConfigOf(sess.policy) || respawnConfigOf(sess.policy)) {
    try {
      const { events } = await readEventsSince(eventsPath(ctx.sessionId), 0);
      const brief =
        sess.original_brief ??
        (sess as unknown as { scenario_brief?: string }).scenario_brief ??
        "";
      const text = await runDistiller({
        model: sess.model,
        prompt: buildDistillerPrompt({ digest: buildCrashDigest(events), originalBrief: brief }),
        // Neutral cwd: the (crashing) session's own dir always exists and
        // holds no CLAUDE.md / .claude/ of its own (see runDistiller's doc comment).
        cwd: sessionDir(ctx.sessionId),
      });
      if (text) {
        await fs.writeFile(crashHandoverPath(ctx.sessionId), text);
        handover_path = crashHandoverPath(ctx.sessionId);
      }
    } catch { /* best-effort — never block teardown on distillation */ }
  }
  sess.last_event_at = new Date().toISOString();
  sess.exit_reason = exitReason;
  await writeState(statePath(ctx.sessionId), sess);
  await maybeAutoRespawn(ctx);
  ctx.seq += 1;
  await appendEvent(eventsPath(ctx.sessionId), {
    seq: ctx.seq,
    at: new Date().toISOString(),
    kind: "session_stopped",
    reason: exitReason,
    exit_code: code,
    ...(handover_path ? { handover_path } : {}),
  } as Event);
}

/**
 * Crash auto-respawn: run the recover choreography from inside the crash
 * teardown when the policy opts in (respawn.mode "auto"). Runs between the
 * terminal state write and the session_stopped emit so the successor's
 * rotated_to pointer and the session_recovered narration land BEFORE the
 * terminal event — the rotate choreography's ordering, which is what lets a
 * --follow-lineage watcher hop to the successor instead of ending at the
 * crash. recoverSession composes unmodified at this seam: the state on disk
 * already says "stopped" (SESSION_LIVE passes), the crash handover was just
 * written (no second distill; a flaked distill gets one bounded retry via
 * recover's fallback), and the corpse fails the alias liveness check so the
 * alias transfers. Narration uses raw appendEvent like the terminal emit —
 * emitEvent would writeState this function's stale in-memory state and
 * clobber recoverSession's rotated_to write. Never throws: the teardown
 * must always reach its session_stopped. Exported for unit tests;
 * handleUnexpectedBExit is the only production caller.
 */
export async function maybeAutoRespawn(ctx: RunnerContext): Promise<void> {
  const sess = ctx.state;
  const emitFailed = async (reason: string): Promise<void> => {
    ctx.seq += 1;
    await appendEvent(eventsPath(ctx.sessionId), {
      seq: ctx.seq,
      at: new Date().toISOString(),
      kind: "recover_failed",
      reason,
      initiated_by: "auto",
    } as Event);
  };
  try {
    const blocker = checkRespawnGate({
      respawnCfg: respawnConfigOf(sess.policy),
      rotationCfg: rotationConfigOf(sess.policy),
      rotatedTo: sess.rotated_to,
      stopping: ctx.stopping,
      respawnStreak: sess.respawn_streak ?? 0,
      generation: sess.generation ?? 1,
      lineageCostUsd: sess.cost_usd ?? sess.cost_usd_base,
      maxCostUsd: sess.policy !== "bypass" ? sess.policy.budget?.max_cost_usd : undefined,
    });
    if (blocker) {
      if (blocker.kind === "narrated") await emitFailed(blocker.reason);
      return;
    }
    const r = await recoverSession({
      sessionId: ctx.sessionId,
      respawnStreak: (sess.respawn_streak ?? 0) + 1,
    });
    if (!r.ok) {
      const prefix = r.error === "RECOVER_FAILED" ? "successor_not_ready" : r.error.toLowerCase();
      await emitFailed(`${prefix}: ${r.message}`);
      return;
    }
    const res = r.result;
    if (!res.new_session_id || res.generation === undefined || !res.watch_command) {
      // Defensive: recoverSession without noStart always returns these on ok.
      await emitFailed("internal_error: recover returned ok without a successor record");
      return;
    }
    // recoverSession persisted rotated_to on its own fresh read of state.json;
    // mirror it so this function's in-memory copy stays truthful.
    sess.rotated_to = res.new_session_id;
    ctx.seq += 1;
    await appendEvent(eventsPath(ctx.sessionId), {
      seq: ctx.seq,
      at: new Date().toISOString(),
      kind: "session_recovered",
      new_session_id: res.new_session_id,
      ...(res.alias ? { alias: res.alias } : {}),
      generation: res.generation,
      handover_path: res.handover_path,
      watch_command: res.watch_command,
      initiated_by: "auto",
    } as Event);
  } catch (err) {
    try {
      await emitFailed(`internal_error: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* best-effort — never block the teardown's terminal record */
    }
  }
}

/**
 * Per-session runner entry. Launched as a detached child of the MCP server
 * (or by the `claw-drive runner <id>` CLI mode during tests).
 *
 * This Task 10 scaffold does just startup, B spawn, and signal-based shutdown.
 * Tasks 11–15 incrementally layer in stdout parsing, socket handling, and
 * the approval flow.
 */
export async function runRunner(sessionId: string): Promise<void> {
  // CD-9: capture this (detached, stdio:"ignore") runner's own stdout/stderr
  // into <session_dir>/runner.log as the very first action, so even the startup
  // failures below — and the standalone entry's "runner fatal:" — are logged.
  // close() is synchronous, so the process.once("exit") hook is a safe single
  // teardown across every exit path (and is idempotent).
  const logCapture = installRunnerLogCapture(sessionId);
  process.once("exit", () => logCapture.close());

  const sess = await readState(statePath(sessionId));
  if (!sess) throw new Error(`no state.json at ${statePath(sessionId)}`);

  await fs.writeFile(runnerPidPath(sessionId), String(process.pid));

  const claudeArgs = buildClaudeArgs({
    mcpConfigPath: mcpConfigPath(sessionId),
    settingsPath: settingsPath(sessionId),
    model: sess.model,
    wrapper: sess.wrapper,
  });

  const b = spawn("claude", claudeArgs, {
    cwd: sess.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAW_DRIVE_SESSION_ID: sessionId },
  });

  if (!b.stdout || !b.stderr || !b.stdin) {
    throw new Error("failed to set up stdio pipes");
  }

  // Absorb async stdin errors (EPIPE, write-after-end) so they cannot surface
  // as an unhandled stream "error" event and crash the runner.
  attachBStdinErrorAbsorber(b);

  // Route B's stderr into the SAME captured runner.log. We write through the
  // already-redirected process.stderr (the single rotating fd from CD-44)
  // rather than opening a second independent handle, which would corrupt
  // rotation's byte accounting.
  b.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  // Flip state to ready
  sess.runner_pid = process.pid;
  sess.status = "ready";
  sess.started_at = sess.started_at || new Date().toISOString();
  await writeState(statePath(sessionId), sess);

  // Emit session_started event (seq starts at 1)
  await appendEvent(eventsPath(sessionId), {
    seq: 1,
    at: new Date().toISOString(),
    kind: "session_started",
    cwd: sess.cwd,
    policy_digest: policyDigest(sess.policy),
  } as Event);

  const budgetCfg = sess.policy !== "bypass" ? sess.policy.budget : undefined;
  const ctx: RunnerContext = {
    sessionId,
    state: sess,
    b,
    currentTurnId: null,
    seq: 1,
    pendingApprovals: new Map(),
    deferredCalls: new Map(),
    stopping: false,
    budget: budgetCfg ? createBudgetTracker(budgetCfg) : null,
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
  };

  // Start the stdout loop; run it in the background. If it fails, emit an
  // error event and let the teardown path in the signal wait handle the rest.
  const stdoutDone = runStdoutLoop(ctx).catch(async (err) => {
    await emitEvent(ctx, {
      kind: "error",
      message: String(err),
      recoverable: false,
    } as Omit<Event, "seq" | "at">);
  });
  void stdoutDone;

  // Start the socket server BEFORE touching the ready marker. Callers poll for
  // the marker and will send_turn immediately on appearance — if the socket
  // isn't listening yet the first send race-fails with ECONNREFUSED. Fixed
  // race found by the b-crash integration test.
  const server = await startSocketServer(socketPath(ctx.sessionId), (req) =>
    handleRequest(ctx, req)
  );

  // Touch ready marker — MCP's start_session polls for this
  await fs.writeFile(readyMarkerPath(sessionId), new Date().toISOString());

  // If scenario_brief was supplied at session-start, queue it as the first turn
  const brief = (ctx.state as unknown as { scenario_brief?: string }).scenario_brief;
  if (typeof brief === "string" && brief.length > 0) {
    await handleRequest(ctx, {
      id: "boot",
      op: "send_turn",
      message: brief,
    });
  }

  await new Promise<void>((resolve) => {
    process.on("SIGTERM", makeSignalHandler(ctx, "SIGTERM"));
    process.on("SIGINT", makeSignalHandler(ctx, "SIGINT"));
    b.on("exit", (code, signal) => {
      // Record the exit and unblock turn awaiters on EVERY path first — on
      // the stop path this is what lets an in-flight rotate fail fast
      // instead of waiting out a turn timeout that can never fire.
      observeBExit(ctx);
      // stop_session and rotate own their teardown; this branch is the
      // UNEXPECTED death path (Context rotation: crash → best-effort distillation).
      if (ctx.stopping) return;
      void (async () => {
        try {
          await handleUnexpectedBExit(ctx, code, signal);
        } catch {
          // Best-effort — a failed terminal write (session dir already gone,
          // disk full) must not unhandled-reject the runner; the finally
          // still resolves so teardown and the process exit proceed.
        } finally {
          resolve();
        }
      })();
    });
  });

  // Only the crash path resolves the promise above — stop_session and the
  // signal handlers exit inside teardownSession. B is gone and the terminal
  // record is written: close the listener socket and exit NOW. Lingering
  // would leave an "undead" runner — a still-open control connection (e.g. a
  // woken rotate client's) keeps the event loop alive while the installed
  // signal listeners absorb every subsequent SIGTERM. The runner-log capture
  // is closed by the process.once("exit") hook installed at startup.
  try { server.close(); } catch { /* */ }
  await fs.rm(readyMarkerPath(sessionId), { force: true });
  process.exit(0);
}

// Standalone entry for `claw-drive runner <session_id>` (wired by dispatcher in Task 26)
if (process.argv[1]?.endsWith("runner.js") && process.argv.length >= 3) {
  runRunner(process.argv[2]).catch((err) => {
    console.error("runner fatal:", err);
    process.exit(1);
  });
}
