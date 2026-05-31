/**
 * CD-5 — policy linter analysis engine (CD-29).
 *
 * Pure, I/O-free structural analysis of an already-validatePolicy'd
 * PolicyObject. lintPolicy() runs the default structural checks (regex compile,
 * shadowed/unreachable, overly-broad, known-false-positive) and — only when
 * opts.checkCoverage is set — the opt-in common-danger coverage check (CD-31).
 *
 * Heuristics are deliberately conservative so the two shipped templates lint
 * clean: "overly-broad" means the pattern matches the empty string or leads
 * with a wildcard (the shipped \b-anchored rules do neither), and the
 * known-FP check skips the policy-self-protection privilege rules whose
 * read-shape false-positive is documented and accepted.
 */
import type { PolicyObject, Rule } from "./policy.js";

export interface Finding {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
  list?: ListName;
  rule_index?: number;
  rule_name?: string;
}

export type ListName = "auto_reject" | "auto_defer" | "auto_approve";

/** Lists in policy evaluation order: a rule in an earlier list always wins. */
const LIST_ORDER: readonly ListName[] = ["auto_reject", "auto_defer", "auto_approve"];

export interface LintOptions {
  checkCoverage?: boolean;
}

export function lintPolicy(policy: PolicyObject, opts: LintOptions = {}): Finding[] {
  const findings: Finding[] = [];
  checkRegexCompile(policy, findings);
  checkShadowed(policy, findings);
  checkOverlyBroad(policy, findings);
  checkKnownFp(policy, findings);
  if (opts.checkCoverage) checkCoverage(policy, findings);
  return sortFindings(findings);
}

function eachRule(
  policy: PolicyObject,
  fn: (list: ListName, idx: number, rule: Rule) => void
): void {
  for (const list of LIST_ORDER) {
    const rules = policy[list] ?? [];
    rules.forEach((rule, idx) => fn(list, idx, rule));
  }
}

// -- Regex compile -----------------------------------------------------------

function checkRegexCompile(policy: PolicyObject, findings: Finding[]): void {
  eachRule(policy, (list, idx, rule) => {
    const patterns: string[] = [];
    if (rule.bash_command_matches) patterns.push(rule.bash_command_matches);
    if (rule.arg_matches) patterns.push(...Object.values(rule.arg_matches));
    for (const p of patterns) {
      try {
        new RegExp(p);
      } catch (e) {
        findings.push({
          severity: "error",
          code: "regex_compile",
          message: `pattern does not compile: ${p} (${(e as Error).message})`,
          list,
          rule_index: idx,
          rule_name: rule.name,
        });
      }
    }
  });
}

// -- Shadowed / unreachable --------------------------------------------------

/** True when `p` is "^" followed only by literal (non-metacharacter) chars. */
function isLiteralPrefixPattern(p: string): boolean {
  return p.startsWith("^") && !/[.*+?$|(){}[\]\\]/.test(p.slice(1));
}

/** Sound (incomplete) subsumption: does pattern `a` match a superset of `b`? */
function patternSubsumes(a: string, b: string): boolean {
  if (a === b) return true;
  // A literal-anchored `a` subsumes any anchored `b` that extends it (`^git ` ⊇ `^git status`).
  if (isLiteralPrefixPattern(a) && b.startsWith("^") && b.startsWith(a)) return true;
  return false;
}

/** Does rule `a` (earlier) make rule `b` (later) unreachable? */
function ruleSubsumes(a: Rule, b: Rule): boolean {
  if (a.tool !== b.tool) return false;
  const aBare = !a.bash_command_matches && !a.arg_matches;
  if (aBare) return true; // a tool-only rule matches every call for that tool
  if (a.bash_command_matches && b.bash_command_matches) {
    return patternSubsumes(a.bash_command_matches, b.bash_command_matches);
  }
  if (a.arg_matches && b.arg_matches) {
    return JSON.stringify(a.arg_matches) === JSON.stringify(b.arg_matches);
  }
  return false;
}

function describePattern(rule: Rule): string {
  if (rule.bash_command_matches) return rule.bash_command_matches;
  if (rule.arg_matches) return JSON.stringify(rule.arg_matches);
  return "(tool-wide)";
}

function checkShadowed(policy: PolicyObject, findings: Finding[]): void {
  const all: Array<{ list: ListName; idx: number; rule: Rule }> = [];
  for (const list of LIST_ORDER) {
    (policy[list] ?? []).forEach((rule, idx) => all.push({ list, idx, rule }));
  }
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    for (let j = 0; j < i; j++) {
      const earlier = all[j];
      if (ruleSubsumes(earlier.rule, cur.rule)) {
        findings.push({
          severity: "warn",
          code: "shadowed_rule",
          message: `rule is unreachable — shadowed by the earlier ${earlier.list}[${earlier.idx}] "${earlier.rule.name ?? "(unnamed)"}" (${describePattern(earlier.rule)}), which is evaluated first and always matches`,
          list: cur.list,
          rule_index: cur.idx,
          rule_name: cur.rule.name,
        });
        break; // one shadowing finding per rule
      }
    }
  }
}

// -- Overly-broad heuristic --------------------------------------------------

function checkOverlyBroad(policy: PolicyObject, findings: Finding[]): void {
  eachRule(policy, (list, idx, rule) => {
    const p = rule.bash_command_matches;
    if (!p) return;
    let re: RegExp;
    try {
      re = new RegExp(p);
    } catch {
      return; // already reported by the compile check
    }
    const matchesEmpty = re.test("");
    const leadingWildcard = /^(\.\*|\.\+)/.test(p);
    if (matchesEmpty || leadingWildcard) {
      const why = matchesEmpty
        ? "matches the empty string, so it matches every command"
        : "leads with .* / .+, so it matches anywhere very broadly";
      findings.push({
        severity: "warn",
        code: "overly_broad",
        message: `pattern is overly broad (${why}): ${p}`,
        list,
        rule_index: idx,
        rule_name: rule.name,
      });
    }
  });
}

// -- Known false-positive shape ----------------------------------------------

/** Read-intent backup/copy commands that a write-shaped reject rule may wrongly catch. */
const FP_READ_INTENT_COMMANDS = [
  "cp config.json /backup/config.json",
  "cp data.txt /mnt/backup/data.txt",
];

/**
 * The shipped policy-self-protection rules (targeting the policy file or the
 * .claw-drive runtime dir) have a documented, accepted read-shape FP — skip
 * them so the linter only nudges on a user's own write-shaped reject rules.
 */
function isPrivilegeRule(rule: Rule): boolean {
  const hay = (rule.bash_command_matches ?? "") + " " + (rule.arg_matches ? Object.values(rule.arg_matches).join(" ") : "");
  return /claw-drive-policy|\.claw-drive/.test(hay);
}

function checkKnownFp(policy: PolicyObject, findings: Finding[]): void {
  (policy.auto_reject ?? []).forEach((rule, idx) => {
    if (rule.tool !== "Bash" || !rule.bash_command_matches) return;
    if (isPrivilegeRule(rule)) return;
    let re: RegExp;
    try {
      re = new RegExp(rule.bash_command_matches);
    } catch {
      return;
    }
    for (const cmd of FP_READ_INTENT_COMMANDS) {
      if (re.test(cmd)) {
        findings.push({
          severity: "info",
          code: "known_fp_read_shape",
          message: `auto_reject rule may false-positive on a read-intent command like \`${cmd}\` (a write-shaped match of a backup/copy)`,
          list: "auto_reject",
          rule_index: idx,
          rule_name: rule.name,
        });
        break;
      }
    }
  });
}

// -- Common-danger coverage (opt-in; CD-31) ----------------------------------

function checkCoverage(_policy: PolicyObject, _findings: Finding[]): void {
  // No-op stub — coverage analysis is delivered in CD-31.
}

// -- Deterministic ordering --------------------------------------------------

const SEV_ORDER: Record<Finding["severity"], number> = { error: 0, warn: 1, info: 2 };
const LIST_IDX: Record<ListName, number> = { auto_reject: 0, auto_defer: 1, auto_approve: 2 };

function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    if (SEV_ORDER[a.severity] !== SEV_ORDER[b.severity]) return SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    const la = a.list ? LIST_IDX[a.list] : 99;
    const lb = b.list ? LIST_IDX[b.list] : 99;
    if (la !== lb) return la - lb;
    if ((a.rule_index ?? -1) !== (b.rule_index ?? -1)) return (a.rule_index ?? -1) - (b.rule_index ?? -1);
    return a.code.localeCompare(b.code);
  });
}
