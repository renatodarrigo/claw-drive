import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  approverBinPath,
  mcpConfigPath,
  readyMarkerPath,
  sessionDir,
  settingsPath,
  statePath,
} from "../../lib/paths.js";
import { writeState, type SessionState } from "../../lib/state.js";
import { validatePolicy, type Policy } from "../../lib/policy.js";

function newSessionId(): string {
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

export async function cmdStart(argv: string[]): Promise<number> {
  let cwd: string | undefined;
  let policyFile: string | undefined;
  let briefFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") cwd = argv[++i];
    else if (argv[i] === "--policy") policyFile = argv[++i];
    else if (argv[i] === "--brief") briefFile = argv[++i];
  }
  if (!cwd) {
    console.error("--cwd required");
    return 2;
  }
  const cwdAbs = path.resolve(cwd);

  let policy: Policy = "bypass";
  if (policyFile) policy = JSON.parse(await fs.readFile(policyFile, "utf-8"));
  const pv = validatePolicy(policy);
  if (!pv.ok) {
    console.error(`invalid policy: ${(pv as any).error}`);
    return 2;
  }
  const brief = briefFile ? await fs.readFile(briefFile, "utf-8") : undefined;

  const sessionId = newSessionId();
  await fs.mkdir(sessionDir(sessionId), { recursive: true });

  // mcp.json — empty (no caller extras supported from CLI in v0.1)
  await fs.writeFile(
    mcpConfigPath(sessionId),
    JSON.stringify({ mcpServers: {} }, null, 2)
  );

  // settings.json — register the PreToolUse hook pointing at claw-drive-approver
  const approverCmd = `${approverBinPath()} ${sessionId}`;
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: approverCmd, timeout: 600 }],
        },
      ],
    },
  };
  await fs.writeFile(settingsPath(sessionId), JSON.stringify(settings, null, 2));

  const state: SessionState = {
    session_id: sessionId,
    status: "starting",
    cwd: cwdAbs,
    policy,
    decision_timeout_seconds: 300,
    model: null,
    runner_pid: null,
    started_at: new Date().toISOString(),
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
  };
  if (brief) (state as any).scenario_brief = brief;
  await writeState(statePath(sessionId), state);

  // Resolve self bin from this source file's compiled location (dist/cli/commands/start.js)
  const selfBin = new URL("../../../bin/claw-drive", import.meta.url).pathname;
  const child = spawn(selfBin, ["runner", sessionId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.access(readyMarkerPath(sessionId));
      console.log(sessionId);
      return 0;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  console.error("runner did not become ready");
  return 1;
}
