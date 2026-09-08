import { statePath, eventsPath } from "../../lib/paths.js";
import { readState, isPidAlive } from "../../lib/state.js";
import { readEventsSince } from "../../lib/events.js";
import { resolveSessionRef } from "../../lib/alias.js";
import { parseFleetFlags, FLEET_FLAGS_SINGLE_FORM_ERROR } from "../../lib/fleet.js";
import { listSessions, sessionsRootExists } from "../../lib/live-sessions.js";

export async function cmdPending(argv: string[]): Promise<number> {
  // Fleets: the no-arg listing is scoped to the fleet view; an explicit
  // target resolves across fleets and takes no fleet flags.
  const fleet = parseFleetFlags(argv);
  if (!fleet.ok) {
    console.error(fleet.error);
    return 2;
  }
  const target = fleet.rest[0];
  let ids: string[];
  if (target) {
    if (fleet.flagsSeen) {
      console.error(FLEET_FLAGS_SINGLE_FORM_ERROR);
      return 2;
    }
    // CD-10: accept a canonical id or a live alias.
    const id = await resolveSessionRef(target);
    if (id === null) {
      console.error(`no live session for '${target}'`);
      return 2;
    }
    ids = [id];
  } else {
    if (!(await sessionsRootExists())) {
      console.log("(no sessions)");
      return 0;
    }
    ids = (await listSessions(fleet.view)).filter((r) => r.inView).map((r) => r.id);
  }
  for (const id of ids) {
    const s = await readState(statePath(id));
    if (!s || (s.runner_pid && !isPidAlive(s.runner_pid))) continue;
    const events = (await readEventsSince(eventsPath(id), 0)).events;
    const resolved = new Set(
      events.filter((e) => e.kind === "tool_decision_resolved").map((e) => (e as any).call_id as string)
    );
    const pending = events.filter(
      (e) => e.kind === "tool_decision_required" && !resolved.has((e as any).call_id)
    );
    for (const p of pending) {
      // CD-10: include the alias alongside session_id when the session has
      // one; un-aliased lines are byte-identical (no alias key). alias is the
      // bare machine-readable name (CD-1: pre-existing fields are
      // additive-only) — display formatting like "name (2)" is a
      // human-table concern (see aliasWithGeneration). generation is an
      // additive optional passthrough alongside it.
      const tag = {
        session_id: id,
        ...(s.alias ? { alias: s.alias } : {}),
        ...(s.generation !== undefined ? { generation: s.generation } : {}),
        // Fleets: additive, present only when the session is tagged.
        ...(s.fleet ? { fleet: s.fleet } : {}),
      };
      console.log(JSON.stringify({ ...tag, ...p }));
    }
  }
  return 0;
}
