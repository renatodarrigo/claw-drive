import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, eventsPath, isValidSessionId } from "../../lib/paths.js";
import {
  readState,
  isPidAlive,
  type SessionState,
  type SessionStatus as SessionStateStatus,
} from "../../lib/state.js";
import { readEventsSince, type Event } from "../../lib/events.js";
import { policyDigest } from "../../lib/policy.js";

export interface PendingDecisionSnapshot {
  call_id: string;
  tool: string;
  args_summary: string;
  severity: "low" | "medium" | "high";
  default_action: "approve" | "reject" | "defer";
  deferred_at: string;
  age_seconds: number;
}

export interface RecentErrorSnapshot {
  kind: "turn_failed" | "error" | "tool_call_result";
  at: string;
  summary: string;
}

export interface TurnSnapshot {
  turn_id: string;
  started_at: string;
  last_assistant_text?: string;
  last_token: string | null;
}

export interface CompletedTurnSnapshot extends TurnSnapshot {
  completed_at: string;
  stop_reason: string;
}

export interface SessionSnapshot {
  session_id: string;
  status: SessionStateStatus;
  cwd: string;
  policy_label?: string;
  policy_digest: string;
  runner_pid: number | null;
  created_at: string;
  last_activity_at: string | null;
  turns: number;
  current_turn?: TurnSnapshot;
  last_completed_turn?: CompletedTurnSnapshot;
  pending_decisions: PendingDecisionSnapshot[];
  recent_errors: RecentErrorSnapshot[];
}

export type ParsedStatusArgs =
  | { ok: true; help: true }
  | { ok: true; help: false; sessionId?: string; json: boolean }
  | { ok: false; error: string };

const TRAILING_TOKEN_RE = /(?:^|\n)[ \t]*\[([A-Z*][A-Z0-9*-]*)\]\s*$/;

export function extractTrailingToken(text: string): string | null {
  const m = TRAILING_TOKEN_RE.exec(text);
  return m ? m[1] : null;
}

export function truncateHead(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + "…";
}

function summarizeArgs(tool: string, args: unknown): string {
  if (tool === "Bash") {
    const cmd = (args as { command?: unknown } | null | undefined)?.command;
    return typeof cmd === "string" ? cmd : "";
  }
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.file_path === "string") return a.file_path;
  if (typeof a.pattern === "string") return a.pattern;
  if (typeof a.subagent_type === "string") return a.subagent_type;
  try {
    return JSON.stringify(a);
  } catch {
    return "";
  }
}

export function parseStatusArgs(argv: string[]): ParsedStatusArgs {
  let sessionId: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: true, help: true };
    if (a === "--json") {
      json = true;
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}` };
    } else {
      if (sessionId !== undefined) {
        return { ok: false, error: "at most one session id" };
      }
      if (!isValidSessionId(a)) {
        return { ok: false, error: `invalid session id: ${a}` };
      }
      sessionId = a;
    }
  }

  return { ok: true, help: false, sessionId, json };
}

function lastAssistantTextForTurn(events: Event[], turnId: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" && (e as { turn_id?: string }).turn_id === turnId) {
      return (e as { text: string }).text;
    }
  }
  return undefined;
}

export function buildSessionSnapshot(
  state: SessionState | null,
  events: Event[],
  nowMs: number
): SessionSnapshot | null {
  if (state === null) return null;

  // Orphan detection: state says alive but pid is dead.
  let status = state.status;
  if (
    state.runner_pid !== null &&
    !isPidAlive(state.runner_pid) &&
    (status === "running" || status === "ready" || status === "starting")
  ) {
    status = "orphaned";
  }

  // Pending decisions: tool_decision_required without matching tool_decision_resolved.
  // Iterate events in seq order so the resulting array is chronological (oldest first).
  const resolvedCallIds = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_decision_resolved") {
      resolvedCallIds.add((e as { call_id: string }).call_id);
    }
  }
  const pending: PendingDecisionSnapshot[] = [];
  for (const e of events) {
    if (e.kind !== "tool_decision_required") continue;
    const required = e as Extract<Event, { kind: "tool_decision_required" }>;
    if (resolvedCallIds.has(required.call_id)) continue;
    const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(required.at)) / 1000));
    pending.push({
      call_id: required.call_id,
      tool: required.tool,
      args_summary: truncateHead(summarizeArgs(required.tool, required.args), 200),
      severity: required.severity,
      default_action: required.default_action,
      deferred_at: required.at,
      age_seconds: ageSeconds,
    });
  }

  // Recent errors: turn_failed, error, is-error tool_call_result.
  // Most-recent-first, capped at 3.
  const errors: RecentErrorSnapshot[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (errors.length >= 3) break;
    const e = events[i];
    if (e.kind === "turn_failed") {
      const failed = e as Extract<Event, { kind: "turn_failed" }>;
      errors.push({
        kind: "turn_failed",
        at: failed.at,
        summary: truncateHead(failed.error, 200),
      });
    } else if (e.kind === "error") {
      const err = e as Extract<Event, { kind: "error" }>;
      errors.push({
        kind: "error",
        at: err.at,
        summary: truncateHead(err.message, 200),
      });
    } else if (e.kind === "tool_call_result") {
      const result = e as Extract<Event, { kind: "tool_call_result" }>;
      if (!result.is_error) continue;
      const summary =
        typeof result.result === "string"
          ? result.result
          : (() => {
              try {
                return JSON.stringify(result.result);
              } catch {
                return "";
              }
            })();
      errors.push({
        kind: "tool_call_result",
        at: result.at,
        summary: truncateHead(summary, 200),
      });
    }
  }

  // Current turn: most recent turn_started without a matching turn_completed/turn_failed.
  // Last completed turn: most recent turn_completed or turn_failed event.
  let current_turn: TurnSnapshot | undefined;
  let last_completed_turn: CompletedTurnSnapshot | undefined;

  let mostRecentTurnStarted:
    | Extract<Event, { kind: "turn_started" }>
    | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "turn_started") {
      mostRecentTurnStarted = e as Extract<Event, { kind: "turn_started" }>;
      break;
    }
  }

  if (mostRecentTurnStarted) {
    const tid = mostRecentTurnStarted.turn_id;
    const isCompleted = events.some(
      (e) =>
        (e.kind === "turn_completed" || e.kind === "turn_failed") &&
        (e as { turn_id?: string }).turn_id === tid
    );
    if (!isCompleted) {
      const fullText = lastAssistantTextForTurn(events, tid) ?? "";
      current_turn = {
        turn_id: tid,
        started_at: mostRecentTurnStarted.at,
        last_assistant_text: fullText ? truncateHead(fullText, 1000) : undefined,
        last_token: extractTrailingToken(fullText),
      };
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "turn_completed" || e.kind === "turn_failed") {
      const tid = (e as { turn_id: string }).turn_id;
      const turnStarted = events.find(
        (s) => s.kind === "turn_started" && (s as { turn_id?: string }).turn_id === tid
      ) as Extract<Event, { kind: "turn_started" }> | undefined;
      const fullText = lastAssistantTextForTurn(events, tid) ?? "";
      const stop_reason =
        e.kind === "turn_completed"
          ? (e as Extract<Event, { kind: "turn_completed" }>).stop_reason
          : "failed";
      last_completed_turn = {
        turn_id: tid,
        started_at: turnStarted?.at ?? e.at,
        completed_at: e.at,
        stop_reason,
        last_assistant_text: fullText ? truncateHead(fullText, 1000) : undefined,
        last_token: extractTrailingToken(fullText),
      };
      break;
    }
  }

  // policy_label: derive from policy when literal "bypass"; otherwise undefined.
  // (We don't store user-provided labels in the policy object.)
  let policy_label: string | undefined;
  if (state.policy === "bypass") policy_label = "bypass";

  return {
    session_id: state.session_id,
    status,
    cwd: state.cwd,
    policy_label,
    policy_digest: policyDigest(state.policy),
    runner_pid: state.runner_pid,
    created_at: state.started_at,
    last_activity_at: state.last_event_at,
    turns: state.turns,
    current_turn,
    last_completed_turn,
    pending_decisions: pending,
    recent_errors: errors,
  };
}

const NO_SESSIONS_MSG = "(no sessions)";

function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return "?";
  const ms = nowMs - Date.parse(iso);
  if (isNaN(ms) || ms < 0) return "?";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function compactCwd(cwd: string, maxLen = 30): string {
  if (cwd.length <= maxLen) return cwd;
  const parts = cwd.split("/").filter(Boolean);
  const basename = parts.length > 0 ? parts[parts.length - 1] : cwd;
  return `…/${basename}`;
}

export function renderSummaryTable(snaps: SessionSnapshot[], nowMs: number): string {
  if (snaps.length === 0) return NO_SESSIONS_MSG;
  const rows: string[][] = [];
  rows.push(["SESSION_ID", "STATUS", "TURNS", "PENDING", "ERRORS", "LAST_ACTIVITY", "CWD"]);
  for (const s of snaps) {
    const idShort = s.session_id.length > 20 ? s.session_id.slice(0, 19) + "…" : s.session_id;
    rows.push([
      idShort,
      s.status,
      String(s.turns),
      String(s.pending_decisions.length),
      String(s.recent_errors.length),
      relativeTime(s.last_activity_at, nowMs),
      compactCwd(s.cwd),
    ]);
  }
  return rows.map((r) => r.join("\t")).join("\n");
}

function ageHumanReadable(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function renderDetailedBlock(s: SessionSnapshot): string {
  const lines: string[] = [];
  lines.push(`Session: ${s.session_id}`);
  const statusLine = s.runner_pid ? `${s.status} (pid ${s.runner_pid})` : s.status;
  lines.push(`Status:        ${statusLine}`);
  lines.push(`Cwd:           ${s.cwd}`);
  const policyStr = s.policy_label
    ? `${s.policy_label} (${s.policy_digest})`
    : s.policy_digest;
  lines.push(`Policy:        ${policyStr}`);
  lines.push(`Turns:         ${s.turns}`);
  lines.push(`Created:       ${s.created_at}`);
  if (s.last_activity_at) {
    const rel = relativeTime(s.last_activity_at, Date.now());
    lines.push(`Last activity: ${s.last_activity_at} (${rel})`);
  }

  if (s.current_turn) {
    lines.push("");
    lines.push(`Current turn: ${s.current_turn.turn_id} (started ${s.current_turn.started_at})`);
    if (s.current_turn.last_token) {
      lines.push(`  Token:       ${s.current_turn.last_token}`);
    }
    if (s.current_turn.last_assistant_text) {
      lines.push(`  Last said:   ${s.current_turn.last_assistant_text}`);
    }
  }

  if (s.last_completed_turn) {
    lines.push("");
    lines.push(
      `Last completed turn: ${s.last_completed_turn.turn_id} (completed ${s.last_completed_turn.completed_at}, stop_reason: ${s.last_completed_turn.stop_reason})`
    );
    if (s.last_completed_turn.last_token) {
      lines.push(`  Token:       ${s.last_completed_turn.last_token}`);
    }
    if (s.last_completed_turn.last_assistant_text) {
      lines.push(`  Last said:   ${s.last_completed_turn.last_assistant_text}`);
    }
  }

  if (s.pending_decisions.length > 0) {
    lines.push("");
    lines.push(`Pending decisions: (${s.pending_decisions.length})`);
    s.pending_decisions.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.call_id} ${p.tool}: "${p.args_summary}"`);
      lines.push(
        `     severity: ${p.severity} · default: ${p.default_action} · age: ${ageHumanReadable(p.age_seconds)}`
      );
    });
  }

  if (s.recent_errors.length > 0) {
    lines.push("");
    lines.push(`Recent errors: (${s.recent_errors.length})`);
    s.recent_errors.forEach((e, i) => {
      lines.push(`  ${i + 1}. ${e.kind} at ${e.at}`);
      lines.push(`     "${e.summary}"`);
    });
  }

  return lines.join("\n");
}

export function renderJson(snap: SessionSnapshot | SessionSnapshot[]): string {
  if (Array.isArray(snap)) {
    return JSON.stringify({ sessions: snap });
  }
  return JSON.stringify(snap);
}

async function buildSnapshotForId(id: string, nowMs: number): Promise<SessionSnapshot | null> {
  let state: SessionState | null;
  try {
    state = await readState(statePath(id));
  } catch {
    return null;
  }
  if (state === null) return null;
  let events: Event[] = [];
  try {
    events = (await readEventsSince(eventsPath(id), 0)).events;
  } catch {
    events = [];
  }
  return buildSessionSnapshot(state, events, nowMs);
}

function printUsage(): void {
  console.log(`claw-drive status — snapshot of one or all driven sessions

Usage:
  claw-drive status                Summary table of all sessions
  claw-drive status <session_id>   Detailed block for one session
  claw-drive status [<id>] --json  Structured JSON output

Flags:
  --json                           Emit JSON instead of human-readable output
  --help, -h                       Print this help and exit

Notes:
  - Per-session snapshot includes status, cwd, policy, turn counts,
    current/last turn metadata (with extracted [TOKEN] sentinels), pending
    decisions (chronological), and recent errors (most-recent-first, cap 3).
  - Designed as the on-demand companion to Monitor: when Monitor is silent
    and you want to know what's happening, run this.
`);
}

export async function cmdStatus(argv: string[]): Promise<number> {
  const parsed = parseStatusArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const nowMs = Date.now();
  const root = sessionsRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    if (parsed.sessionId) {
      console.error("session not found");
      return 1;
    }
    if (parsed.json) {
      console.log(JSON.stringify({ sessions: [] }));
    } else {
      console.log(NO_SESSIONS_MSG);
    }
    return 0;
  }

  const ids = entries.filter(isValidSessionId);

  if (parsed.sessionId) {
    if (!ids.includes(parsed.sessionId)) {
      console.error("session not found");
      return 1;
    }
    const snap = await buildSnapshotForId(parsed.sessionId, nowMs);
    if (snap === null) {
      console.error("session not found or unreadable");
      return 1;
    }
    if (parsed.json) {
      console.log(renderJson(snap));
    } else {
      console.log(renderDetailedBlock(snap));
    }
    return 0;
  }

  const snaps: SessionSnapshot[] = [];
  for (const id of ids) {
    const snap = await buildSnapshotForId(id, nowMs);
    if (snap !== null) snaps.push(snap);
  }

  if (parsed.json) {
    console.log(renderJson(snaps));
  } else {
    console.log(renderSummaryTable(snaps, nowMs));
  }
  return 0;
}
