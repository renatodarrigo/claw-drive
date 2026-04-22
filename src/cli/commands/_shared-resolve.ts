import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, socketPath, isValidSessionId } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";
import { sendRequest } from "../../runner/socket-server.js";
import type { DecisionAction } from "../../lib/policy.js";

export async function resolveCmd(
  action: DecisionAction,
  argv: string[]
): Promise<number> {
  const callId = argv[0];
  if (!callId) {
    console.error(`usage: claw-drive ${action} <call_id> [--reason R]`);
    return 2;
  }
  let reason = `${action}d via CLI`;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--reason") reason = argv[++i] ?? reason;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    console.error("no sessions");
    return 1;
  }
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const s = await readState(statePath(id));
    if (!s || !s.runner_pid || !isPidAlive(s.runner_pid)) continue;
    try {
      const resp = await sendRequest(socketPath(id), {
        id: "cli_" + Date.now(),
        op: "resolve_tool_call",
        call_id: callId,
        action,
        reason,
      });
      if (resp.ok) {
        console.log(JSON.stringify({ session_id: id, ok: true }));
        return 0;
      }
      if ((resp as any).error === "NOT_PENDING") continue;
      console.error(JSON.stringify(resp));
      return 1;
    } catch {
      continue;
    }
  }
  console.error("call_id not found in any live session");
  return 1;
}
