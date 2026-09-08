import { eventsPath } from "../../lib/paths.js";
import { isPidAlive } from "../../lib/state.js";
import { readEventsSince } from "../../lib/events.js";
import { aliasWithGeneration } from "../../lib/alias.js";
import { parseFleetFlags, hiddenFleetsHint } from "../../lib/fleet.js";
import { listSessions, sessionsRootExists } from "../../lib/live-sessions.js";

export async function cmdSessions(argv: string[]): Promise<number> {
  // Fleets: the listing is scoped to the acting fleet plus untagged sessions;
  // --all-fleets widens it and adds a FLEET column. Extra positionals are
  // ignored, as they always were.
  const fleet = parseFleetFlags(argv);
  if (!fleet.ok) {
    console.error(fleet.error);
    return 2;
  }
  if (!(await sessionsRootExists())) {
    console.log("(no sessions)");
    return 0;
  }
  const rows = await listSessions(fleet.view);
  const fleetColumn = fleet.view.allFleets;
  const out: string[] = [];
  out.push(["SESSION_ID", "STATUS", "TURNS", "PENDING", "CWD", ...(fleetColumn ? ["FLEET"] : [])].join("\t"));
  let hidden = 0;
  for (const { id, state: s, inView } of rows) {
    if (!inView) {
      hidden++;
      continue;
    }
    const alive = s.runner_pid ? isPidAlive(s.runner_pid) : false;
    const status =
      !alive && (s.status === "ready" || s.status === "running" || s.status === "starting")
        ? "orphaned"
        : s.status;
    const events = (await readEventsSince(eventsPath(id), 0)).events;
    const requiredCalls = new Set(
      events.filter((e) => e.kind === "tool_decision_required").map((e) => (e as any).call_id as string)
    );
    const resolvedCalls = new Set(
      events.filter((e) => e.kind === "tool_decision_resolved").map((e) => (e as any).call_id as string)
    );
    let pending = 0;
    for (const c of requiredCalls) if (!resolvedCalls.has(c)) pending++;
    // CD-10: show the alias inline with the id when present; un-aliased rows
    // render byte-identically to before.
    const idCell = s.alias ? `${id} (${aliasWithGeneration(s.alias, s.generation)})` : id;
    out.push(
      [idCell, status, String(s.turns), String(pending), s.cwd, ...(fleetColumn ? [s.fleet ?? "-"] : [])].join("\t")
    );
  }
  console.log(out.join("\n"));
  if (hidden > 0) console.error(hiddenFleetsHint(hidden));
  return 0;
}
