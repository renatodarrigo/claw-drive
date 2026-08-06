import { isValidSessionId } from "../../lib/paths.js";
import { recoverSession } from "../../lib/recover.js";

export async function cmdRecover(argv: string[]): Promise<number> {
  let ref: string | undefined;
  let noStart = false;
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-start") noStart = true;
    else if (argv[i] === "--model") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("--model requires a value: claw-drive recover <session_id> [--no-start] [--model M]");
        return 2;
      }
      model = value;
      i++;
    } else if (!argv[i].startsWith("--")) ref = argv[i];
  }
  if (!ref) {
    console.error("usage: claw-drive recover <session_id> [--no-start] [--model M]");
    return 2;
  }
  if (!isValidSessionId(ref)) {
    // Aliases resolve only among LIVE sessions; recover targets dead ones.
    console.error(`recover targets dead sessions — pass the canonical sess_… id (got '${ref}')`);
    return 2;
  }
  const out = await recoverSession({ sessionId: ref, model: model ?? null, noStart });
  if (!out.ok) {
    console.error(JSON.stringify(out));
    return 1;
  }
  console.log(out.result.new_session_id ?? out.result.handover_path);
  return 0;
}
