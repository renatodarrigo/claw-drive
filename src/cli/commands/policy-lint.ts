/**
 * CD-5 — `claw-drive policy lint <file>` (CD-30).
 *
 * Resolves a policy file (reusing policy-test's read + JSON.parse +
 * validatePolicy pattern), runs lintPolicy, and renders findings grouped by
 * severity (human) or as a structured object (--json). --max-severity gates
 * the exit code for CI; --check-coverage turns on the opt-in coverage check
 * (CD-31). The lint subcommand is dispatched from cmdPolicy on argv[0]==="lint".
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePolicySource } from "./policy-test.js";
import { lintPolicy, type Finding } from "../../lib/policy-lint.js";

type ColorMode = "auto" | "off";
type MaxSeverity = "warn" | "error";

type LintParsed =
  | { ok: true; help: true }
  | {
      ok: true;
      help: false;
      file: string | undefined;
      json: boolean;
      maxSeverity: MaxSeverity | undefined;
      checkCoverage: boolean;
      color: ColorMode;
    }
  | { ok: false; error: string };

export function parseLintArgs(argv: string[]): LintParsed {
  let file: string | undefined;
  let json = false;
  let maxSeverity: MaxSeverity | undefined;
  let checkCoverage = false;
  let color: ColorMode = "auto";
  let positionalCount = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: true, help: true };
    else if (a === "--json") json = true;
    else if (a === "--max-severity") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "--max-severity requires a value (warn|error)" };
      if (v !== "warn" && v !== "error") return { ok: false, error: `--max-severity must be warn|error, got: ${v}` };
      maxSeverity = v;
    } else if (a === "--check-coverage") {
      checkCoverage = true;
    } else if (a === "--no-color") {
      color = "off";
    } else if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag: ${a}` };
    } else {
      positionalCount++;
      if (positionalCount > 1) return { ok: false, error: "at most one positional <file>" };
      file = a;
    }
  }
  return { ok: true, help: false, file, json, maxSeverity, checkCoverage, color };
}

const ANSI = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export interface LintSummary {
  error: number;
  warn: number;
  info: number;
}

export function summarize(findings: Finding[]): LintSummary {
  return {
    error: findings.filter((f) => f.severity === "error").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
}

function locator(f: Finding): string {
  if (f.list === undefined) return "(policy)";
  const idx = f.rule_index ?? 0;
  const name = f.rule_name ? ` "${f.rule_name}"` : "";
  return `${f.list}[${idx}]${name}`;
}

export function renderLintHuman(label: string, findings: Finding[], color: ColorMode): string {
  const sum = summarize(findings);
  const lines: string[] = [`Policy: ${label}`, ``];
  if (findings.length === 0) {
    lines.push("No findings — policy is structurally clean.");
    return lines.join("\n");
  }
  lines.push(
    `${findings.length} ${findings.length === 1 ? "finding" : "findings"} — ${sum.error} error, ${sum.warn} warning, ${sum.info} info`
  );
  const groups: Array<{ sev: Finding["severity"]; title: string; paint: (s: string) => string }> = [
    { sev: "error", title: "errors", paint: ANSI.red },
    { sev: "warn", title: "warnings", paint: ANSI.yellow },
    { sev: "info", title: "info", paint: ANSI.dim },
  ];
  for (const g of groups) {
    const group = findings.filter((f) => f.severity === g.sev);
    if (group.length === 0) continue;
    const title = color === "off" ? g.title : g.paint(g.title);
    lines.push(``, `${title} (${group.length}):`);
    for (const f of group) {
      const code = color === "off" ? f.code : ANSI.dim(`[${f.code}]`);
      const codeText = color === "off" ? `[${f.code}]` : code;
      lines.push(`  ${locator(f)} — ${f.message} ${codeText}`);
    }
  }
  return lines.join("\n");
}

function getRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  // dist/cli/commands/policy-lint.js → ../../../  (or src/... in dev/test)
  return resolve(dirname(here), "..", "..", "..");
}

function printLintUsage(): void {
  console.log(`claw-drive policy lint — analyze a policy file for structural problems

Usage:
  claw-drive policy lint <file> [flags]
  claw-drive policy lint starter|permissive    (lint a shipped template)

Default checks:
  - regex compile errors (a pattern that does not compile)
  - shadowed / unreachable rules (a rule an earlier stricter rule always wins over)
  - overly-broad patterns (matches the empty string, or leads with .* / .+)
  - known false-positive shapes (a write-shaped reject that catches a read-intent backup)

Flags:
  --check-coverage              Also report common-danger families (rm -rf, git push,
                                dd, mkfs, interpreter escapes) the policy neither rejects
                                nor defers. Off by default.
  --json                        Emit { file, findings, summary } as a single JSON object
  --max-severity warn|error     Exit non-zero when any finding at or above the threshold
                                is present (for CI). Omit to always exit 0 (report-only).
  --no-color                    Disable ANSI color (also: NO_COLOR env var)
  --help, -h                    Print this help and exit

Examples:
  claw-drive policy lint ./my-policy.json
  claw-drive policy lint --check-coverage --max-severity warn ./my-policy.json
  claw-drive policy lint --json starter | jq .summary
`);
}

export async function cmdPolicyLint(argv: string[]): Promise<number> {
  const parsed = parseLintArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.help) {
    printLintUsage();
    return 0;
  }
  if (!parsed.file) {
    console.error("usage: claw-drive policy lint <file> [--json] [--max-severity warn|error] [--check-coverage]");
    return 2;
  }

  const resolved = resolvePolicySource(parsed.file, getRepoRoot());
  if (!resolved.ok) {
    console.error(resolved.error);
    return 3;
  }

  const label =
    resolved.source.kind === "file" ? `${resolved.source.path} (${resolved.source.label})` : resolved.source.label;
  const findings =
    resolved.policy === "bypass" ? [] : lintPolicy(resolved.policy, { checkCoverage: parsed.checkCoverage });

  let color = parsed.color;
  if (color === "auto") {
    if (process.env.NO_COLOR || !process.stdout.isTTY) color = "off";
  }

  if (parsed.json) {
    console.log(JSON.stringify({ file: label, findings, summary: summarize(findings) }));
  } else {
    console.log(renderLintHuman(label, findings, color));
  }

  if (parsed.maxSeverity) {
    const gating: Finding["severity"][] = parsed.maxSeverity === "error" ? ["error"] : ["error", "warn"];
    if (findings.some((f) => gating.includes(f.severity))) return 1;
  }
  return 0;
}
