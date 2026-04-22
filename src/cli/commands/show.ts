import { statePath, eventsPath, isValidSessionId } from "../../lib/paths.js";
import { readState } from "../../lib/state.js";
import { readEventsSince } from "../../lib/events.js";

export async function cmdShow(argv: string[]): Promise<number> {
  const id = argv[0];
  if (!id || !isValidSessionId(id)) {
    console.error("usage: claw-drive show <session_id>");
    return 2;
  }
  const s = await readState(statePath(id));
  if (!s) {
    console.error("session not found");
    return 1;
  }
  console.log(JSON.stringify(s, null, 2));
  const { events } = await readEventsSince(eventsPath(id), 0);
  const last20 = events.slice(-20);
  console.log("\n=== last 20 events ===");
  for (const e of last20) console.log(JSON.stringify(e));
  return 0;
}
