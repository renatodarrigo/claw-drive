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
import { policyDigest } from "../lib/policy.js";

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

  // Placeholder for Tasks 11–15: runStdoutLoop(ctx), startSocketServer(...), etc.
  // For Task 10, we just wait for a signal or B's exit.
  void ctx;

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
