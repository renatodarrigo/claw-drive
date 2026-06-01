import { socketPath } from "../../lib/paths.js";
import { sendRequest } from "../../runner/socket-server.js";
import { resolveSessionRef } from "../../lib/alias.js";

export async function cmdSend(argv: string[]): Promise<number> {
  const ref = argv[0];
  const message = argv[1];
  if (!ref || !message) {
    console.error(`usage: claw-drive send <session> "<message>"`);
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
      op: "send_turn",
      message,
    });
    if (!resp.ok) {
      console.error(JSON.stringify(resp));
      return 1;
    }
    console.log(JSON.stringify(resp.result));
    return 0;
  } catch (e) {
    console.error(String(e));
    return 1;
  }
}
