import { analyzeComposition } from "./bash-composition.js";

export type Severity = "low" | "medium" | "high";
export type DecisionAction = "approve" | "reject" | "defer";

/**
 * The policy-schema version this build supports. Introduced by CD-1
 * (contract freeze): a policy object may carry an optional `schema_version`.
 * Semantics are strict + implicit-v1 — absent means 1, an explicit 1 is
 * accepted, and any other value is rejected. See COMPATIBILITY.md.
 */
export const POLICY_SCHEMA_VERSION = 1;

const BASH_COMPOSITION_OPAQUE = "bash_composition: opaque";
const BASH_COMPOSITION_MALFORMED = "bash_composition: malformed";

export interface Rule {
  name?: string;
  tool: string;
  bash_command_matches?: string;
  arg_matches?: Record<string, string>;
  severity?: Severity;
}

export interface PolicyObject {
  auto_approve?: Rule[];
  auto_defer?: Rule[];
  auto_reject?: Rule[];
  escalate_default?: boolean;
  decision_timeout_seconds?: number;
  /**
   * Optional policy-schema version. Absent is treated as
   * {@link POLICY_SCHEMA_VERSION} (1). When present it must equal
   * POLICY_SCHEMA_VERSION; any other value is rejected by validatePolicy.
   */
  schema_version?: number;
  /**
   * Optional run-level circuit-breaker (CD-4). All fields optional; an absent
   * field is unlimited and an absent budget entirely is off — no behaviour
   * change for existing sessions. Enforced by the runner (src/runner/budget.ts).
   */
  budget?: {
    max_tool_calls?: number;
    max_wall_clock_seconds?: number;
    max_consecutive_errors?: number;
  };
  /**
   * Optional per-segment Bash composition mode. Absent ⇒ "off" (today's
   * whole-string matching, no behaviour change). When "per_segment", a Bash
   * call is split at top-level shell operators and each segment is evaluated
   * independently; the strictest segment's decision wins. See COMPATIBILITY.md.
   */
  bash_composition?: "off" | "per_segment";
}

export type Policy = "bypass" | PolicyObject;

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type MatchDecision =
  | { decision: "approve_silent"; matched_rule?: Rule }
  | { decision: "deny_silent"; matched_rule?: Rule }
  | {
      decision: "escalate";
      default_action: DecisionAction;
      severity: Severity;
      matched_rule?: Rule;
    };

export function matchPolicy(policy: Policy, call: ToolCall): MatchDecision {
  if (policy === "bypass") return { decision: "approve_silent" };

  if (policy.bash_composition === "per_segment" && call.tool === "Bash") {
    const command = String((call.args as { command?: unknown }).command ?? "");
    const a = analyzeComposition(command);
    if (a.opaque) return rejectComposition(BASH_COMPOSITION_OPAQUE);
    if (a.malformed) return rejectComposition(BASH_COMPOSITION_MALFORMED);
    if (a.segments.length > 1) return combineSegments(policy, a.segments);
    // single segment ⇒ fall through (identical to whole-string matching)
  }

  return evaluateSimpleCall(policy, call);
}

// Today's matchPolicy semantics for one simple command. Evaluation order:
// auto_reject > auto_defer > auto_approve > escalate_default (see the v0.2.3
// rationale: a command matching both approve and reject should be rejected).
function evaluateSimpleCall(policy: PolicyObject, call: ToolCall): MatchDecision {
  for (const rule of policy.auto_reject ?? []) {
    if (ruleMatches(rule, call)) {
      return {
        decision: "escalate",
        default_action: "reject",
        severity: rule.severity ?? "high",
        matched_rule: rule,
      };
    }
  }
  for (const rule of policy.auto_defer ?? []) {
    if (ruleMatches(rule, call)) {
      return {
        decision: "escalate",
        default_action: "defer",
        severity: rule.severity ?? "high",
        matched_rule: rule,
      };
    }
  }
  for (const rule of policy.auto_approve ?? []) {
    if (ruleMatches(rule, call)) return { decision: "approve_silent", matched_rule: rule };
  }
  const escalate = policy.escalate_default ?? true;
  if (escalate) {
    return { decision: "escalate", default_action: "approve", severity: "medium" };
  }
  return { decision: "deny_silent" };
}

function rejectComposition(name: string): MatchDecision {
  return { decision: "deny_silent", matched_rule: { tool: "Bash", name } };
}

// Strictest-wins precedence: a higher rank is more restrictive.
function rank(d: MatchDecision): number {
  if (d.decision === "escalate" && d.default_action === "reject") return 5;
  if (d.decision === "deny_silent") return 4;
  if (d.decision === "escalate" && d.default_action === "defer") return 3;
  if (d.decision === "escalate" && d.default_action === "approve") return 2;
  return 1; // approve_silent
}

function combineSegments(policy: PolicyObject, segments: string[]): MatchDecision {
  let worst = evaluateSimpleCall(policy, { tool: "Bash", args: { command: segments[0] } });
  for (let k = 1; k < segments.length; k++) {
    const d = evaluateSimpleCall(policy, { tool: "Bash", args: { command: segments[k] } });
    if (rank(d) > rank(worst)) worst = d;
  }
  return worst;
}

function ruleMatches(rule: Rule, call: ToolCall): boolean {
  if (!toolNameMatches(rule.tool, call.tool)) return false;
  if (call.tool === "Bash") {
    if (rule.bash_command_matches) {
      const cmd = String((call.args as { command?: unknown }).command ?? "");
      if (!new RegExp(rule.bash_command_matches).test(cmd)) return false;
    }
  } else if (rule.arg_matches) {
    for (const [key, pattern] of Object.entries(rule.arg_matches)) {
      const value = String((call.args as Record<string, unknown>)[key] ?? "");
      if (!new RegExp(pattern).test(value)) return false;
    }
  }
  return true;
}

function toolNameMatches(pattern: string, tool: string): boolean {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2) {
    return new RegExp(pattern.slice(1, -1)).test(tool);
  }
  return pattern === tool;
}

export function deriveRuleFromResolved(
  action: DecisionAction,
  tool: string,
  args: Record<string, unknown>
): Rule {
  if (tool === "Bash") {
    const cmd = String(args.command ?? "");
    const firstToken = cmd.split(/\s+/)[0] ?? "";
    return {
      tool: "Bash",
      bash_command_matches: "^" + escapeRegex(firstToken) + " ",
      name: `remembered: ${action} ${firstToken}`,
    };
  }
  // Prefer narrow scope on the tool's identifying arg.
  const filePath = typeof args.file_path === "string" ? args.file_path : undefined;
  const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
  const subagent = typeof args.subagent_type === "string" ? args.subagent_type : undefined;
  if (filePath) {
    return {
      tool,
      arg_matches: { file_path: "^" + escapeRegex(filePath) + "$" },
      name: `remembered: ${action} ${tool} ${filePath}`,
    };
  }
  if (pattern) {
    return {
      tool,
      arg_matches: { pattern: "^" + escapeRegex(pattern) + "$" },
      name: `remembered: ${action} ${tool} ${pattern}`,
    };
  }
  if (subagent) {
    return {
      tool,
      arg_matches: { subagent_type: "^" + escapeRegex(subagent) + "$" },
      name: `remembered: ${action} ${tool} (${subagent})`,
    };
  }
  return { tool, name: `remembered: ${action} ${tool} (tool-wide fallback)` };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RULE_KEYS = new Set(["name", "tool", "bash_command_matches", "arg_matches", "severity"]);

/**
 * Stricter per-rule validation for hand-authored rules (the --remember-as /
 * remembered_rule edit path). Unlike validatePolicy's inline rule check, this
 * also compiles arg_matches regexes, checks severity, and rejects unknown keys.
 */
export function validateRule(r: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    return { ok: false, error: "rule must be an object" };
  }
  const obj = r as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!RULE_KEYS.has(k)) return { ok: false, error: `unknown rule key '${k}'` };
  }
  if (typeof obj.tool !== "string" || obj.tool.length === 0) {
    return { ok: false, error: "rule.tool must be a non-empty string" };
  }
  if (obj.tool.startsWith("/") && obj.tool.endsWith("/") && obj.tool.length >= 2) {
    try {
      new RegExp(obj.tool.slice(1, -1));
    } catch (e) {
      return { ok: false, error: `rule.tool invalid regex: ${String(e)}` };
    }
  }
  if (obj.name !== undefined && typeof obj.name !== "string") {
    return { ok: false, error: "rule.name must be a string" };
  }
  if (obj.bash_command_matches !== undefined) {
    if (typeof obj.bash_command_matches !== "string") {
      return { ok: false, error: "rule.bash_command_matches must be a string" };
    }
    try {
      new RegExp(obj.bash_command_matches);
    } catch (e) {
      return { ok: false, error: `rule.bash_command_matches invalid regex: ${String(e)}` };
    }
  }
  if (obj.arg_matches !== undefined) {
    if (typeof obj.arg_matches !== "object" || obj.arg_matches === null || Array.isArray(obj.arg_matches)) {
      return { ok: false, error: "rule.arg_matches must be an object" };
    }
    for (const [k, v] of Object.entries(obj.arg_matches as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return { ok: false, error: `rule.arg_matches.${k} must be a string` };
      }
      try {
        new RegExp(v);
      } catch (e) {
        return { ok: false, error: `rule.arg_matches.${k} invalid regex: ${String(e)}` };
      }
    }
  }
  if (obj.severity !== undefined && (typeof obj.severity !== "string" || !["low", "medium", "high"].includes(obj.severity))) {
    return { ok: false, error: "rule.severity must be one of low|medium|high" };
  }
  return { ok: true };
}

/**
 * Coerce a rule that may arrive as a JSON string (some MCP clients serialize
 * untyped object params to strings — same hazard coercePolicy handles). Returns
 * the parsed object, or the raw value unchanged when it is not a JSON object.
 */
export function coerceRule(raw: unknown): unknown {
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through to raw */
    }
  }
  return raw;
}

export type ListName = "auto_approve" | "auto_defer" | "auto_reject";

export function listForAction(action: DecisionAction): ListName {
  return action === "approve" ? "auto_approve" : action === "defer" ? "auto_defer" : "auto_reject";
}

export interface RememberInput {
  action: DecisionAction;
  previewOnly?: boolean;
  rememberAsPolicy?: boolean;
  rememberedRule?: unknown;
  tool: string;
  args: Record<string, unknown>;
  policy: Policy;
}

export type RememberPlan =
  | { mode: "preview"; rule: Rule; list: ListName; source: "derived" | "provided"; bypass: boolean }
  | { mode: "error"; code: "BAD_RULE"; message: string }
  | { mode: "commit"; appendRule: Rule | null; list: ListName };

/**
 * Pure decision for a resolve_tool_call that may preview and/or remember a rule.
 * The runner performs IO based on the returned plan; this function never mutates.
 */
export function planResolveRemember(input: RememberInput): RememberPlan {
  const list = listForAction(input.action);
  const isBypass = input.policy === "bypass";

  let provided: Rule | null = null;
  if (input.rememberedRule !== undefined) {
    const coerced = coerceRule(input.rememberedRule);
    const v = validateRule(coerced);
    if (!v.ok) return { mode: "error", code: "BAD_RULE", message: v.error };
    provided = coerced as Rule;
  }

  if (input.previewOnly) {
    const rule = provided ?? deriveRuleFromResolved(input.action, input.tool, input.args);
    return { mode: "preview", rule, list, source: provided ? "provided" : "derived", bypass: isBypass };
  }

  // Commit. Remember is a no-op under bypass (no lists to append to).
  if (isBypass) return { mode: "commit", appendRule: null, list };
  if (provided) return { mode: "commit", appendRule: provided, list };
  if (input.rememberAsPolicy) {
    return { mode: "commit", appendRule: deriveRuleFromResolved(input.action, input.tool, input.args), list };
  }
  return { mode: "commit", appendRule: null, list };
}

export function validatePolicy(p: unknown): { ok: true } | { ok: false; error: string } {
  if (p === "bypass") return { ok: true };
  if (typeof p !== "object" || p === null)
    return { ok: false, error: "policy must be 'bypass' or an object" };
  const obj = p as Record<string, unknown>;
  const allowedKeys = new Set([
    "auto_approve",
    "auto_defer",
    "auto_reject",
    "escalate_default",
    "decision_timeout_seconds",
    "schema_version",
    "budget",
    "bash_composition",
  ]);
  for (const key of Object.keys(obj)) {
    if (key.startsWith("_")) continue; // metadata comment; ignored by validator
    if (!allowedKeys.has(key)) return { ok: false, error: `unknown key '${key}'` };
  }
  for (const listKey of ["auto_approve", "auto_defer", "auto_reject"] as const) {
    const list = obj[listKey];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: `${listKey} must be an array` };
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      if (typeof rule !== "object" || rule === null)
        return { ok: false, error: `${listKey}[${i}] must be an object` };
      const r = rule as Record<string, unknown>;
      if (typeof r.tool !== "string")
        return { ok: false, error: `${listKey}[${i}].tool must be a string` };
      if (r.tool.startsWith("/") && r.tool.endsWith("/") && r.tool.length >= 2) {
        try {
          new RegExp(r.tool.slice(1, -1));
        } catch (e) {
          return { ok: false, error: `${listKey}[${i}].tool invalid regex: ${String(e)}` };
        }
      }
      if (r.bash_command_matches !== undefined) {
        if (typeof r.bash_command_matches !== "string")
          return { ok: false, error: `${listKey}[${i}].bash_command_matches must be a string` };
        try {
          new RegExp(r.bash_command_matches);
        } catch (e) {
          return {
            ok: false,
            error: `${listKey}[${i}].bash_command_matches invalid regex: ${String(e)}`,
          };
        }
      }
    }
  }
  if (obj.escalate_default !== undefined && typeof obj.escalate_default !== "boolean") {
    return { ok: false, error: "escalate_default must be boolean" };
  }
  if (obj.decision_timeout_seconds !== undefined && typeof obj.decision_timeout_seconds !== "number") {
    return { ok: false, error: "decision_timeout_seconds must be a number" };
  }
  // schema_version: strict + implicit-v1. Absent means POLICY_SCHEMA_VERSION;
  // an explicit value must equal it. Anything else is rejected with a message
  // naming the supported version. Purely additive — no existing policy that
  // omits the field becomes invalid.
  if (obj.schema_version !== undefined) {
    if (typeof obj.schema_version !== "number") {
      return { ok: false, error: "schema_version must be a number" };
    }
    if (obj.schema_version !== POLICY_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `policy schema_version ${obj.schema_version} is not supported; this build supports version ${POLICY_SCHEMA_VERSION}`,
      };
    }
  }
  // budget (CD-4): optional run-level circuit-breaker. When present it must be
  // an object; each present cap must be a finite, strictly-positive number.
  // Absent budget and absent individual caps are accepted as unlimited.
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== "object" || obj.budget === null || Array.isArray(obj.budget)) {
      return { ok: false, error: "budget must be an object" };
    }
    const b = obj.budget as Record<string, unknown>;
    for (const field of ["max_tool_calls", "max_wall_clock_seconds", "max_consecutive_errors"] as const) {
      const v = b[field];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return { ok: false, error: `budget.${field} must be a positive number` };
      }
    }
  }
  if (obj.bash_composition !== undefined) {
    if (obj.bash_composition !== "off" && obj.bash_composition !== "per_segment") {
      return { ok: false, error: 'bash_composition must be "off" or "per_segment"' };
    }
  }
  return { ok: true };
}

/**
 * Coerce a policy arg that may arrive as a JSON string (some MCP clients
 * serialize untyped object params to strings) into an object. Leaves
 * "bypass" and already-object values untouched; on parse failure returns
 * the raw value so validatePolicy produces the normal error.
 */
export function coercePolicy(raw: unknown): unknown {
  if (typeof raw === "string" && raw !== "bypass" && raw.trim().startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through to raw */
    }
  }
  return raw;
}

export function policyDigest(policy: Policy): string {
  // Stable-ish digest for events; not cryptographic.
  const s = JSON.stringify(policy);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return "p" + (h >>> 0).toString(16);
}
