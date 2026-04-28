import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import {
  approverBinPath,
  eventsPath,
  isInsideHome,
  isValidSessionId,
  mcpConfigPath,
  readyMarkerPath,
  sessionDir,
  sessionsRoot,
  settingsPath,
  socketPath,
  statePath,
} from "../lib/paths.js";
import { readEventsSince, type Event } from "../lib/events.js";
import { writeState, readState, isPidAlive, type SessionState } from "../lib/state.js";
import { validatePolicy, type Policy } from "../lib/policy.js";
import { sendRequest } from "../runner/socket-server.js";

function newSessionId(): string {
  // sess_YYYYMMDDTHHMMSS_<6char>
  const now = new Date();
  const ts =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    "T" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0");
  const nonce = Math.random().toString(36).slice(2, 8);
  return `sess_${ts}_${nonce}`;
}

function err(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

async function handleStartSession(args: Record<string, unknown>) {
  const cwd = args.cwd;
  if (typeof cwd !== "string") return err("INVALID_CWD", "cwd must be a string");
  try {
    const st = await fs.stat(cwd);
    if (!st.isDirectory()) return err("INVALID_CWD", "cwd is not a directory");
  } catch {
    return err("INVALID_CWD", "cwd does not exist");
  }
  if (!isInsideHome(cwd)) return err("INVALID_CWD", "cwd must be inside $HOME");

  const policy: Policy = (args.policy as Policy) ?? "bypass";
  const pv = validatePolicy(policy);
  if (!pv.ok) return err("INVALID_POLICY", (pv as { ok: false; error: string }).error);

  const sessionId = newSessionId();
  if (!isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "generated session_id failed validation");
  }
  const dir = sessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true });

  // Write mcp.json — just the caller-provided extras, or an empty mcpServers.
  // The approver is registered via settings.json (PreToolUse hook), not MCP.
  const extra = (args.mcp_extra_config as Record<string, unknown>) ?? {};
  const mcpConfig = {
    mcpServers: (extra.mcpServers as Record<string, unknown>) ?? {},
  };
  await fs.writeFile(mcpConfigPath(sessionId), JSON.stringify(mcpConfig, null, 2));

  // Write settings.json — registers the PreToolUse hook with a 600s timeout.
  // Matcher "*" covers every tool.
  const approverCmd = `${approverBinPath()} ${sessionId}`;
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: approverCmd,
              timeout: 600,
            },
          ],
        },
      ],
    },
  };
  await fs.writeFile(settingsPath(sessionId), JSON.stringify(settings, null, 2));

  const state: SessionState = {
    session_id: sessionId,
    status: "starting",
    cwd,
    policy,
    decision_timeout_seconds: (args.decision_timeout_seconds as number) ?? 3600,
    model: (args.model as string | null) ?? null,
    runner_pid: null,
    started_at: new Date().toISOString(),
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
  };
  if (typeof args.scenario_brief === "string") {
    (state as SessionState & { scenario_brief?: string }).scenario_brief = args.scenario_brief;
  }
  if (typeof args.wrapper === "boolean") {
    state.wrapper = args.wrapper;
  }
  await writeState(statePath(sessionId), state);

  // Spawn the runner detached. The runner binary is our own dispatcher.
  // It will be wired in Task 26; for now, invoke `node <dist>/index.js runner <id>`
  // via a local resolver.
  const selfBin = resolveSelfBinPath();
  const child = spawn(selfBin, ["runner", sessionId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for the runner's ready marker up to 5s
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.access(readyMarkerPath(sessionId));
      const selfBinAbs = resolveSelfBinPath();
      return ok({
        session_id: sessionId,
        watch_command: {
          command: selfBinAbs,
          args: ["watch", sessionId],
          description: `notable events from claw-drive session ${sessionId}`,
          timeout_ms: 3_600_000,
          persistent: true,
        },
      });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Cleanup on timeout
  await fs.rm(dir, { recursive: true, force: true });
  return err("START_FAILED", "runner did not become ready within 5s");
}

/** Resolve the absolute path to the installed `bin/claw-drive` dispatcher. */
function resolveSelfBinPath(): string {
  // Our dist layout: <pkg>/dist/mcp/server.js; <pkg>/bin/claw-drive
  const url = new URL("../../bin/claw-drive", import.meta.url);
  return url.pathname;
}

async function handleStopSession(args: Record<string, unknown>) {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  try {
    const resp = await sendRequest(socketPath(sessionId), {
      id: "stop_" + Date.now(),
      op: "stop_session",
    });
    if (!resp.ok) return err(resp.error, resp.message);
    return ok({ ok: true });
  } catch (e) {
    return err("SESSION_UNREACHABLE", (e as Error).message);
  }
}

async function readEventsWithWait(
  sessionId: string,
  since: number,
  waitMs: number,
  turnId?: string
): Promise<{ events: Event[]; nextSince: number }> {
  const filterTurn = (events: Event[]) =>
    turnId ? events.filter((e) => (e as any).turn_id === turnId) : events;

  let cur = await readEventsSince(eventsPath(sessionId), since);
  let filtered = filterTurn(cur.events);
  if (filtered.length > 0 || waitMs <= 0) {
    return { events: filtered, nextSince: cur.nextSince };
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(200, deadline - Date.now())));
    cur = await readEventsSince(eventsPath(sessionId), since);
    filtered = filterTurn(cur.events);
    if (filtered.length > 0) return { events: filtered, nextSince: cur.nextSince };
  }
  return { events: [], nextSince: cur.nextSince };
}

function deriveTurnStatus(
  allEvents: Event[],
  turnId: string
): "running" | "awaiting_approval" | "completed" | "failed" {
  const turnEvents = allEvents.filter((e) => (e as any).turn_id === turnId);
  if (turnEvents.some((e) => e.kind === "turn_completed")) return "completed";
  if (turnEvents.some((e) => e.kind === "turn_failed")) return "failed";
  const requiredCalls = new Set(
    turnEvents
      .filter((e) => e.kind === "tool_decision_required")
      .map((e) => (e as any).call_id as string)
  );
  const resolvedCalls = new Set(
    turnEvents
      .filter((e) => e.kind === "tool_decision_resolved")
      .map((e) => (e as any).call_id as string)
  );
  for (const c of requiredCalls) if (!resolvedCalls.has(c)) return "awaiting_approval";
  return "running";
}

async function handleSendTurn(args: Record<string, any>) {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  if (typeof args.message !== "string") {
    return err("BAD_REQUEST", "message must be a string");
  }
  try {
    const resp = await sendRequest(socketPath(sessionId), {
      id: "st_" + Date.now(),
      op: "send_turn",
      message: args.message,
    });
    if (!resp.ok) return err(resp.error, resp.message);
    return ok(resp.result ?? {});
  } catch (e) {
    return err("SESSION_UNREACHABLE", (e as Error).message);
  }
}

async function handlePollTurn(args: Record<string, any>) {
  const sessionId = args.session_id;
  const turnId = args.turn_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  if (typeof turnId !== "string" || !turnId.startsWith("turn_")) {
    return err("TURN_NOT_FOUND", "invalid turn_id");
  }
  const since = typeof args.since_event === "number" ? args.since_event : 0;
  const waitMs = typeof args.wait_ms === "number" ? args.wait_ms : 0;
  const { events: newEvents, nextSince } = await readEventsWithWait(
    sessionId,
    since,
    waitMs,
    turnId
  );
  // For status derivation, read ALL events for the turn (not just since)
  const all = (await readEventsSince(eventsPath(sessionId), 0)).events;
  const turn_status = deriveTurnStatus(all, turnId);
  return ok({ events: newEvents, turn_status, next_since: nextSince });
}

async function handlePollSession(args: Record<string, any>) {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  const since = typeof args.since_event === "number" ? args.since_event : 0;
  const waitMs = typeof args.wait_ms === "number" ? args.wait_ms : 0;
  const { events, nextSince } = await readEventsWithWait(sessionId, since, waitMs);
  const state = await readState(statePath(sessionId));
  let session_status: string = state?.status ?? "orphaned";
  if (state && state.runner_pid && !isPidAlive(state.runner_pid)) {
    if (state.status === "ready" || state.status === "running" || state.status === "starting") {
      session_status = "orphaned";
    }
  }
  return ok({ events, session_status, next_since: nextSince });
}

async function handleListSessions(args: Record<string, any>) {
  const includeOrphaned = args.include_orphaned ?? true;
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    return ok({ sessions: [] });
  }
  const out: any[] = [];
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const s = await readState(statePath(id));
    if (!s) continue;
    const alive = s.runner_pid ? isPidAlive(s.runner_pid) : false;
    let effectiveStatus = s.status;
    if (!alive && (s.status === "ready" || s.status === "running" || s.status === "starting")) {
      effectiveStatus = "orphaned";
    }
    if (!includeOrphaned && effectiveStatus === "orphaned") continue;
    const events = (await readEventsSince(eventsPath(id), 0)).events;
    const requiredCalls = new Set(
      events
        .filter((e) => e.kind === "tool_decision_required")
        .map((e) => (e as any).call_id as string)
    );
    const resolvedCalls = new Set(
      events
        .filter((e) => e.kind === "tool_decision_resolved")
        .map((e) => (e as any).call_id as string)
    );
    let pendingCount = 0;
    for (const c of requiredCalls) if (!resolvedCalls.has(c)) pendingCount++;
    out.push({
      session_id: id,
      status: effectiveStatus,
      cwd: s.cwd,
      started_at: s.started_at,
      last_event_at: s.last_event_at,
      turns: s.turns,
      pending_approvals: pendingCount,
    });
  }
  return ok({ sessions: out });
}

async function handleResolveToolCall(args: Record<string, any>) {
  if (typeof args.call_id !== "string") return err("BAD_REQUEST", "call_id required");
  if (args.action !== "approve" && args.action !== "reject") {
    return err("BAD_REQUEST", "action must be 'approve' or 'reject'");
  }
  if (typeof args.reason !== "string") return err("BAD_REQUEST", "reason required");

  // Scan live sessions for the pending call_id. The approve_tool request flow
  // registers each pending entry keyed by call_id in the runner's in-memory
  // Map. Only one session at a time can hold a given call_id, so first hit wins.
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    return err("SESSION_NOT_FOUND", "no sessions directory");
  }
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const s = await readState(statePath(id));
    if (!s || !s.runner_pid || !isPidAlive(s.runner_pid)) continue;
    try {
      const resp = await sendRequest(socketPath(id), {
        id: "rtc_" + Date.now(),
        op: "resolve_tool_call",
        call_id: args.call_id,
        action: args.action,
        reason: args.reason,
        remember_as_policy: Boolean(args.remember_as_policy),
      });
      if (resp.ok) return ok({ ok: true });
      if (resp.error === "NOT_PENDING") continue; // try next session
      return err(resp.error, resp.message);
    } catch {
      continue;
    }
  }
  return err("CALL_NOT_FOUND", "call_id not found in any live session");
}

async function handleProvideToolOutput(args: Record<string, any>) {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  if (typeof args.call_id !== "string" || args.call_id.length === 0) {
    return err("BAD_REQUEST", "call_id required");
  }
  for (const field of ["stdout", "stderr", "extra"] as const) {
    if (args[field] !== undefined && typeof args[field] !== "string") {
      return err("BAD_REQUEST", `${field} must be a string if provided`);
    }
  }
  if (args.exit_code !== undefined && typeof args.exit_code !== "number") {
    return err("BAD_REQUEST", "exit_code must be a number if provided");
  }
  try {
    const resp = await sendRequest(socketPath(sessionId), {
      id: "pto_" + Date.now(),
      op: "provide_tool_output",
      call_id: args.call_id,
      stdout: args.stdout,
      stderr: args.stderr,
      exit_code: args.exit_code,
      extra: args.extra,
    });
    if (!resp.ok) return err(resp.error, resp.message);
    return ok(resp.result ?? {});
  } catch (e) {
    return err("SESSION_UNREACHABLE", (e as Error).message);
  }
}

async function handleUpdatePolicy(args: Record<string, any>) {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  const pv = validatePolicy(args.policy);
  if (!pv.ok) return err("INVALID_POLICY", (pv as any).error);
  try {
    const resp = await sendRequest(socketPath(sessionId), {
      id: "up_" + Date.now(),
      op: "update_policy",
      policy: args.policy,
    });
    if (!resp.ok) return err(resp.error, resp.message);
    return ok({ ok: true });
  } catch (e) {
    return err("SESSION_UNREACHABLE", (e as Error).message);
  }
}

async function handleInterruptTurn(args: Record<string, any>) {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) {
    return err("SESSION_NOT_FOUND", "invalid session_id");
  }
  try {
    const resp = await sendRequest(socketPath(sessionId), {
      id: "int_" + Date.now(),
      op: "interrupt_turn",
      turn_id: String(args.turn_id ?? ""),
    });
    if (!resp.ok) return err(resp.error, resp.message);
    return ok({ ok: true });
  } catch (e) {
    return err("SESSION_UNREACHABLE", (e as Error).message);
  }
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "claw-drive", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );

  type HandlerResult = ReturnType<typeof err> | ReturnType<typeof ok>;
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    handler: (args: Record<string, unknown>) => Promise<HandlerResult>;
  }> = [
    {
      name: "start_session",
      description:
        "Start a new driven Claude Code session in the given cwd. " +
        "Returns session_id + watch_command (a ready-made payload for the Monitor tool; invoke " +
        "Monitor(watch_command) to stream only human-actionable events — approvals, deferrals, completions, errors).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          policy: {},
          scenario_brief: { type: "string" },
          mcp_extra_config: { type: "object" },
          model: { type: "string" },
          decision_timeout_seconds: { type: "number" },
          wrapper: {
            type: "boolean",
            description:
              "Whether to inject the v0.5.6 sentinel-token contract wrapper into B's system prompt via --append-system-prompt. Default true. Pass false to opt out (raw v0.5.5-style behavior; watch's token filter then has nothing to anchor on, so combine with --no-token-filter).",
          },
        },
        required: ["cwd"],
      },
      handler: handleStartSession,
    },
    {
      name: "stop_session",
      description:
        "Stop a session. Reaps the fresh Claude Code process; keeps the session dir for inspection.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
      handler: handleStopSession,
    },
    {
      name: "send_turn",
      description:
        "Send a user turn to a live session. Non-blocking; returns a turn_id the caller can poll.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["session_id", "message"],
      },
      handler: handleSendTurn,
    },
    {
      name: "poll_turn",
      description:
        "Fetch events + derived status for a specific turn. Use wait_ms>0 to long-poll.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          turn_id: { type: "string" },
          since_event: { type: "number" },
          wait_ms: { type: "number" },
        },
        required: ["session_id", "turn_id"],
      },
      handler: handlePollTurn,
    },
    {
      name: "poll_session",
      description:
        "Tail events for a session and return current session status. Use wait_ms>0 to long-poll.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          since_event: { type: "number" },
          wait_ms: { type: "number" },
        },
        required: ["session_id"],
      },
      handler: handlePollSession,
    },
    {
      name: "list_sessions",
      description:
        "List sessions on disk (live + orphaned). Orphaned = state.json status is running/ready/starting but runner_pid is dead.",
      inputSchema: {
        type: "object",
        properties: { include_orphaned: { type: "boolean" } },
      },
      handler: handleListSessions,
    },
    {
      name: "resolve_tool_call",
      description:
        "Approve or reject a paused tool call by call_id. Scans live sessions; first session holding the call_id wins. Set remember_as_policy to append the resolved decision as a new Rule.",
      inputSchema: {
        type: "object",
        properties: {
          call_id: { type: "string" },
          action: { enum: ["approve", "reject"] },
          reason: { type: "string" },
          remember_as_policy: { type: "boolean" },
        },
        required: ["call_id", "action", "reason"],
      },
      handler: handleResolveToolCall,
    },
    {
      name: "provide_tool_output",
      description:
        "Provide the output of a deferred command that the human ran manually. " +
        "Injects the output as a new user turn into the driven session B, so B can continue. " +
        "Auto-resolves any still-pending approval as `defer` if needed.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          call_id: { type: "string" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          exit_code: { type: "number" },
          extra: { type: "string" },
        },
        required: ["session_id", "call_id"],
      },
      handler: handleProvideToolOutput,
    },
    {
      name: "update_policy",
      description: "Replace a session's permission policy.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          policy: {},
        },
        required: ["session_id", "policy"],
      },
      handler: handleUpdatePolicy,
    },
    {
      name: "interrupt_turn",
      description:
        "Send SIGINT to the driven Claude session to interrupt the current turn. Session remains alive.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          turn_id: { type: "string" },
        },
        required: ["session_id", "turn_id"],
      },
      handler: handleInterruptTurn,
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return err("UNKNOWN_TOOL", req.params.name);
    try {
      return await tool.handler((req.params.arguments as Record<string, unknown>) ?? {});
    } catch (e) {
      return err("HANDLER_ERROR", (e as Error).message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
