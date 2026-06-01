import { socketPath } from "../../lib/paths.js";
import { sendRequest } from "../../runner/socket-server.js";
import { resolveSessionRef } from "../../lib/alias.js";

export async function cmdStop(argv: string[]): Promise<number> {
  const ref = argv[0];
  if (!ref) {
    console.error("usage: claw-drive stop <session>");
    return 2;
  }
  const id = await resolveSessionRef(ref);
  if (id === null) {
    console.error(`no live session for '${ref}'`);
    return 2;
  }
  try {
    const resp = await sendRequest(socketPath(id), {
      id: "cli_" + Date.now(),
      op: "stop_session",
    });
    if (!resp.ok) {
      console.error(JSON.stringify(resp));
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(String(e));
    return 1;
  }
}
