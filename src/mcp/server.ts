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
  isInsideHome,
  isValidSessionId,
  mcpConfigPath,
  readyMarkerPath,
  sessionDir,
  settingsPath,
  socketPath,
  statePath,
} from "../lib/paths.js";
import { writeState, type SessionState } from "../lib/state.js";
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
    decision_timeout_seconds: (args.decision_timeout_seconds as number) ?? 300,
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
      return ok({ session_id: sessionId });
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

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "claw-drive", version: "0.1.0" },
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
        "Start a new driven Claude Code session in the given cwd. Returns session_id.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          policy: {},
          scenario_brief: { type: "string" },
          mcp_extra_config: { type: "object" },
          model: { type: "string" },
          decision_timeout_seconds: { type: "number" },
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
