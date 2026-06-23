import type { DecisionAction, Policy, Rule } from "./policy.js";

/**
 * The PreToolUse hook JSON payload claude pipes to the approver's stdin.
 * Fields confirmed by the Task 2.1 probe (docs/claude-cli-contract.md).
 */
export interface PreToolUsePayload {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  [extra: string]: unknown; // tolerate forward-compatible fields claude may add
}

export type ControlRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "send_turn"; message: string }
  | {
      id: string;
      op: "resolve_tool_call";
      call_id: string;
      action: DecisionAction;
      reason: string;
      remember_as_policy?: boolean;
      preview_only?: boolean;
      remembered_rule?: Rule;
    }
  | { id: string; op: "update_policy"; policy: Policy }
  | { id: string; op: "interrupt_turn"; turn_id: string }
  | { id: string; op: "stop_session" }
  | {
      id: string;
      op: "provide_tool_output";
      call_id: string;
      stdout?: string;
      stderr?: string;
      exit_code?: number;
      extra?: string;
    }
  | {
      id: string;
      op: "approve_tool";
      pretooluse: PreToolUsePayload;
    };

export type ControlResponse =
  | { id: string; ok: true; result?: Record<string, unknown> }
  | { id: string; ok: false; error: string; message: string };

export function encodeMessage(msg: ControlRequest | ControlResponse): string {
  return JSON.stringify(msg) + "\n";
}

export function decodeMessage(line: string): ControlRequest | ControlResponse {
  const parsed = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("message must be a non-array JSON object");
  }
  return parsed as ControlRequest | ControlResponse;
}
