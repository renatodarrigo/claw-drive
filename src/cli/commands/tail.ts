import * as fs from "node:fs";
import { eventsPath } from "../../lib/paths.js";
import { readEventsSince } from "../../lib/events.js";
import { resolveSessionRef } from "../../lib/alias.js";

export async function cmdTail(argv: string[]): Promise<number> {
  const ref = argv[0];
  if (!ref) {
    console.error("usage: claw-drive tail <session_id> [--since N] [--follow]");
    return 2;
  }
  const id = await resolveSessionRef(ref);
  if (id === null) {
    console.error(`no live session for '${ref}'`);
    return 2;
  }
  let since = 0;
  let follow = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--since") since = Number(argv[++i] ?? 0);
    else if (argv[i] === "--follow" || argv[i] === "-f") follow = true;
  }
  const read = async () => {
    const { events, nextSince } = await readEventsSince(eventsPath(id), since);
    for (const e of events) console.log(JSON.stringify(e));
    since = nextSince;
  };
  await read();
  if (!follow) return 0;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(eventsPath(id), { persistent: true });
  } catch (err) {
    console.error("cannot watch events.jsonl:", (err as Error).message);
    return 1;
  }
  watcher.on("change", () => {
    read().catch(() => {});
  });
  await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  watcher.close();
  return 0;
}
