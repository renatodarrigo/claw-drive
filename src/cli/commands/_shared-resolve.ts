import { socketPath } from "../../lib/paths.js";
import { isPidAlive } from "../../lib/state.js";
import { sendRequest } from "../../runner/socket-server.js";
import { validateRule, type DecisionAction, type Rule } from "../../lib/policy.js";
import { parseFleetFlags } from "../../lib/fleet.js";
import { listSessions, sessionsRootExists } from "../../lib/live-sessions.js";

export type ParsedResolve =
  | { ok: false; error: string }
  | {
      ok: true;
      callId: string;
      reason: string;
      preview: boolean;
      json: boolean;
      remember: boolean;
      rememberedRule: Rule | null;
    };

const usage = (action: string) =>
  `usage: claw-drive ${action} <call_id> [--reason R] [--remember | --remember-as JSON | --preview] [--json] [--fleet TAG] [--all-fleets]`;

export function parseResolveArgs(action: DecisionAction, argv: string[]): ParsedResolve {
  const callId = argv[0];
  if (!callId || callId.startsWith("--")) return { ok: false, error: usage(action) };
  const pastTense: Record<DecisionAction, string> = {
    approve: "approved",
    reject: "rejected",
    defer: "deferred",
  };
  let reason = `${pastTense[action]} via CLI`;
  let preview = false;
  let json = false;
  let remember = false;
  let rememberAsRaw: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reason") reason = argv[++i] ?? reason;
    else if (a === "--remember") remember = true;
    else if (a === "--remember-as") rememberAsRaw = argv[++i] ?? "";
    else if (a === "--preview") preview = true;
    else if (a === "--json") json = true;
    else return { ok: false, error: `unknown flag: ${a}` };
  }
  if (remember && rememberAsRaw !== null) {
    return { ok: false, error: "use one of --remember or --remember-as, not both" };
  }
  let rememberedRule: Rule | null = null;
  if (rememberAsRaw !== null) {
    if (rememberAsRaw === "") return { ok: false, error: "--remember-as requires a JSON rule" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rememberAsRaw);
    } catch (e) {
      return { ok: false, error: `--remember-as invalid JSON: ${(e as Error).message}` };
    }
    const v = validateRule(parsed);
    if (!v.ok) return { ok: false, error: `--remember-as invalid rule: ${v.error}` };
    rememberedRule = parsed as Rule;
  }
  return { ok: true, callId, reason, preview, json, remember, rememberedRule };
}

export function renderPreviewHuman(res: {
  would_remember: Rule;
  list: string;
  source: string;
  bypass?: boolean;
}): string {
  const r = res.would_remember;
  const lines: string[] = [];
  lines.push(`would remember → ${res.list}   [${res.source}]`);
  if (r.tool === "Bash" && r.bash_command_matches) {
    lines.push(`  Bash where command matches  ${r.bash_command_matches}`);
  } else if (r.arg_matches) {
    const parts = Object.entries(r.arg_matches).map(([k, v]) => `${k} matches ${v}`);
    lines.push(`  ${r.tool} where ${parts.join("; ")}`);
  } else {
    lines.push(`  ${r.tool} (tool-wide)`);
  }
  if (res.bypass) lines.push(`  note: policy is "bypass" — remember is a no-op`);
  return lines.join("\n");
}

export async function resolveCmd(action: DecisionAction, argv: string[]): Promise<number> {
  // Fleets: the call-id scan walks only the fleet view's live sessions;
  // --all-fleets widens it. Lifted before the resolve parser sees argv.
  const fleet = parseFleetFlags(argv);
  if (!fleet.ok) {
    console.error(fleet.error);
    return 2;
  }
  const parsed = parseResolveArgs(action, fleet.rest);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  if (!(await sessionsRootExists())) {
    console.error("no sessions");
    return 1;
  }
  const rows = await listSessions(fleet.view);
  for (const { id, state: s, inView } of rows) {
    if (!inView) continue;
    if (!s.runner_pid || !isPidAlive(s.runner_pid)) continue;
    try {
      const resp = await sendRequest(socketPath(id), {
        id: "cli_" + Date.now(),
        op: "resolve_tool_call",
        call_id: parsed.callId,
        action,
        reason: parsed.reason,
        remember_as_policy: parsed.remember || undefined,
        preview_only: parsed.preview || undefined,
        remembered_rule: parsed.rememberedRule ?? undefined,
      });
      if (resp.ok) {
        const result = (resp as { result?: Record<string, unknown> }).result;
        if (parsed.preview) {
          if (parsed.json) console.log(JSON.stringify(result ?? {}));
          else if (result) console.log(renderPreviewHuman(result as Parameters<typeof renderPreviewHuman>[0]));
          else console.log(JSON.stringify(result ?? { ok: true }));
        } else {
          console.log(JSON.stringify({ session_id: id, ok: true }));
        }
        return 0;
      }
      if ((resp as { error?: string }).error === "NOT_PENDING") continue;
      console.error(JSON.stringify(resp));
      return 1;
    } catch {
      continue;
    }
  }
  console.error("call_id not found in any live session");
  return 1;
}
