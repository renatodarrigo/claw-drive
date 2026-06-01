import * as fs from "node:fs/promises";
import { socketPath, statePath, isValidSessionId } from "../../lib/paths.js";
import { readState } from "../../lib/state.js";
import { sendRequest } from "../../runner/socket-server.js";
import { cmdPolicyLint } from "./policy-lint.js";
import { resolveSessionRef } from "../../lib/alias.js";

export async function cmdPolicy(argv: string[]): Promise<number> {
  // `policy lint <file>` — static policy-file analysis (no session); CD-5.
  if (argv[0] === "lint") return cmdPolicyLint(argv.slice(1));
  const ref = argv[0];
  if (!ref) {
    console.error("usage: claw-drive policy <session> [--set FILE] [--show]");
    return 2;
  }
  const id = await resolveSessionRef(ref);
  if (id === null) {
    console.error(`no live session for '${ref}'`);
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
