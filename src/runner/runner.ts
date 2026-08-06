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
import { createBudgetTracker, budgetExceededReason, type BudgetTracker } from "./budget.js";
import { rotationConfigOf, isOverThreshold, checkRotateGate, effectiveMaxGenerations } from "./context-tracker.js";
import { buildHandoverInstruction, extractHandover, composeSuccessorBrief } from "../lib/handover.js";
import { buildCrashDigest, buildDistillerPrompt, runDistiller } from "../lib/distill.js";
import { newSessionId, scaffoldSessionDir, spawnRunnerDetached, waitForReady } from "../lib/spawn-session.js";
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
  completedTurns: number;
  turnInFlight: boolean;
  firstTurnContextTokens: number | null;
  rotating: boolean;
  turnWaiters: Map<string, (outcome: "completed" | "failed") => void>;
  /** Set synchronously the moment B's process exits (any path). Once true no
   * turn can ever terminate again — handover attempts and the rotate
   * choreography must fail fast instead of waiting out turn timeouts. */
  bExited: boolean;
  /** Set by teardownSession's first engagement; later engagements (a second
   * stop, a signal after a stop) are no-ops instead of re-arming timers or
   * double-emitting the terminal event. */
  tearingDown: boolean;
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
 * fires; waiting on it is how a stop used to wedge forever).
 */
function teardownSession(ctx: RunnerContext, reason: string): void {
  ctx.stopping = true;
  if (ctx.tearingDown) return;
  ctx.tearingDown = true;
  if (ctx.bExited) {
    // The crash teardown (handleUnexpectedBExit → runRunner's exit path)
    // already owns the terminal record and the process exit.
    return;
  }
  const finish = async (code: number | null) => {
    ctx.state.status = "stopped";
    ctx.state.exit_code = code;
    await writeState(statePath(ctx.sessionId), ctx.state);
    await emitEvent(ctx, {
      kind: "session_stopped",
      reason,
      exit_code: code,
    } as Omit<Event, "seq" | "at">);
    await fs.rm(readyMarkerPath(ctx.sessionId), { force: true });
    process.exit(0);
  };
  if (ctx.b.exitCode !== null || ctx.b.signalCode !== null) {
    // B died without the crash path running (it exited on the same tick a
    // stop landed, before any listener registered) — the terminal record
    // must still be written; an exit event will never be observed.
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
async function enforceBudget(ctx: RunnerContext, ev: Event): Promise<void> {
  if (!ctx.budget || ctx.budgetBreached || ctx.stopping) return;
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
async function runStdoutLoop(ctx: RunnerContext): Promise<void> {
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
 * context-rotation turn-boundary bookkeeping, run after each parsed event is emitted:
 * maintains turnInFlight / completedTurns / turnWaiters, persists
 * context_tokens, records the first completed turn's reading for the
 * bootstrap gate, and re-fires context_threshold_reached on every completed
 * turn while above threshold (suppressed during the rotate choreography's
 * own handover turn).
 */
async function afterEventBookkeeping(ctx: RunnerContext, ev: Event): Promise<void> {
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
  if (ev.kind !== "turn_completed") return;
  ctx.completedTurns += 1;
  if (ctx.lastContextTokens !== null) {
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
  }
}

const HANDOVER_TURN_TIMEOUT_MS = 600_000;
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
 * implies attempt 2 ran when it never did.
 */
async function runHandoverTurn(
  ctx: RunnerContext,
  flags?: { wedged?: boolean; bExited?: boolean }
): Promise<string | null> {
  for (const attempt of [1, 2] as const) {
    if (ctx.bExited) {
      // B is dead (handleUnexpectedBExit fails the pending waiter, so a
      // killed attempt lands back here) — never send another turn at a
      // closed stdin, and never wait out a turn timeout that cannot fire.
      if (flags) flags.bExited = true;
      return null;
    }
    const turnId = `turn_${ctx.state.turns + 1}`;
    const done = new Promise<"completed" | "failed">((resolve) =>
      ctx.turnWaiters.set(turnId, resolve)
    );
    await handleRequest(ctx, {
      id: `handover_${attempt}`,
      op: "send_turn",
      message: buildHandoverInstruction({ attempt }),
    });
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
      // attempt 2 starts fresh regardless.
      continue;
    }
    ctx.turnWaiters.delete(turnId); // no-op (afterEventBookkeeping already deleted it on resolve)
    if (outcome === "failed") continue;
    const handover = extractHandover(await turnAssistantText(ctx.sessionId, turnId));
    if (handover) return handover;
  }
  return null;
}

export async function handleRequest(
  ctx: RunnerContext,
  req: ControlRequest
): Promise<ControlResponse> {
  switch (req.op) {
    case "ping":
      return { id: req.id, ok: true, result: { alive: true } };

    case "send_turn": {
      const turnId = `turn_${ctx.state.turns + 1}`;
      ctx.state.turns += 1;
      ctx.currentTurnId = turnId;
      ctx.turnInFlight = true;
      await emitEvent(ctx, {
        kind: "turn_started",
        turn_id: turnId,
        message: req.message,
      } as Omit<Event, "seq" | "at">);
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
      ctx.state.policy = policy as Policy;
      await writeState(statePath(ctx.sessionId), ctx.state);
      return { id: req.id, ok: true };
    }

    case "interrupt_turn": {
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
      const cfg = rotationConfigOf(ctx.state.policy);
      const blocker = checkRotateGate({
        cfg,
        turnInFlight: ctx.turnInFlight,
        pendingCallIds: [...ctx.pendingApprovals.keys()],
        generation: ctx.state.generation ?? 1,
        firstTurnContextTokens: ctx.firstTurnContextTokens,
      });
      if (
        blocker &&
        (blocker.code === "NO_ROTATION_CONFIG" ||
          blocker.code === "TURN_IN_FLIGHT" ||
          blocker.code === "DECISIONS_PENDING")
      ) {
        // Transient / config blockers: plain error, no event.
        return { id: req.id, ok: false, error: blocker.code, message: blocker.message };
      }
      if (ctx.rotating) {
        return {
          id: req.id,
          ok: false,
          error: "ROTATION_IN_PROGRESS",
          message: "a rotation is already running for this session",
        };
      }
      ctx.rotating = true;
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
          } as Omit<Event, "seq" | "at">);
          return { id: req.id, ok: false, error: blocker.code, message: detail };
        }

        // Happy path: handover → persist → successor → lineage → self-stop.
        // freedAlias / scaffoldedId track in-flight side effects so an
        // UNEXPECTED throw (caught below) can best-effort compensate — the
        // guiding invariant is that a failed rotation never leaves the
        // still-running predecessor worse off than before the attempt.
        let freedAlias: string | undefined;
        let scaffoldedId: string | undefined;
        try {
          const handoverFlags: { wedged?: boolean; bExited?: boolean } = {};
          const handover = await runHandoverTurn(ctx, handoverFlags);
          if (!handover) {
            if (handoverFlags.bExited) {
              // The crash path (handleUnexpectedBExit) already recorded
              // rotation_failed ahead of session_stopped — respond to the
              // client without emitting a second event.
              return {
                id: req.id,
                ok: false,
                error: "ROTATION_FAILED",
                message:
                  "session process exited during the handover turn; rotation cannot complete — use recover (a crash handover is distilled best-effort)",
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
            } as Omit<Event, "seq" | "at">);
            return {
              id: req.id,
              ok: false,
              error: "ROTATION_FAILED",
              message: handoverFlags.wedged
                ? "handover turn never terminated after interrupt; session left running"
                : "handover generation failed after 2 attempts; session left running",
            };
          }
          await fs.writeFile(handoverPath(ctx.sessionId), handover);
          if (ctx.bExited) {
            // B died between completing the handover turn and the successor
            // scaffold. Abort: a successor must never be spawned by a
            // rotation whose predecessor-side choreography (alias handoff,
            // self-teardown) can no longer run. The handover text survives in
            // events.jsonl, so recover's distillation loses nothing.
            await emitEvent(ctx, {
              kind: "rotation_failed",
              reason: "b_exited: session process exited after the handover turn; successor not started",
            } as Omit<Event, "seq" | "at">);
            return {
              id: req.id,
              ok: false,
              error: "ROTATION_FAILED",
              message:
                "session process exited after writing the handover; successor not started — use recover",
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
            lineage: {
              generation: generation + 1,
              root_session_id: ctx.state.root_session_id ?? ctx.sessionId,
              rotated_from: ctx.sessionId,
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
            } as Omit<Event, "seq" | "at">);
            return {
              id: req.id,
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
          } as Omit<Event, "seq" | "at">);
          setImmediate(() => teardownSession(ctx, `rotated:${newId}`));
          return {
            id: req.id,
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
            } as Omit<Event, "seq" | "at">);
          } catch { /* best-effort */ }
          return { id: req.id, ok: false, error: "ROTATION_FAILED", message };
        }
      } finally {
        ctx.rotating = false;
      }
    }

    case "provide_tool_output": {
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
    ctx.state.exit_reason = signal === "SIGTERM" ? "runner_sigterm" : "runner_sigint";
    teardownSession(ctx, ctx.state.exit_reason);
  };
}

/**
 * Context rotation: the UNEXPECTED B-death path — best-effort crash
 * distillation, then terminal state + session_stopped. Exported so the crash
 * choreography is unit-testable without spawning a real runner; runRunner's
 * b.on("exit") handler is the only production caller.
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
  ctx.bExited = true;
  const waiters = [...ctx.turnWaiters.values()];
  ctx.turnWaiters.clear();
  for (const w of waiters) w("failed");
  const sess = ctx.state;
  sess.exit_code = code;
  sess.status = "stopped";
  sess.exit_reason = `crashed:${code ?? signal ?? "unknown"}`;
  if (waiters.length > 0 && ctx.rotating) {
    // The crash killed a rotation's in-flight handover turn. Record the
    // rotation's failure BEFORE the terminal session_stopped; the woken
    // rotate op responds to its client but deliberately does not emit.
    ctx.seq += 1;
    await appendEvent(eventsPath(ctx.sessionId), {
      seq: ctx.seq,
      at: new Date().toISOString(),
      kind: "rotation_failed",
      reason: "b_exited: session process exited during the handover turn",
    } as Event);
  }
  let handover_path: string | undefined;
  if (rotationConfigOf(sess.policy)) {
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
  await writeState(statePath(ctx.sessionId), sess);
  ctx.seq += 1;
  await appendEvent(eventsPath(ctx.sessionId), {
    seq: ctx.seq,
    at: new Date().toISOString(),
    kind: "session_stopped",
    reason: sess.exit_reason,
    exit_code: code,
    ...(handover_path ? { handover_path } : {}),
  } as Event);
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
    completedTurns: 0,
    turnInFlight: false,
    firstTurnContextTokens: null,
    rotating: false,
    turnWaiters: new Map(),
    bExited: false,
    tearingDown: false,
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
      // stop_session and rotate own their teardown; this branch is the
      // UNEXPECTED death path (Context rotation: crash → best-effort distillation).
      if (ctx.stopping) return;
      void (async () => {
        try {
          await handleUnexpectedBExit(ctx, code, signal);
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
