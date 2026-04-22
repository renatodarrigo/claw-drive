import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, socketPath, isValidSessionId } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";
import { sendRequest } from "../../runner/socket-server.js";

/**
 * Usage:
 *   claw-drive provide-output <call_id> [--stdout <str>] [--stderr <str>] [--exit N] [--extra <str>]
 *   claw-drive provide-output <call_id> --from-file <path>   (alt: read stdout from a file)
 *
 * Scans live sessions for the deferred/pending call_id; first match wins.
 */
export async function cmdProvideOutput(argv: string[]): Promise<number> {
  const callId = argv[0];
  if (!callId) {
    console.error(
      "usage: claw-drive provide-output <call_id> [--stdout S] [--stderr S] [--exit N] [--extra S] [--from-file PATH]"
    );
    return 2;
  }

  let stdout: string | undefined;
  let stderr: string | undefined;
  let exit_code: number | undefined;
  let extra: string | undefined;
  let fromFile: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--stdout": stdout = argv[++i]; break;
      case "--stderr": stderr = argv[++i]; break;
      case "--exit": exit_code = Number(argv[++i]); break;
      case "--extra": extra = argv[++i]; break;
      case "--from-file": fromFile = argv[++i]; break;
      default:
        console.error(`unknown flag: ${flag}`);
        return 2;
    }
  }

  if (fromFile) {
    try {
      stdout = (stdout ?? "") + (await fs.readFile(fromFile, "utf-8"));
    } catch (e) {
      console.error(`failed to read --from-file ${fromFile}: ${(e as Error).message}`);
      return 1;
    }
  }

  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    console.error("no sessions directory");
    return 1;
  }
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const s = await readState(statePath(id));
    if (!s || !s.runner_pid || !isPidAlive(s.runner_pid)) continue;
    try {
      const resp = await sendRequest(socketPath(id), {
        id: "cli_" + Date.now(),
        op: "provide_tool_output",
        call_id: callId,
        stdout,
        stderr,
        exit_code,
        extra,
      });
      if (resp.ok) {
        console.log(JSON.stringify({ session_id: id, ok: true, result: resp.result ?? {} }));
        return 0;
      }
      // CALL_NOT_FOUND → call isn't in this session, scan next.
      // UNKNOWN_OP     → this runner is from an earlier version that doesn't
      //                  speak provide_tool_output; skip and try the next.
      // NOT_PENDING    → defensive; older runners may use this for unknown call_ids.
      const resolvableErrors = new Set(["CALL_NOT_FOUND", "UNKNOWN_OP", "NOT_PENDING"]);
      if (resolvableErrors.has((resp as any).error)) continue;
      console.error(JSON.stringify(resp));
      return 1;
    } catch {
      continue;
    }
  }
  console.error("call_id not found in any live session (deferred or pending)");
  return 1;
}
