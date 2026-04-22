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
  | "error";

export type ResolvedBy = "policy" | "user_mcp" | "user_mcp_auto" | "user_cli" | "timeout";
export type Severity = "low" | "medium" | "high";
export type DecisionAction = "approve" | "reject";

export type Event =
  | { seq: number; at: string; kind: "session_started"; cwd: string; policy_digest: string }
  | { seq: number; at: string; kind: "session_stopped"; reason: string; exit_code: number | null }
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
  | { seq: number; at: string; turn_id?: string; kind: "error"; message: string; recoverable: boolean };

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
