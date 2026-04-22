import * as fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import {
  eventsPath,
  mcpConfigPath,
  readyMarkerPath,
  runnerLogPath,
  runnerPidPath,
  settingsPath,
  socketPath,
  statePath,
} from "../lib/paths.js";
import { readState, writeState, type SessionState } from "../lib/state.js";
import { appendEvent, type Event } from "../lib/events.js";
import { policyDigest, matchPolicy, deriveRuleFromResolved, validatePolicy } from "../lib/policy.js";
import { parseClaudeLine } from "./stream-parser.js";
import { startSocketServer } from "./socket-server.js";
import type { ControlRequest, ControlResponse } from "../lib/socket-protocol.js";

interface RunnerContext {
  sessionId: string;
  state: SessionState;
  b: ChildProcess;
  currentTurnId: string | null;
  seq: number;
  pendingApprovals: Map<string, PendingApproval>;
}

// Placeholder type; populated in Task 13 when the approval flow lands.
interface PendingApproval {
  call_id: string;
  turn_id: string;
  tool: string;
  args: Record<string, unknown>;
  default_action: "approve" | "reject";
  resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
  timer: NodeJS.Timeout;
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
        await emitEvent(ctx, {
          kind: "tool_decision_resolved",
          turn_id: turnId,
          call_id,
          action: "reject",
          reason: "escalate_default=false",
          resolved_by: "policy",
        } as Omit<Event, "seq" | "at">);
        return {
          id: req.id,
          ok: true,
          result: { behavior: "deny", message: "denied by policy" },
        };
      }

      // decision.decision === "escalate" — emit required, pause on socket
      const timeoutSec = ctx.state.decision_timeout_seconds ?? 300;
      const timeoutMs = timeoutSec * 1000;
      const defaultAt = new Date(Date.now() + timeoutMs).toISOString();
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
      } as Omit<Event, "seq" | "at">);

      return new Promise<ControlResponse>((resolve) => {
        const timer = setTimeout(async () => {
          ctx.pendingApprovals.delete(call_id);
          await emitEvent(ctx, {
            kind: "tool_decision_resolved",
            turn_id: turnId,
            call_id,
            action: decision.default_action,
            reason: "timeout → default",
            resolved_by: "timeout",
          } as Omit<Event, "seq" | "at">);
          resolve({
            id: req.id,
            ok: true,
            result: {
              behavior: decision.default_action === "approve" ? "allow" : "deny",
            },
          });
        }, timeoutMs);

        ctx.pendingApprovals.set(call_id, {
          call_id,
          turn_id: turnId,
          tool,
          args,
          default_action: decision.default_action,
          resolve: (dec) => {
            clearTimeout(timer);
            resolve({ id: req.id, ok: true, result: dec });
          },
          timer,
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
      ctx.pendingApprovals.delete(req.call_id);

      await emitEvent(ctx, {
        kind: "tool_decision_resolved",
        turn_id: pending.turn_id,
        call_id: req.call_id,
        action: req.action,
        reason: req.reason,
        resolved_by: "user_mcp",
      } as Omit<Event, "seq" | "at">);

      if (req.remember_as_policy) {
        const rule = deriveRuleFromResolved(
          req.action,
          pending.tool,
          pending.args as Record<string, unknown>
        );
        const p = ctx.state.policy;
        if (p !== "bypass") {
          const list = req.action === "approve" ? "auto_approve" : "auto_reject";
          const updated = { ...p, [list]: [...(p[list] ?? []), rule] };
          ctx.state.policy = updated;
          await writeState(statePath(ctx.sessionId), ctx.state);
        }
      }

      // Release the held approver request
      pending.resolve({
        behavior: req.action === "approve" ? "allow" : "deny",
        message: req.reason,
      });

      return { id: req.id, ok: true };
    }

    case "update_policy": {
      const v = validatePolicy(req.policy);
      if (!v.ok) {
        return {
          id: req.id,
          ok: false,
          error: "INVALID_POLICY",
          message: v.error,
        };
      }
      ctx.state.policy = req.policy;
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
      // Return first (so the caller sees ok:true promptly), then tear down.
      setImmediate(async () => {
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
            reason: "stop_session",
            exit_code: code,
          } as Omit<Event, "seq" | "at">);
          await fs.rm(readyMarkerPath(ctx.sessionId), { force: true });
          process.exit(0);
        });
      });
      return { id: req.id, ok: true };
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
  const sess = await readState(statePath(sessionId));
  if (!sess) throw new Error(`no state.json at ${statePath(sessionId)}`);

  await fs.writeFile(runnerPidPath(sessionId), String(process.pid));

  const claudeArgs = [
    "-p",
    "--output-format=stream-json",
    "--input-format=stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfigPath(sessionId),
    "--settings",
    settingsPath(sessionId),
    ...(sess.model ? ["--model", sess.model] : []),
  ];

  const b = spawn("claude", claudeArgs, {
    cwd: sess.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAW_DRIVE_SESSION_ID: sessionId },
  });

  if (!b.stdout || !b.stderr || !b.stdin) {
    throw new Error("failed to set up stdio pipes");
  }

  // Redirect B's stderr to runner log
  const logHandle = await fs.open(runnerLogPath(sessionId), "a");
  const logStream = logHandle.createWriteStream();
  b.stderr.pipe(logStream);

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

  // Touch ready marker — MCP's start_session polls for this
  await fs.writeFile(readyMarkerPath(sessionId), new Date().toISOString());

  const ctx: RunnerContext = {
    sessionId,
    state: sess,
    b,
    currentTurnId: null,
    seq: 1,
    pendingApprovals: new Map(),
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

  const server = await startSocketServer(socketPath(ctx.sessionId), (req) =>
    handleRequest(ctx, req)
  );

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
      sess.exit_code = code;
      sess.status = "stopped";
      writeState(statePath(sessionId), sess).finally(() => resolve());
    });
  });

  // Teardown
  try { server.close(); } catch { /* */ }
  try { b.kill("SIGTERM"); } catch { /* already dead */ }
  await fs.rm(readyMarkerPath(sessionId), { force: true });
  await logHandle.close().catch(() => {});
}

// Standalone entry for `claw-drive runner <session_id>` (wired by dispatcher in Task 26)
if (process.argv[1]?.endsWith("runner.js") && process.argv.length >= 3) {
  runRunner(process.argv[2]).catch((err) => {
    console.error("runner fatal:", err);
    process.exit(1);
  });
}
