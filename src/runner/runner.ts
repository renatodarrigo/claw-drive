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

interface RunnerContext {
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
 * Shared by the stop_session control op and the CD-4 budget breaker.
 */
function teardownSession(ctx: RunnerContext, reason: string): void {
  ctx.stopping = true;
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
  ctx.b.once("exit", async (code) => {
    clearTimeout(killSigterm);
    clearTimeout(killSigkill);
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
      const { events } = parseClaudeLine(parsed, ctx.currentTurnId ?? "turn_unknown");
      for (const partial of events) {
        await emitEvent(ctx, partial as Omit<Event, "seq" | "at">);
      }
    }
  }
}

async function handleRequest(
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
    process.on("SIGTERM", () => resolve());
    process.on("SIGINT", () => resolve());
    b.on("exit", (code) => {
      // If stop_session is managing teardown, let it handle session_stopped + process.exit.
      if (ctx.stopping) return;
      sess.exit_code = code;
      sess.status = "stopped";
      writeState(statePath(sessionId), sess).finally(() => resolve());
    });
  });

  // Teardown (only reached when NOT in a stop_session flow). The runner-log
  // capture is closed by the process.once("exit") hook installed at startup, so
  // it's torn down exactly once across every exit path.
  try { server.close(); } catch { /* */ }
  try { b.kill("SIGTERM"); } catch { /* already dead */ }
  await fs.rm(readyMarkerPath(sessionId), { force: true });
}

// Standalone entry for `claw-drive runner <session_id>` (wired by dispatcher in Task 26)
if (process.argv[1]?.endsWith("runner.js") && process.argv.length >= 3) {
  runRunner(process.argv[2]).catch((err) => {
    console.error("runner fatal:", err);
    process.exit(1);
  });
}
