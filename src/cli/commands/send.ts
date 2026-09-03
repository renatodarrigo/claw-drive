import { socketPath } from "../../lib/paths.js";
import { sendRequest } from "../../runner/socket-server.js";
import { resolveSessionRef } from "../../lib/alias.js";
import { parseFleetFlags, FLEET_FLAGS_SINGLE_FORM_ERROR, type FleetView } from "../../lib/fleet.js";
import { listSessions, isLiveState, sessionsRootExists, type SessionRow } from "../../lib/live-sessions.js";

const USAGE =
  `usage: claw-drive send <session> "<message>"\n` +
  `   or: claw-drive send --all "<message>" [--fleet TAG] [--all-fleets]\n` +
  `  --all: broadcast to every live session in the fleet view — one JSONL line per session;\n` +
  `         exit 0 when every send succeeded, 1 when any failed, 2 when the view has no live session\n` +
  `  --fleet TAG: act as this fleet (default: CLAW_DRIVE_FLEET, else the driver's Claude Code session id)\n` +
  `  --all-fleets: broadcast to every fleet on this machine\n` +
  `  --: end of flags — a message that is literally --all, --fleet, or --all-fleets goes after it`;

export type ParsedSendArgs =
  | { ok: true; all: false; ref: string; message: string }
  | { ok: true; all: true; message: string; view: FleetView }
  | { ok: false; error: string };

/**
 * Pure argv parser for `claw-drive send`. Only --all, --fleet, --all-fleets
 * and a bare `--` are reserved; any other token is a positional, so a
 * message such as "--verbose please" still passes as it always did.
 */
export function parseSendArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedSendArgs {
  const fleet = parseFleetFlags(argv, env);
  if (!fleet.ok) return { ok: false, error: fleet.error };
  const positionals: string[] = [];
  let all = false;
  let endOfFlags = false;
  for (const a of fleet.rest) {
    if (endOfFlags) {
      positionals.push(a);
      continue;
    }
    if (a === "--") {
      endOfFlags = true;
      continue;
    }
    if (a === "--all") {
      all = true;
      continue;
    }
    positionals.push(a);
  }
  if (all) {
    if (positionals.length !== 1 || !positionals[0]) return { ok: false, error: USAGE };
    return { ok: true, all: true, message: positionals[0], view: fleet.view };
  }
  if (fleet.flagsSeen) return { ok: false, error: FLEET_FLAGS_SINGLE_FORM_ERROR };
  const [ref, message] = positionals;
  if (!ref || !message) return { ok: false, error: USAGE };
  return { ok: true, all: false, ref, message };
}

/** One stdout line of `send --all`; keys are emitted in this order. */
export interface SendAllLine {
  session_id: string;
  alias?: string;
  fleet?: string;
  ok: boolean;
  turn_id?: string;
  error?: string;
  message?: string;
}

export type SendFn = typeof sendRequest;

/**
 * Fan the turn out to every target in parallel and report each outcome in
 * the targets' order (the enumerator's sorted-id order). A runner refusal
 * keeps its own error/message; a transport failure — no socket yet,
 * connection refused, timeout, undecodable reply — becomes
 * SESSION_UNREACHABLE. Nothing is skipped: a member that cannot take the
 * turn is a line, not an omission.
 */
export async function sendToFleet(
  targets: SessionRow[],
  message: string,
  deps: { send?: SendFn; timeoutMs?: number } = {}
): Promise<SendAllLine[]> {
  const send = deps.send ?? sendRequest;
  const stamp = Date.now();
  const settled = await Promise.allSettled(
    targets.map((t, n) =>
      send(socketPath(t.id), { id: `cli_${stamp}_${n}`, op: "send_turn", message }, deps.timeoutMs)
    )
  );
  return targets.map((t, i) => {
    const head: SendAllLine = {
      session_id: t.id,
      ...(t.state.alias ? { alias: t.state.alias } : {}),
      ...(t.state.fleet ? { fleet: t.state.fleet } : {}),
      ok: false,
    };
    const r = settled[i];
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { ...head, ok: false, error: "SESSION_UNREACHABLE", message: reason };
    }
    if (!r.value.ok) return { ...head, ok: false, error: r.value.error, message: r.value.message };
    return { ...head, ok: true, turn_id: String(r.value.result?.turn_id ?? "") };
  });
}

async function sendAll(message: string, view: FleetView): Promise<number> {
  const rows = (await sessionsRootExists()) ? await listSessions(view) : [];
  const live = rows.filter((r) => isLiveState(r.state));
  const targets = live.filter((r) => r.inView);
  if (targets.length === 0) {
    const hiddenLive = live.length - targets.length;
    console.error(
      "no live sessions in view" +
        (hiddenLive > 0 ? ` (${hiddenLive} live in other fleets; --all-fleets broadcasts to them)` : "")
    );
    return 2;
  }
  const lines = await sendToFleet(targets, message);
  for (const line of lines) console.log(JSON.stringify(line));
  return lines.every((l) => l.ok) ? 0 : 1;
}

export async function cmdSend(argv: string[]): Promise<number> {
  const parsed = parseSendArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.all) return sendAll(parsed.message, parsed.view);
  const id = await resolveSessionRef(parsed.ref);
  if (id === null) {
    console.error(`no live session for '${parsed.ref}'`);
    return 2;
  }
  try {
    const resp = await sendRequest(socketPath(id), {
      id: "cli_" + Date.now(),
      op: "send_turn",
      message: parsed.message,
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
