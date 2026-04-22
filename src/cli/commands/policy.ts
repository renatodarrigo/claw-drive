import * as fs from "node:fs/promises";
import { socketPath, statePath, isValidSessionId } from "../../lib/paths.js";
import { readState } from "../../lib/state.js";
import { sendRequest } from "../../runner/socket-server.js";

export async function cmdPolicy(argv: string[]): Promise<number> {
  const id = argv[0];
  if (!id || !isValidSessionId(id)) {
    console.error("usage: claw-drive policy <session> [--set FILE] [--show]");
    return 2;
  }
  let setFile: string | undefined;
  let show = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--set") setFile = argv[++i];
    else if (argv[i] === "--show") show = true;
  }
  if (show || (!setFile && !show)) {
    const s = await readState(statePath(id));
    if (!s) {
      console.error("session not found");
      return 1;
    }
    console.log(JSON.stringify(s.policy, null, 2));
    return 0;
  }
  if (setFile) {
    const policy = JSON.parse(await fs.readFile(setFile, "utf-8"));
    try {
      const resp = await sendRequest(socketPath(id), {
        id: "cli_" + Date.now(),
        op: "update_policy",
        policy,
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
  return 0;
}
