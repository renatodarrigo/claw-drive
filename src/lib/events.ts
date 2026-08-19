import * as fs from "node:fs/promises";

export type EventKind =
  | "session_started"
  | "session_stopped"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "assistant_text"
  | "thinking"
  | "tool_call_requested"
  | "tool_decision_required"
  | "tool_decision_resolved"
  | "tool_call_started"
  | "tool_call_result"
  | "tool_output_provided"
  | "error"
  | "context_threshold_reached"
  | "session_rotated"
  | "rotation_failed"
  | "rotation_refused"
  | "session_recovered"
  | "recover_failed"
  | "cost_threshold_reached";

export type ResolvedBy = "policy" | "user_mcp" | "user_mcp_auto" | "user_cli" | "timeout";
export type Severity = "low" | "medium" | "high";
export type DecisionAction = "approve" | "reject" | "defer";

export type Event =
  | { seq: number; at: string; kind: "session_started"; cwd: string; policy_digest: string }
  | { seq: number; at: string; kind: "session_stopped"; reason: string; exit_code: number | null; handover_path?: string }
  | { seq: number; at: string; turn_id: string; kind: "turn_started"; message: string }
  | { seq: number; at: string; turn_id: string; kind: "turn_completed"; stop_reason: string }
  | { seq: number; at: string; turn_id: string; kind: "turn_failed"; error: string; stderr_tail?: string }
  | { seq: number; at: string; turn_id: string; kind: "assistant_text"; text: string }
  | { seq: number; at: string; turn_id: string; kind: "thinking"; text: string }
  | { seq: number; at: string; turn_id: string; kind: "tool_call_requested"; call_id: string; tool: string; args: unknown }
  | {
      seq: number;
      at: string;
      turn_id: string;
      kind: "tool_decision_required";
      call_id: string;
      tool: string;
      args: unknown;
      severity: Severity;
      default_action: DecisionAction;
      matched_rule?: string;
      default_at: string;
      /** CD-8: capped preceding assistant_text snippet (why B wants this). Additive, optional. */
      rationale?: string;
      /** CD-8: capped unified diff for Edit/Write. Additive, optional. */
      diff?: string;
    }
  | {
      seq: number;
      at: string;
      turn_id: string;
      kind: "tool_decision_resolved";
      call_id: string;
      action: DecisionAction;
      reason: string;
      resolved_by: ResolvedBy;
    }
  | { seq: number; at: string; turn_id: string; kind: "tool_call_started"; call_id: string }
  | { seq: number; at: string; turn_id: string; kind: "tool_call_result"; call_id: string; result: unknown; is_error: boolean }
  | {
      seq: number;
      at: string;
      turn_id: string;
      kind: "tool_output_provided";
      call_id: string;
      stdout_len: number;
      stderr_len: number;
      exit_code: number | null;
    }
  | { seq: number; at: string; turn_id?: string; kind: "error"; message: string; recoverable: boolean }
  | {
      seq: number;
      at: string;
      turn_id?: string;
      kind: "context_threshold_reached";
      context_tokens: number;
      threshold_tokens: number;
      generation: number;
    }
  | {
      seq: number;
      at: string;
      kind: "session_rotated";
      new_session_id: string;
      alias?: string;
      generation: number;
      handover_path: string;
      watch_command: string;
      /** Who initiated: a commanded rotate ("manual") or the runner's own
       * threshold-crossing dispatch ("auto"). Optional: events predate it. */
      initiated_by?: "manual" | "auto";
    }
  | {
      seq: number;
      at: string;
      kind: "session_recovered";
      new_session_id: string;
      alias?: string;
      generation: number;
      handover_path: string;
      watch_command: string;
      initiated_by: "auto";
    }
  | { seq: number; at: string; kind: "recover_failed"; reason: string; initiated_by: "auto" }
  | { seq: number; at: string; kind: "rotation_failed"; reason: string; initiated_by?: "manual" | "auto" }
  | { seq: number; at: string; kind: "rotation_refused"; reason: string; detail?: string; initiated_by?: "manual" | "auto" }
  | {
      seq: number;
      at: string;
      turn_id?: string;
      kind: "cost_threshold_reached";
      /** Lineage-cumulative spend reading that crossed the line. */
      cost_usd: number;
      warn_cost_usd: number;
      generation: number;
      /** Present only when a cap is configured — the headroom context. */
      max_cost_usd?: number;
    };

export async function appendEvent(eventsFile: string, event: Event): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await fs.appendFile(eventsFile, line, { encoding: "utf-8" });
}

export async function readEventsSince(
  eventsFile: string,
  sinceSeq: number
): Promise<{ events: Event[]; nextSince: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(eventsFile, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return { events: [], nextSince: sinceSeq };
    throw err;
  }
  const events: Event[] = [];
  let nextSince = sinceSeq;
  const lines = raw.split("\n");
  // After split on "\n", last element is "" when file ends in \n (complete),
  // or a partial line fragment otherwise. Either way we drop it.
  const completeLines = lines.slice(0, -1);
  for (const line of completeLines) {
    if (!line) continue;
    let ev: Event;
    try {
      ev = JSON.parse(line) as Event;
    } catch {
      continue; // skip unparseable lines
    }
    if (typeof ev.seq !== "number") continue;
    if (ev.seq > sinceSeq) {
      events.push(ev);
      if (ev.seq > nextSince) nextSince = ev.seq;
    }
  }
  return { events, nextSince };
}
