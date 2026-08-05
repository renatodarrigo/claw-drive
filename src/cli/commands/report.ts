import { statePath, eventsPath } from "../../lib/paths.js";
import { readState, type SessionState, type SessionStatus } from "../../lib/state.js";
import { readEventsSince, type Event, type ResolvedBy, type Severity, type DecisionAction } from "../../lib/events.js";
import { resolveSessionRef } from "../../lib/alias.js";
import { policyDigest } from "../../lib/policy.js";
import { extractTrailingToken, DEFAULT_IDLE_AFTER_SECONDS } from "../../lib/tokens.js";

/**
 * CD-59 `claw-drive report <session>` — a human-readable narrative rendered
 * from a session's events.jsonl (+ its state.json for cwd/model/policy/exit
 * fields not carried by the event log). Strictly read-only: every function in
 * this module either takes already-loaded state/events as plain data, or (in
 * cmdReport) performs only fs reads — nothing here writes session state,
 * appends events, or touches the control socket.
 */

/**
 * The four AC-named policy-resolution outcomes, plus "pending" for a call with
 * no tool_decision_resolved yet. "pending" covers two distinct shapes, told
 * apart by ToolCallReport.paused:
 *   - paused: a tool_decision_required fired and is still awaiting an answer
 *     (a live escalation/defer, or a dead session that ended mid-decision);
 *   - not paused: the call was requested but the policy hook has not weighed in
 *     yet — the ordinary in-flight window on a live session. This is NOT an
 *     escalation and must not be rendered as one.
 */
export type ToolCallCategory =
  | "auto-approved"
  | "auto-rejected"
  | "deferred"
  | "escalated"
  | "pending";

export interface ToolCallReport {
  call_id: string;
  turn_id: string;
  tool: string;
  args_summary: string;
  requested_at: string;
  category: ToolCallCategory;
  /** True once a tool_decision_required has been seen for this call_id, i.e. the call actually paused for a policy decision. */
  paused?: boolean;
  severity?: Severity;
  default_action?: DecisionAction;
  matched_rule?: string;
  action?: DecisionAction;
  resolved_by?: ResolvedBy;
  resolved_reason?: string;
  resolved_at?: string;
  is_error?: boolean;
  output_provided_at?: string;
}

export interface ReportCounts {
  turns: number;
  tool_calls: number;
  decisions: number;
  auto_approved: number;
  auto_rejected: number;
  deferred: number;
  escalated: number;
  pending: number;
}

export interface ReportSummary {
  session_id: string;
  alias?: string;
  cwd: string;
  model: string | null;
  status: SessionStatus;
  policy_label?: string;
  policy_digest: string;
  started_at: string;
  ended_at?: string;
  /** ended_at - started_at when the session has stopped; otherwise now - started_at (running total so far). */
  duration_seconds: number;
  /** true when duration_seconds is a running total (no session_stopped observed yet). */
  duration_is_ongoing: boolean;
  exit_reason: string | null;
  exit_code: number | null;
  counts: ReportCounts;
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

/**
 * Build one ToolCallReport per call_id seen across tool_call_requested,
 * tool_decision_required, tool_decision_resolved, tool_call_result, and
 * tool_output_provided events — a full-history scan (not incremental), so a
 * call resolved much later (or by timeout) is already fully classified when
 * the transcript renderer reaches its tool_call_requested position.
 */
export function classifyToolCalls(events: Event[]): Map<string, ToolCallReport> {
  const calls = new Map<string, ToolCallReport>();

  for (const e of events) {
    if (e.kind !== "tool_call_requested") continue;
    calls.set(e.call_id, {
      call_id: e.call_id,
      turn_id: e.turn_id,
      tool: e.tool,
      args_summary: summarizeArgs(e.tool, e.args),
      requested_at: e.at,
      category: "pending",
    });
  }

  const required = new Map<string, Extract<Event, { kind: "tool_decision_required" }>>();
  for (const e of events) {
    if (e.kind !== "tool_decision_required") continue;
    required.set(e.call_id, e);
    const rec = calls.get(e.call_id);
    if (rec) {
      rec.paused = true;
      rec.severity = e.severity;
      rec.default_action = e.default_action;
      rec.matched_rule = e.matched_rule;
    }
  }

  for (const e of events) {
    if (e.kind !== "tool_decision_resolved") continue;
    let rec = calls.get(e.call_id);
    if (!rec) {
      // Defensive: a resolved event with no matching tool_call_requested
      // (shouldn't happen from the real runner, but don't silently drop it).
      rec = {
        call_id: e.call_id,
        turn_id: e.turn_id,
        tool: "(unknown)",
        args_summary: "",
        requested_at: e.at,
        category: "pending",
      };
      calls.set(e.call_id, rec);
    }
    rec.action = e.action;
    rec.resolved_by = e.resolved_by;
    rec.resolved_reason = e.reason;
    rec.resolved_at = e.at;
    const wasPaused = required.has(e.call_id);
    if (e.action === "defer") {
      rec.category = "deferred";
    } else if (wasPaused) {
      rec.category = "escalated";
    } else {
      rec.category = e.action === "approve" ? "auto-approved" : "auto-rejected";
    }
  }

  for (const e of events) {
    if (e.kind === "tool_call_result") {
      const rec = calls.get(e.call_id);
      if (rec) rec.is_error = e.is_error;
    } else if (e.kind === "tool_output_provided") {
      const rec = calls.get(e.call_id);
      if (rec) rec.output_provided_at = e.at;
    }
  }

  return calls;
}

export function buildReportCounts(events: Event[]): ReportCounts {
  const calls = classifyToolCalls(events);
  const counts: ReportCounts = {
    turns: 0,
    tool_calls: 0,
    decisions: calls.size,
    auto_approved: 0,
    auto_rejected: 0,
    deferred: 0,
    escalated: 0,
    pending: 0,
  };
  for (const e of events) {
    if (e.kind === "turn_started") counts.turns += 1;
    else if (e.kind === "tool_call_requested") counts.tool_calls += 1;
  }
  for (const rec of calls.values()) {
    switch (rec.category) {
      case "auto-approved": counts.auto_approved += 1; break;
      case "auto-rejected": counts.auto_rejected += 1; break;
      case "deferred": counts.deferred += 1; break;
      case "escalated": counts.escalated += 1; break;
      case "pending": counts.pending += 1; break;
    }
  }
  return counts;
}

export function buildReportSummary(
  state: SessionState | null,
  events: Event[],
  nowMs: number
): ReportSummary | null {
  if (state === null) return null;

  let sessionStopped: Extract<Event, { kind: "session_stopped" }> | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "session_stopped") {
      sessionStopped = e;
      break;
    }
  }

  const startedMs = Date.parse(state.started_at);
  const endMs = sessionStopped ? Date.parse(sessionStopped.at) : nowMs;
  const durationSeconds =
    Number.isFinite(startedMs) && Number.isFinite(endMs)
      ? Math.max(0, Math.round((endMs - startedMs) / 1000))
      : 0;

  let policyLabel: string | undefined;
  if (state.policy === "bypass") policyLabel = "bypass";

  return {
    session_id: state.session_id,
    ...(state.alias ? { alias: state.alias } : {}),
    cwd: state.cwd,
    model: state.model,
    status: state.status,
    policy_label: policyLabel,
    policy_digest: policyDigest(state.policy),
    started_at: state.started_at,
    ...(sessionStopped ? { ended_at: sessionStopped.at } : {}),
    duration_seconds: durationSeconds,
    duration_is_ongoing: sessionStopped === undefined,
    exit_reason: sessionStopped?.reason ?? state.exit_reason,
    exit_code: sessionStopped?.exit_code ?? state.exit_code,
    counts: buildReportCounts(events),
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const totalMin = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (totalMin < 60) return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr < 24) return min ? `${hr}h ${min}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr ? `${day}d ${remHr}h` : `${day}d`;
}

function describeResolvedBy(by: ResolvedBy | undefined): string {
  switch (by) {
    case "policy": return "by policy";
    case "user_mcp": return "by a human, via MCP";
    case "user_mcp_auto": return "auto-deferred via provide-output";
    case "user_cli": return "by a human, via CLI";
    case "timeout": return "by decision timeout (default action fired)";
    default: return "unresolved";
  }
}

function describeResolution(rec: ToolCallReport): string {
  if (rec.category === "auto-approved" || rec.category === "auto-rejected") {
    const verb = rec.category === "auto-approved" ? "auto-approved" : "auto-rejected";
    return rec.resolved_reason ? `${verb} (rule: ${rec.resolved_reason})` : verb;
  }

  // A call that was requested but never paused for a policy decision is simply
  // in flight — the ordinary window before the PreToolUse hook resolves it (or
  // a session killed mid-call). Reporting that as "escalated" would be wrong.
  if (rec.category === "pending" && !rec.paused) {
    return "awaiting decision";
  }

  const pauseDesc =
    rec.default_action !== undefined
      ? `escalated (severity: ${rec.severity ?? "?"}, default: ${rec.default_action})`
      : "escalated";

  if (rec.category === "pending") {
    return `${pauseDesc} → still pending`;
  }

  // deferred | escalated: a pause that has since resolved.
  const pausedFor =
    rec.resolved_at && rec.requested_at
      ? ` [paused ${formatDuration(Math.max(0, Math.round((Date.parse(rec.resolved_at) - Date.parse(rec.requested_at)) / 1000)))}]`
      : "";
  const reasonPart = rec.resolved_reason ? `, reason: "${rec.resolved_reason}"` : "";
  const resolved = `resolved: ${rec.action} (${describeResolvedBy(rec.resolved_by)}${reasonPart})`;
  const outputPart = rec.output_provided_at ? ` — output provided at ${rec.output_provided_at}` : "";
  return `${pauseDesc} → ${resolved}${pausedFor}${outputPart}`;
}

function renderToolCallLine(rec: ToolCallReport): string {
  return `[${rec.requested_at}] TOOL_CALL ${rec.turn_id} ${rec.tool} "${rec.args_summary}" → ${describeResolution(rec)}`;
}

/** Find the most recent `assistant_text` for `turnId` at or before this point in `events`. */
function lastAssistantTextForTurn(events: Event[], turnId: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" && e.turn_id === turnId) return e.text;
  }
  return undefined;
}

export interface RenderTranscriptOptions {
  /** Idle-gap threshold in seconds; 0 disables idle-gap markers. Matches `watch --idle-after`'s semantics/default. */
  idleAfterSeconds: number;
}

/**
 * Chronological transcript: user turns, assistant text, one consolidated
 * line per tool call (policy resolution + how any pause was resolved),
 * sentinel outcomes on turn completion, idle gaps, and session lifecycle
 * markers. Tool calls are rendered once, at their tool_call_requested
 * position, already carrying their eventual resolution (classifyToolCalls
 * scans the full history first) — a decision resolved much later in the log
 * still annotates the single line for that call rather than appearing twice.
 */
export function renderTranscript(events: Event[], opts: RenderTranscriptOptions): string {
  const calls = classifyToolCalls(events);
  const renderedCallIds = new Set<string>();
  const lines: string[] = [];
  const idleThresholdMs = opts.idleAfterSeconds > 0 ? opts.idleAfterSeconds * 1000 : Infinity;
  let lastAtMs: number | null = null;

  const renderCall = (
    callId: string,
    fallbackAt: string,
    fallbackTurnId: string,
    pause?: Extract<Event, { kind: "tool_decision_required" }>
  ): void => {
    if (renderedCallIds.has(callId)) return;
    renderedCallIds.add(callId);
    const rec: ToolCallReport = calls.get(callId) ?? {
      call_id: callId,
      turn_id: fallbackTurnId,
      tool: "(unknown)",
      args_summary: "",
      requested_at: fallbackAt,
      category: "pending" as const,
      // An orphan tool_decision_required (its tool_call_requested is missing
      // from the log) did pause for a policy decision, so carry that through:
      // without it the call reads as an ordinary in-flight one. This record is
      // transcript-only and never enters `calls`, so counts stay unchanged.
      ...(pause
        ? {
            paused: true,
            severity: pause.severity,
            default_action: pause.default_action,
            matched_rule: pause.matched_rule,
          }
        : {}),
    };
    lines.push(renderToolCallLine(rec));
  };

  for (const e of events) {
    const atMs = Date.parse(e.at);
    if (lastAtMs !== null && Number.isFinite(atMs) && atMs - lastAtMs >= idleThresholdMs) {
      lines.push(`  … idle gap of ${formatDuration(Math.round((atMs - lastAtMs) / 1000))} …`);
    }
    if (Number.isFinite(atMs)) lastAtMs = atMs;

    switch (e.kind) {
      case "session_started":
        lines.push(`[${e.at}] SESSION started (cwd: ${e.cwd}, policy ${e.policy_digest})`);
        break;
      case "session_stopped":
        lines.push(`[${e.at}] SESSION stopped (reason: ${e.reason}, exit_code: ${e.exit_code ?? "null"})`);
        break;
      case "turn_started":
        lines.push(`[${e.at}] USER ${e.turn_id}: "${e.message}"`);
        break;
      case "assistant_text":
        lines.push(`[${e.at}] ASSISTANT ${e.turn_id}: ${e.text}`);
        break;
      case "turn_completed": {
        const lastText = lastAssistantTextForTurn(events, e.turn_id);
        const token = lastText !== undefined ? extractTrailingToken(lastText) : null;
        const sentinel = token ? ` — sentinel: [${token}]` : "";
        lines.push(`[${e.at}] TURN ${e.turn_id} completed (stop_reason: ${e.stop_reason})${sentinel}`);
        break;
      }
      case "turn_failed":
        lines.push(`[${e.at}] TURN ${e.turn_id} failed: ${e.error}`);
        break;
      case "tool_call_requested":
        renderCall(e.call_id, e.at, e.turn_id);
        break;
      case "tool_decision_required":
        // Normally already rendered by tool_call_requested above; this is a
        // defensive fallback for a log missing that event. Pass the decision
        // itself so the fallback record can report the pause it represents.
        renderCall(e.call_id, e.at, e.turn_id, e);
        break;
      case "error":
        lines.push(
          `[${e.at}] ERROR${e.turn_id ? ` (${e.turn_id})` : ""}: ${e.message}${e.recoverable ? "" : " [fatal]"}`
        );
        break;
      // tool_decision_resolved, tool_call_started, tool_call_result,
      // tool_output_provided, thinking: folded into the tool call's single
      // consolidated line, or (thinking) intentionally omitted from the
      // curated narrative — the raw log remains available via `tail`/`show`.
      default:
        break;
    }
  }

  return lines.join("\n");
}

export function renderReportHeader(summary: ReportSummary): string {
  const lines: string[] = [];
  lines.push(`Session:       ${summary.session_id}`);
  if (summary.alias) lines.push(`Alias:         ${summary.alias}`);
  lines.push(`Cwd:           ${summary.cwd}`);
  lines.push(`Model:         ${summary.model ?? "(default)"}`);
  lines.push(`Status:        ${summary.status}`);
  const policyStr = summary.policy_label
    ? `${summary.policy_label} (${summary.policy_digest})`
    : summary.policy_digest;
  lines.push(`Policy:        ${policyStr}`);
  lines.push(`Started:       ${summary.started_at}`);
  lines.push(summary.ended_at ? `Ended:         ${summary.ended_at}` : `Ended:         (still running)`);
  lines.push(
    `Duration:      ${formatDuration(summary.duration_seconds)}${summary.duration_is_ongoing ? " (so far)" : ""}`
  );
  lines.push(`Exit reason:   ${summary.exit_reason ?? "(none)"}`);
  const c = summary.counts;
  lines.push(`Turns:         ${c.turns}`);
  lines.push(`Tool calls:    ${c.tool_calls}`);
  lines.push(
    `Decisions:     ${c.decisions} (auto-approved: ${c.auto_approved}, auto-rejected: ${c.auto_rejected}, ` +
      `deferred: ${c.deferred}, escalated: ${c.escalated}, pending: ${c.pending})`
  );
  return lines.join("\n");
}

export function renderReportText(
  summary: ReportSummary,
  events: Event[],
  opts: RenderTranscriptOptions
): string {
  return [
    `=== Session Report: ${summary.session_id} ===`,
    "",
    renderReportHeader(summary),
    "",
    "=== Transcript ===",
    "",
    renderTranscript(events, opts),
  ].join("\n");
}

export function renderReportJson(summary: ReportSummary): string {
  return JSON.stringify(summary);
}

export type ParsedReportArgs =
  | { ok: true; help: true }
  | { ok: true; help: false; sessionId: string; json: boolean; idleAfterSeconds: number }
  | { ok: false; error: string };

const USAGE = "usage: claw-drive report <session_id> [--json] [--idle-after SECONDS]";

export function parseReportArgs(argv: string[]): ParsedReportArgs {
  let sessionId: string | undefined;
  let json = false;
  let idleAfterSeconds = DEFAULT_IDLE_AFTER_SECONDS;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: true, help: true };
    if (a === "--json") {
      json = true;
    } else if (a === "--idle-after") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) {
        return {
          ok: false,
          error: "--idle-after requires a non-negative integer seconds; 0 disables (got '" + (v ?? "") + "')",
        };
      }
      idleAfterSeconds = Number(v);
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}` };
    } else {
      if (sessionId !== undefined) return { ok: false, error: "at most one session id" };
      sessionId = a;
    }
  }

  if (sessionId === undefined) return { ok: false, error: USAGE };
  return { ok: true, help: false, sessionId, json, idleAfterSeconds };
}

function printUsage(): void {
  console.log(`claw-drive report — human-readable session report rendered from events.jsonl

${USAGE}

Flags:
  --json                  Emit a machine-readable summary object (header fields + per-category counts) instead of the text report.
  --idle-after SECONDS    Idle-gap threshold for the transcript (default 600; 0 disables). Matches 'watch --idle-after'.
  --help, -h              Print this help and exit.

Notes:
  - Works for live and dead sessions; strictly read-only (never writes session
    state, events, or sockets, and never signals the runner).
  - The text report is a summary header (session id, alias, cwd, model,
    started/ended timestamps, duration, exit reason, turn / tool-call /
    decision counts) followed by a chronological transcript of user turns,
    assistant text, tool calls (with their policy resolution and how any
    pause was resolved), sentinel outcomes, idle gaps, and session lifecycle
    markers.
`);
}

export async function cmdReport(argv: string[]): Promise<number> {
  const parsed = parseReportArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const id = await resolveSessionRef(parsed.sessionId);
  if (id === null) {
    console.error(`no live session for '${parsed.sessionId}'`);
    return 2;
  }
  const state = await readState(statePath(id));
  if (!state) {
    console.error("session not found");
    return 1;
  }
  const { events } = await readEventsSince(eventsPath(id), 0);
  const summary = buildReportSummary(state, events, Date.now());
  if (summary === null) {
    console.error("session not found");
    return 1;
  }

  if (parsed.json) {
    console.log(renderReportJson(summary));
  } else {
    console.log(renderReportText(summary, events, { idleAfterSeconds: parsed.idleAfterSeconds }));
  }
  return 0;
}
