/**
 * context-rotation — shared session scaffolding + runner spawn. Extracted from the two
 * near-duplicate start paths (cli/commands/start.ts and mcp/server.ts) so the
 * rotate choreography (runner) and `recover` can spawn successors through the
 * exact same machinery. Pure-ish: only touches the session dir it creates.
 */
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  approverBinPath,
  clawDriveBinPath,
  mcpConfigPath,
  readyMarkerPath,
  sessionDir,
  settingsPath,
  statePath,
} from "./paths.js";
import { writeState, type SessionState } from "./state.js";
import type { Policy } from "./policy.js";

export function newSessionId(): string {
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

export interface ScaffoldInput {
  sessionId: string;
  cwd: string;
  policy: Policy;
  decisionTimeoutSeconds: number;
  model: string | null;
  scenarioBrief?: string;
  wrapper?: boolean;
  alias?: string;
  mcpServers?: Record<string, unknown>;
  /** Context rotation: lineage stamp for rotation/recover successors. Absent on fresh starts. */
  lineage?: { generation: number; root_session_id: string; rotated_from: string };
}

export async function scaffoldSessionDir(input: ScaffoldInput): Promise<void> {
  const dir = sessionDir(input.sessionId);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(
    mcpConfigPath(input.sessionId),
    JSON.stringify({ mcpServers: input.mcpServers ?? {} }, null, 2)
  );

  const approverCmd = `${approverBinPath()} ${input.sessionId}`;
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: approverCmd, timeout: 600 }] },
      ],
    },
  };
  await fs.writeFile(settingsPath(input.sessionId), JSON.stringify(settings, null, 2));

  const state: SessionState = {
    session_id: input.sessionId,
    status: "starting",
    cwd: input.cwd,
    policy: input.policy,
    decision_timeout_seconds: input.decisionTimeoutSeconds,
    model: input.model,
    runner_pid: null,
    started_at: new Date().toISOString(),
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
  };
  if (input.scenarioBrief) {
    (state as SessionState & { scenario_brief?: string }).scenario_brief = input.scenarioBrief;
  }
  if (input.wrapper !== undefined) state.wrapper = input.wrapper;
  if (input.alias !== undefined) state.alias = input.alias;
  if (input.lineage) {
    state.generation = input.lineage.generation;
    state.root_session_id = input.lineage.root_session_id;
    state.rotated_from = input.lineage.rotated_from;
  } else if (input.policy !== "bypass" && input.policy.rotation) {
    // Context rotation: a rotation-configured fresh start begins its lineage at
    // generation 1 so displays can show "alias (1)" from the first session.
    state.generation = 1;
    state.root_session_id = input.sessionId;
  }
  await writeState(statePath(input.sessionId), state);
}

export function spawnRunnerDetached(sessionId: string): void {
  const child = spawn(clawDriveBinPath(), ["runner", sessionId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function waitForReady(sessionId: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(readyMarkerPath(sessionId));
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
}
