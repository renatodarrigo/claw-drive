export type Severity = "low" | "medium" | "high";
export type DecisionAction = "approve" | "reject" | "defer";

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

  // Evaluation order: auto_reject > auto_defer > auto_approve > escalate_default.
  // Rationale (v0.2.3): a command that matches both an approve rule and a
  // reject rule — e.g. `git status; rm -rf /tmp` matching `^git ` + `\brm -rf\b`
  // — should be rejected, not silently approved. Asymmetric risk: a false-reject
  // is a human prompt, a false-approve is a bypass.
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

export function validatePolicy(p: unknown): { ok: true } | { ok: false; error: string } {
  if (p === "bypass") return { ok: true };
  if (typeof p !== "object" || p === null)
    return { ok: false, error: "policy must be 'bypass' or an object" };
  const obj = p as Record<string, unknown>;
  const allowedKeys = new Set(["auto_approve", "auto_defer", "auto_reject", "escalate_default", "decision_timeout_seconds"]);
  for (const key of Object.keys(obj)) {
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
  return { ok: true };
}

export function policyDigest(policy: Policy): string {
  // Stable-ish digest for events; not cryptographic.
  const s = JSON.stringify(policy);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return "p" + (h >>> 0).toString(16);
}
