import { socketPath } from "../../lib/paths.js";
import { sendRequest } from "../../runner/socket-server.js";
import { resolveSessionRef } from "../../lib/alias.js";

/**
 * Context rotation: the rotate choreography includes up to two 600s handover turns plus
 * successor spawn — far beyond sendRequest's 5s default. 25 min ceiling.
 */
const ROTATE_CLIENT_TIMEOUT_MS = 1_500_000;

export async function cmdRotate(argv: string[]): Promise<number> {
  const ref = argv[0];
  if (!ref) {
    console.error("usage: claw-drive rotate <session>");
    return 2;
  }
  const id = await resolveSessionRef(ref);
  if (id === null) {
    console.error(`no live session for '${ref}'`);
    return 2;
  }
  try {
    const resp = await sendRequest(
      socketPath(id),
      { id: "cli_" + Date.now(), op: "rotate" },
      ROTATE_CLIENT_TIMEOUT_MS
    );
    if (!resp.ok) {
      console.error(JSON.stringify(resp));
      return 1;
    }
    const result = (resp as { result?: Record<string, unknown> }).result ?? {};
    console.log(String(result.new_session_id ?? ""));
    return 0;
  } catch (e) {
    console.error(String(e));
    return 1;
  }
}
