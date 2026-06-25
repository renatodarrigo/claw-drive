import * as fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeComposition } from "../../lib/bash-composition.js";
import {
  matchPolicy,
  validatePolicy,
  type Policy,
  type PolicyObject,
  type Rule,
  type MatchDecision,
} from "../../lib/policy.js";

export type Format = "human" | "explain" | "json";
export type ColorMode = "auto" | "off";
export type ExitOn = "reject" | "defer" | "approve" | "escalate";

export type PolicySource =
  | { kind: "file"; path: string; label: string }
  | { kind: "keyword"; label: string };

export interface RenderOpts {
  color: ColorMode;
  list?: ListName;
}

export type ListName = "auto_reject" | "auto_defer" | "auto_approve";

export type ParsedArgs =
  | { ok: true; help: true }
  | {
      ok: true;
      help: false;
      tool: string;
      args: Record<string, string>;
      policySpec: string | undefined;
      format: Format;
      exitOn: ExitOn | undefined;
      color: ColorMode;
    }
  | { ok: false; error: string };

export type ResolvedPolicy =
  | { ok: true; policy: Policy; source: PolicySource }
  | { ok: false; error: string };

const VALID_EXIT_ON: readonly string[] = ["reject", "defer", "approve", "escalate"];

export function parseArgs(argv: string[]): ParsedArgs {
  let tool = "Bash";
  let toolExplicit = false;
  const args: Record<string, string> = {};
  let policySpec: string | undefined;
  let format: Format = "human";
  let formatSetExplain = false;
  let formatSetJson = false;
  let exitOn: ExitOn | undefined;
  let color: ColorMode = "auto";
  let positional: string | undefined;
  let positionalCount = 0;
  let argFromCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: true, help: true };
    if (a === "--tool") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--tool requires a value" };
      tool = v;
      toolExplicit = true;
    } else if (a === "--arg") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--arg requires KEY=VALUE" };
      const eq = v.indexOf("=");
      if (eq < 0) return { ok: false, error: `--arg expects KEY=VALUE, got: ${v}` };
      const k = v.slice(0, eq);
      const val = v.slice(eq + 1);
      if (!k) return { ok: false, error: `--arg key is empty: ${v}` };
      args[k] = val;
      if (k === "command") argFromCommand = true;
    } else if (a === "--policy") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--policy requires a value" };
      policySpec = v;
    } else if (a === "--explain") {
      formatSetExplain = true;
      format = "explain";
    } else if (a === "--json") {
      formatSetJson = true;
      format = "json";
    } else if (a === "--exit-on") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--exit-on requires a value" };
      if (!VALID_EXIT_ON.includes(v))
        return {
          ok: false,
          error: `--exit-on must be one of ${VALID_EXIT_ON.join("|")}, got: ${v}`,
        };
      exitOn = v as ExitOn;
    } else if (a === "--no-color") {
      color = "off";
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}` };
    } else {
      positionalCount++;
      if (positionalCount > 1) return { ok: false, error: "at most one positional argument" };
      positional = a;
    }
  }

  if (formatSetExplain && formatSetJson) {
    return { ok: false, error: "--explain and --json are mutually exclusive" };
  }

  if (positional !== undefined) {
    if (toolExplicit && tool !== "Bash") {
      return {
        ok: false,
        error: `positional command is only valid when --tool is Bash; use --arg key=value for tool '${tool}'`,
      };
    }
    if (argFromCommand) {
      return { ok: false, error: "positional and --arg command=... are redundant; use one or the other" };
    }
    args.command = positional;
  }

  return {
    ok: true,
    help: false,
    tool,
    args,
    policySpec,
    format,
    exitOn,
    color,
  };
}

export function resolvePolicySource(
  spec: string | undefined,
  repoRoot: string
): ResolvedPolicy {
  if (spec === "bypass") {
    return { ok: true, policy: "bypass", source: { kind: "keyword", label: "bypass" } };
  }
  let path: string;
  let label: string;
  if (spec === undefined || spec === "starter") {
    path = resolve(repoRoot, "templates", "claw-drive-policy.json");
    label = "starter";
  } else if (spec === "permissive") {
    path = resolve(repoRoot, "templates", "claw-drive-policy-permissive.json");
    label = "permissive";
  } else {
    path = spec;
    label = "file";
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (e) {
    return { ok: false, error: `cannot read policy file ${path}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON in policy file ${path}: ${(e as Error).message}` };
  }
  const v = validatePolicy(parsed);
  if (!v.ok) {
    return { ok: false, error: `invalid policy schema in ${path}: ${v.error}` };
  }
  return { ok: true, policy: parsed as Policy, source: { kind: "file", path, label } };
}

const ANSI = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function colorize(text: string, color: ColorMode, fn: (s: string) => string): string {
  return color === "off" ? text : fn(text);
}

function policyLabel(source: PolicySource): string {
  return source.kind === "file" ? `${source.path} (${source.label})` : source.label;
}

function formatArgs(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function renderHuman(
  call: { tool: string; args: Record<string, string> },
  source: PolicySource,
  result: MatchDecision,
  opts: RenderOpts
): string {
  const lines: string[] = [];
  lines.push(`Decision:       ${result.decision}`);
  if (result.decision === "escalate") {
    lines.push(`Default action: ${result.default_action}`);
  }
  if (result.decision === "escalate" && !opts.list) {
    lines.push(`List:           (none — escalate_default)`);
    lines.push(`Matched rule:   (none)`);
  } else if (opts.list) {
    lines.push(`List:           ${opts.list}`);
    const rule = result.matched_rule;
    if (rule) {
      const ruleName = rule.name ?? "(unnamed)";
      lines.push(`Matched rule:   "${ruleName}"`);
      if (call.tool === "Bash" && rule.bash_command_matches) {
        lines.push(`Pattern:        ${rule.bash_command_matches}`);
      }
      if (rule.arg_matches) {
        const argLines = Object.entries(rule.arg_matches).map(
          ([k, v]) => `${k} matches ${v}`
        );
        lines.push(`Arg patterns:   ${argLines.join("; ")}`);
      }
      if (rule.severity) {
        lines.push(`Severity:       ${rule.severity}`);
      }
    }
  }
  lines.push(`Tool:           ${call.tool}`);
  if (call.tool === "Bash" && call.args.command !== undefined) {
    lines.push(`Command:        ${call.args.command}`);
  } else {
    lines.push(`Args:           ${formatArgs(call.args)}`);
  }
  lines.push(`Policy:         ${policyLabel(source)}`);
  return lines.join("\n");
}

export function renderExplain(
  call: { tool: string; args: Record<string, string> },
  policy: Policy,
  source: PolicySource,
  opts: RenderOpts
): string {
  const lines: string[] = [];
  lines.push(`Tool: ${call.tool}`);
  if (call.tool === "Bash" && call.args.command !== undefined) {
    lines.push(`Command: ${call.args.command}`);
  } else {
    lines.push(`Args: ${formatArgs(call.args)}`);
  }
  lines.push(`Policy: ${policyLabel(source)}`);

  if (policy === "bypass") {
    lines.push(``);
    lines.push(`Policy is "bypass" — every call returns approve_silent.`);
    lines.push(``);
    lines.push(`=> approve_silent`);
    return lines.join("\n");
  }

  lines.push(`Eval order: auto_reject → auto_defer → auto_approve → escalate_default`);

  const obj = policy as PolicyObject;

  if (obj.bash_composition === "per_segment" && call.tool === "Bash") {
    const command = call.args.command ?? "";
    const a = analyzeComposition(command);
    if (a.opaque || a.malformed) {
      lines.push("");
      lines.push(
        colorize(
          `  bash_composition=per_segment: ${a.opaque ? "opaque construct (command-substitution / here-doc)" : "malformed / empty segment"} → reject (rules not walked)`,
          opts.color,
          ANSI.dim
        )
      );
      lines.push("");
      lines.push(verdictLine(matchPolicy(policy, call)));
      return lines.join("\n");
    }
    if (a.segments.length > 1) {
      lines.push(
        colorize(
          `  bash_composition=per_segment: ${a.segments.length} segments — each evaluated independently, strictest wins`,
          opts.color,
          ANSI.dim
        )
      );
      a.segments.forEach((seg, idx) => {
        lines.push("");
        lines.push(`Segment ${idx + 1}: ${seg}`);
        lines.push(...walkRules(obj, { tool: "Bash", args: { command: seg } }, opts));
      });
      lines.push("");
      lines.push(verdictLine(matchPolicy(policy, call)));
      return lines.join("\n");
    }
    // single segment ⇒ fall through to the normal whole-command walk
  }

  lines.push(...walkRules(obj, call, opts));
  lines.push("");
  lines.push(verdictLine(matchPolicy(policy, call)));
  return lines.join("\n");
}

// Render the ✓/✗ rule walk for one call (first matching rule across the three
// ordered lists wins the ✓).
function walkRules(
  obj: PolicyObject,
  call: { tool: string; args: Record<string, string> },
  opts: RenderOpts
): string[] {
  const lines: string[] = [];
  let found = false;
  for (const list of ["auto_reject", "auto_defer", "auto_approve"] as const) {
    const rules = obj[list] ?? [];
    lines.push("");
    lines.push(`[${list}] (${rules.length} ${rules.length === 1 ? "rule" : "rules"})`);
    if (rules.length === 0) {
      lines.push(colorize("  (empty)", opts.color, ANSI.dim));
      continue;
    }
    for (const rule of rules) {
      const matches = !found && ruleMatchesCall(rule, call);
      const tick = matches ? colorize("✓", opts.color, ANSI.green) : colorize("✗", opts.color, ANSI.dim);
      const name = rule.name ?? "(unnamed)";
      const styled = matches ? name : colorize(name, opts.color, ANSI.dim);
      lines.push(`  ${tick} ${styled}`);
      if (matches) found = true;
    }
  }
  return lines;
}

// Authoritative verdict line, rendered from matchPolicy's decision so --explain
// never disagrees with the runner. Text matches the previous inline format.
function verdictLine(d: MatchDecision): string {
  if (d.decision === "approve_silent") return "=> approve_silent";
  if (d.decision === "deny_silent") {
    return `=> deny_silent  (${d.matched_rule?.name ?? "escalate_default=false"})`;
  }
  if (d.default_action === "approve") {
    return `=> escalate, default_action=approve, severity=${d.severity}  (escalate_default)`;
  }
  return `=> escalate, default_action=${d.default_action}, severity=${d.severity}`;
}

function ruleMatchesCall(
  rule: Rule,
  call: { tool: string; args: Record<string, string> }
): boolean {
  if (!toolNameMatches(rule.tool, call.tool)) return false;
  if (call.tool === "Bash") {
    if (rule.bash_command_matches) {
      const cmd = call.args.command ?? "";
      try {
        if (!new RegExp(rule.bash_command_matches).test(cmd)) return false;
      } catch {
        return false;
      }
    }
  } else if (rule.arg_matches) {
    for (const [k, pattern] of Object.entries(rule.arg_matches)) {
      const val = call.args[k] ?? "";
      try {
        if (!new RegExp(pattern).test(val)) return false;
      } catch {
        return false;
      }
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

export function renderJson(
  call: { tool: string; args: Record<string, string> },
  source: PolicySource,
  result: MatchDecision,
  list: ListName | undefined
): string {
  const out: Record<string, unknown> = {
    input: { tool: call.tool, args: call.args },
    policy_source: source,
    decision: result.decision,
  };
  if (result.decision === "escalate") {
    out.default_action = result.default_action;
    out.severity = result.severity;
  }
  if (result.decision !== "deny_silent" && (result as { matched_rule?: Rule }).matched_rule) {
    out.matched_rule = (result as { matched_rule?: Rule }).matched_rule;
  }
  if (list !== undefined) out.list = list;
  return JSON.stringify(out);
}

function getRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  // dist/cli/commands/policy-test.js → ../../../  (or src/cli/commands/policy-test.ts in dev/test)
  return resolve(dirname(here), "..", "..", "..");
}

function findMatchedListAndRule(
  policy: Policy,
  call: { tool: string; args: Record<string, string> }
): { list: ListName | undefined; rule: Rule | undefined } {
  if (policy === "bypass") return { list: undefined, rule: undefined };
  const obj = policy;
  for (const list of ["auto_reject", "auto_defer", "auto_approve"] as const) {
    for (const rule of obj[list] ?? []) {
      if (ruleMatchesCall(rule, call)) return { list, rule };
    }
  }
  return { list: undefined, rule: undefined };
}

function printUsage(): void {
  console.log(`claw-drive policy-test — test a tool call against a policy

Usage:
  claw-drive policy-test [flags] '<bash-command>'
  claw-drive policy-test --tool TOOL --arg KEY=VALUE [--arg ...] [flags]

Flags:
  --tool TOOL                Tool name (default: Bash)
  --arg KEY=VALUE            Tool argument (repeatable). For Bash, the
                             positional command is shorthand for
                             --arg command=<positional>.
  --policy SPEC              Policy to test. SPEC is one of:
                               starter      (default — templates/claw-drive-policy.json)
                               permissive   (templates/claw-drive-policy-permissive.json)
                               bypass       (literal "bypass" policy)
                               <path>       a custom policy JSON file
  --explain                  Walk every rule in evaluation order with ✓/✗ marks
  --json                     Single-line JSON output for piping
  --exit-on DECISION         Exit 1 instead of 0 if the decision matches
                             DECISION (one of reject|defer|approve|escalate)
  --no-color                 Disable ANSI color (also: NO_COLOR env var)
  --help, -h                 Print this help and exit

Examples:
  claw-drive policy-test 'kill -9 1'
  claw-drive policy-test --explain 'sudo apt install foo'
  claw-drive policy-test --tool Read --arg file_path=/etc/passwd
  claw-drive policy-test --policy permissive --json 'rg foo src/'
  claw-drive policy-test --exit-on reject 'rm -rf /tmp/x'   # CI-style gating
`);
}

export async function cmdPolicyTest(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const repoRoot = getRepoRoot();
  const resolved = resolvePolicySource(parsed.policySpec, repoRoot);
  if (!resolved.ok) {
    console.error(resolved.error);
    return 3;
  }

  const call = { tool: parsed.tool, args: parsed.args };
  const result = matchPolicy(resolved.policy, call);
  const { list, rule } = findMatchedListAndRule(resolved.policy, call);

  // Tests assert the result.matched_rule — make sure render uses what we found.
  // matchPolicy already sets matched_rule, but we also have list separately for rendering.
  const renderResult: MatchDecision = result;
  // Sanity check (both should be the same rule):
  void rule;

  let color: ColorMode = parsed.color;
  if (color === "auto") {
    if (process.env.NO_COLOR || !process.stdout.isTTY) color = "off";
  }

  let out: string;
  if (parsed.format === "json") {
    out = renderJson(call, resolved.source, renderResult, list);
  } else if (parsed.format === "explain") {
    out = renderExplain(call, resolved.policy, resolved.source, { color });
  } else {
    out = renderHuman(call, resolved.source, renderResult, { color, list });
  }
  console.log(out);

  if (parsed.exitOn) {
    let triggered = false;
    if (parsed.exitOn === "escalate") triggered = result.decision === "escalate";
    else if (result.decision === "escalate") triggered = result.default_action === parsed.exitOn;
    else if (parsed.exitOn === "approve") triggered = result.decision === "approve_silent";
    if (triggered) return 1;
  }
  return 0;
}
