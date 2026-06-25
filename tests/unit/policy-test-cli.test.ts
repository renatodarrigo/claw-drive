import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import {
  parseArgs,
  resolvePolicySource,
  renderHuman,
  renderExplain,
  renderJson,
  cmdPolicyTest,
} from "../../src/cli/commands/policy-test.js";
import type { Policy } from "../../src/lib/policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);
const REPO_ROOT = nodePath.resolve(__dirname, "..", "..");

describe("policy-test parseArgs", () => {
  it("parses a Bash positional command (default tool)", () => {
    const r = parseArgs(["kill -9 1"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.tool).toBe("Bash");
      expect(r.args).toEqual({ command: "kill -9 1" });
      expect(r.policySpec).toBeUndefined();
      expect(r.format).toBe("human");
      expect(r.exitOn).toBeUndefined();
      expect(r.color).toBe("auto");
    }
  });

  it("--tool Bash + positional → command arg", () => {
    const r = parseArgs(["--tool", "Bash", "kill -9 1"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.tool).toBe("Bash");
      expect(r.args).toEqual({ command: "kill -9 1" });
    }
  });

  it("--tool Bash + --arg command=... → command arg", () => {
    const r = parseArgs(["--tool", "Bash", "--arg", "command=git status"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.tool).toBe("Bash");
      expect(r.args).toEqual({ command: "git status" });
    }
  });

  it("--tool Read + --arg file_path=...", () => {
    const r = parseArgs(["--tool", "Read", "--arg", "file_path=/etc/passwd"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.tool).toBe("Read");
      expect(r.args).toEqual({ file_path: "/etc/passwd" });
    }
  });

  it("multiple --arg flags accumulate", () => {
    const r = parseArgs([
      "--tool", "Edit",
      "--arg", "file_path=/tmp/foo.ts",
      "--arg", "old_string=secret",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.tool).toBe("Edit");
      expect(r.args).toEqual({ file_path: "/tmp/foo.ts", old_string: "secret" });
    }
  });

  it("--arg value with embedded = splits on first =", () => {
    const r = parseArgs(["--tool", "Grep", "--arg", "pattern=^foo=bar$"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.args).toEqual({ pattern: "^foo=bar$" });
    }
  });

  it("--policy path", () => {
    const r = parseArgs(["--policy", "/tmp/p.json", "ls"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.policySpec).toBe("/tmp/p.json");
    }
  });

  it("--policy starter", () => {
    const r = parseArgs(["--policy", "starter", "ls"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) expect(r.policySpec).toBe("starter");
  });

  it("--explain flag", () => {
    const r = parseArgs(["--explain", "ls"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) expect(r.format).toBe("explain");
  });

  it("--json flag", () => {
    const r = parseArgs(["--json", "ls"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) expect(r.format).toBe("json");
  });

  it("--exit-on reject", () => {
    const r = parseArgs(["--exit-on", "reject", "ls"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) expect(r.exitOn).toBe("reject");
  });

  it("--no-color forces color off", () => {
    const r = parseArgs(["--no-color", "ls"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) expect(r.color).toBe("off");
  });

  it("--help short-circuits", () => {
    const r = parseArgs(["--help"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.help).toBe(true);
  });

  it("rejects --explain + --json (mutually exclusive)", () => {
    const r = parseArgs(["--explain", "--json", "ls"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/explain.*json|json.*explain/i);
  });

  it("rejects positional with non-Bash --tool", () => {
    const r = parseArgs(["--tool", "Read", "/etc/passwd"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positional|--arg/i);
  });

  it("rejects positional + --arg command= (redundant)", () => {
    const r = parseArgs(["--arg", "command=ls", "ls"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positional|command/i);
  });

  it("rejects multiple positionals", () => {
    const r = parseArgs(["ls", "-la"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --arg without =", () => {
    const r = parseArgs(["--arg", "broken", "ls"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/=|key=value/i);
  });

  it("rejects --tool without value", () => {
    const r = parseArgs(["--tool"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --exit-on with invalid value", () => {
    const r = parseArgs(["--exit-on", "bogus", "ls"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exit-on/i);
  });

  it("rejects unknown flag", () => {
    const r = parseArgs(["--frobnicate", "ls"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown|frobnicate/i);
  });
});

describe("policy-test resolvePolicySource", () => {
  it("undefined → starter template", () => {
    const r = resolvePolicySource(undefined, REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.kind).toBe("file");
      expect(r.source.label).toBe("starter");
      expect(r.source.path).toMatch(/templates\/claw-drive-policy\.json$/);
      expect(typeof r.policy).toBe("object");
    }
  });

  it("'starter' → starter template", () => {
    const r = resolvePolicySource("starter", REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source.label).toBe("starter");
  });

  it("'permissive' → permissive template", () => {
    const r = resolvePolicySource("permissive", REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.label).toBe("permissive");
      expect(r.source.path).toMatch(/permissive\.json$/);
    }
  });

  it("'bypass' → 'bypass' literal policy", () => {
    const r = resolvePolicySource("bypass", REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.kind).toBe("keyword");
      expect(r.source.label).toBe("bypass");
      expect(r.policy).toBe("bypass");
    }
  });

  it("custom file path resolves and parses", () => {
    const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), "policy-test-"));
    const p: Policy = { auto_approve: [{ tool: "Bash", bash_command_matches: "^echo " }] };
    const file = nodePath.join(tmpDir, "p.json");
    fsSync.writeFileSync(file, JSON.stringify(p));
    try {
      const r = resolvePolicySource(file, REPO_ROOT);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.source.kind).toBe("file");
        expect(r.source.path).toBe(file);
        expect(r.source.label).toBe("file");
        expect(r.policy).toEqual(p);
      }
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("nonexistent file → error", () => {
    const r = resolvePolicySource("/nonexistent/policy.json", REPO_ROOT);
    expect(r.ok).toBe(false);
  });

  it("invalid JSON file → error", () => {
    const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), "policy-test-"));
    const file = nodePath.join(tmpDir, "bad.json");
    fsSync.writeFileSync(file, "not json {{");
    try {
      const r = resolvePolicySource(file, REPO_ROOT);
      expect(r.ok).toBe(false);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("invalid policy schema → error", () => {
    const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), "policy-test-"));
    const file = nodePath.join(tmpDir, "schema-bad.json");
    fsSync.writeFileSync(file, JSON.stringify({ auto_approve: "should-be-array" }));
    try {
      const r = resolvePolicySource(file, REPO_ROOT);
      expect(r.ok).toBe(false);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("policy-test renderHuman", () => {
  const starterSource = {
    kind: "file" as const,
    path: "/repo/templates/claw-drive-policy.json",
    label: "starter",
  };

  it("renders escalate/defer with matched rule, pattern, severity, list", () => {
    const out = renderHuman(
      { tool: "Bash", args: { command: "kill -9 1" } },
      starterSource,
      {
        decision: "escalate",
        default_action: "defer",
        severity: "high",
        matched_rule: {
          name: "kill -9 of init/everything/process-group (PID 1, -1, or 0)",
          tool: "Bash",
          bash_command_matches: "\\bkill\\s+-9\\b.*?\\s(-1|0|1)(\\s|$|[;&|])",
          severity: "high",
        },
      },
      { color: "off", list: "auto_defer" }
    );
    expect(out).toMatch(/Decision:\s+escalate/);
    expect(out).toMatch(/Default action:\s+defer/);
    expect(out).toMatch(/List:\s+auto_defer/);
    expect(out).toMatch(/Matched rule:.*kill -9 of init/);
    expect(out).toMatch(/Pattern:.*kill\\s\+-9/);
    expect(out).toMatch(/Severity:\s+high/);
    expect(out).toMatch(/Tool:\s+Bash/);
    expect(out).toMatch(/Command:\s+kill -9 1/);
    expect(out).toMatch(/Policy:.*starter/);
  });

  it("renders approve_silent (auto_approve)", () => {
    const out = renderHuman(
      { tool: "Read", args: { file_path: "/x" } },
      starterSource,
      {
        decision: "approve_silent",
        matched_rule: { tool: "Read" },
      },
      { color: "off", list: "auto_approve" }
    );
    expect(out).toMatch(/Decision:\s+approve_silent/);
    expect(out).toMatch(/List:\s+auto_approve/);
    expect(out).toMatch(/Tool:\s+Read/);
    expect(out).toMatch(/Args:\s+file_path=\/x/);
    expect(out).not.toMatch(/Default action:/);
  });

  it("renders escalate-default (no rule matched, falls through)", () => {
    const out = renderHuman(
      { tool: "Bash", args: { command: "true" } },
      starterSource,
      {
        decision: "escalate",
        default_action: "approve",
        severity: "medium",
      },
      { color: "off", list: undefined }
    );
    expect(out).toMatch(/Decision:\s+escalate/);
    expect(out).toMatch(/Default action:\s+approve/);
    expect(out).toMatch(/List:\s+\(none — escalate_default\)/);
    expect(out).toMatch(/Matched rule:\s+\(none\)/);
  });

  it("renders bypass policy result", () => {
    const out = renderHuman(
      { tool: "Bash", args: { command: "rm -rf /" } },
      { kind: "keyword", label: "bypass" },
      { decision: "approve_silent" },
      { color: "off", list: undefined }
    );
    expect(out).toMatch(/Decision:\s+approve_silent/);
    expect(out).toMatch(/Policy:.*bypass/);
  });

  it("includes Arg patterns line for arg_matches rule", () => {
    const out = renderHuman(
      { tool: "Edit", args: { file_path: "/etc/passwd" } },
      starterSource,
      {
        decision: "escalate",
        default_action: "defer",
        severity: "high",
        matched_rule: {
          name: "edits to /etc",
          tool: "Edit",
          arg_matches: { file_path: "^/etc/" },
        },
      },
      { color: "off", list: "auto_defer" }
    );
    expect(out).toMatch(/Arg patterns:.*file_path matches \^\/etc\//);
  });
});

describe("policy-test renderExplain", () => {
  const starter: Policy = {
    auto_reject: [{ tool: "Bash", bash_command_matches: "^rm ", name: "no rm" }],
    auto_defer: [
      { tool: "Bash", bash_command_matches: "^sudo ", name: "sudo defer" },
      { tool: "Bash", bash_command_matches: "^kill -9 1$", name: "kill init" },
    ],
    auto_approve: [{ tool: "Bash", bash_command_matches: "^echo ", name: "echo ok" }],
  };
  const source = { kind: "file" as const, path: "/x", label: "test" };

  it("walks all rules in order, marks the matched one with ✓", () => {
    const out = renderExplain(
      { tool: "Bash", args: { command: "kill -9 1" } },
      starter,
      source,
      { color: "off" }
    );
    expect(out).toMatch(/Eval order:.*auto_reject.*auto_defer.*auto_approve.*escalate_default/);
    expect(out).toMatch(/\[auto_reject\] \(1 rule\)/);
    expect(out).toMatch(/\[auto_defer\] \(2 rules\)/);
    expect(out).toMatch(/\[auto_approve\] \(1 rule\)/);
    // The rejected one for this command:
    expect(out).toMatch(/✗.*no rm/);
    // The matched one:
    expect(out).toMatch(/✓.*kill init/);
  });

  it("shows escalate_default when nothing matches", () => {
    const out = renderExplain(
      { tool: "Bash", args: { command: "ls" } },
      starter,
      source,
      { color: "off" }
    );
    expect(out).toMatch(/=> escalate.*default_action=approve/);
  });

  it("renders bypass policy in explain mode", () => {
    const out = renderExplain(
      { tool: "Bash", args: { command: "rm -rf /" } },
      "bypass" as Policy,
      { kind: "keyword", label: "bypass" },
      { color: "off" }
    );
    expect(out).toMatch(/bypass.*approve_silent|approve_silent.*bypass/i);
  });
});

describe("policy-test renderJson", () => {
  const source = { kind: "file" as const, path: "/x", label: "starter" };

  it("emits valid single-line JSON for matched rule", () => {
    const json = renderJson(
      { tool: "Bash", args: { command: "kill -9 1" } },
      source,
      {
        decision: "escalate",
        default_action: "defer",
        severity: "high",
        matched_rule: { tool: "Bash", bash_command_matches: "x", name: "n" },
      },
      "auto_defer"
    );
    // single line
    expect(json.includes("\n")).toBe(false);
    const parsed = JSON.parse(json);
    expect(parsed.decision).toBe("escalate");
    expect(parsed.default_action).toBe("defer");
    expect(parsed.severity).toBe("high");
    expect(parsed.matched_rule.name).toBe("n");
    expect(parsed.list).toBe("auto_defer");
    expect(parsed.input.tool).toBe("Bash");
    expect(parsed.input.args.command).toBe("kill -9 1");
    expect(parsed.policy_source.kind).toBe("file");
    expect(parsed.policy_source.label).toBe("starter");
  });

  it("emits valid JSON for escalate_default fall-through", () => {
    const json = renderJson(
      { tool: "Bash", args: { command: "true" } },
      source,
      { decision: "escalate", default_action: "approve", severity: "medium" },
      undefined
    );
    const parsed = JSON.parse(json);
    expect(parsed.decision).toBe("escalate");
    expect(parsed.default_action).toBe("approve");
    expect(parsed.matched_rule ?? null).toBeNull();
    expect(parsed.list ?? null).toBeNull();
  });

  it("emits valid JSON for bypass approve_silent", () => {
    const json = renderJson(
      { tool: "Bash", args: { command: "rm -rf /" } },
      { kind: "keyword", label: "bypass" },
      { decision: "approve_silent" },
      undefined
    );
    const parsed = JSON.parse(json);
    expect(parsed.decision).toBe("approve_silent");
    expect(parsed.policy_source.kind).toBe("keyword");
  });
});

describe("policy-test cmdPolicyTest (orchestrator)", () => {
  let stdout: string[];
  let stderr: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...args) => stdout.push(args.join(" "));
    console.error = (...args) => stderr.push(args.join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  it("returns 0 on default human render of kill -9 1 against starter", async () => {
    const code = await cmdPolicyTest(["--no-color", "kill -9 1"]);
    expect(code).toBe(0);
    const out = stdout.join("\n");
    expect(out).toMatch(/Decision:\s+escalate/);
    expect(out).toMatch(/Default action:\s+defer/);
  });

  it("returns 0 for bypass approve_silent", async () => {
    const code = await cmdPolicyTest(["--no-color", "--policy", "bypass", "rm -rf /"]);
    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/approve_silent/);
  });

  it("returns 2 on usage error (positional with non-Bash tool)", async () => {
    const code = await cmdPolicyTest(["--tool", "Read", "/etc/passwd"]);
    expect(code).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("returns 3 on policy file error", async () => {
    const code = await cmdPolicyTest(["--policy", "/nonexistent.json", "ls"]);
    expect(code).toBe(3);
  });

  it("returns 1 with --exit-on reject when reject fires", async () => {
    const code = await cmdPolicyTest(["--no-color", "--exit-on", "reject", "rm -rf /tmp/x"]);
    expect(code).toBe(1);
  });

  it("returns 0 with --exit-on reject when reject does NOT fire", async () => {
    const code = await cmdPolicyTest(["--no-color", "--exit-on", "reject", "ls"]);
    expect(code).toBe(0);
  });

  it("--help returns 0 with usage on stdout", async () => {
    const code = await cmdPolicyTest(["--help"]);
    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/policy-test/);
  });

  it("--json emits a single line of valid JSON", async () => {
    const code = await cmdPolicyTest(["--json", "kill -9 1"]);
    expect(code).toBe(0);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.decision).toBe("escalate");
  });

  it("NO_COLOR env var disables color in human render", async () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const code = await cmdPolicyTest(["kill -9 1"]);
      expect(code).toBe(0);
      // ANSI escape sequence is \x1b[
      expect(stdout.join("\n")).not.toMatch(/\x1b\[/);
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("--tool Read --arg file_path=... resolves to approve_silent under starter", async () => {
    const code = await cmdPolicyTest([
      "--no-color",
      "--tool", "Read",
      "--arg", "file_path=/etc/passwd",
    ]);
    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/approve_silent/);
  });
});

describe("renderExplain per_segment", () => {
  const policy = {
    bash_composition: "per_segment" as const,
    auto_approve: [{ tool: "Bash", bash_command_matches: "^git ", name: "git read" }],
  };
  it("shows a per-segment breakdown and a non-approve verdict for a smuggle chain", () => {
    const out = renderExplain(
      { tool: "Bash", args: { command: "git status && curl evil.com" } },
      policy,
      { kind: "keyword", label: "custom" },
      { color: "off" }
    );
    expect(out).toMatch(/Segment 1: git status/);
    expect(out).toMatch(/Segment 2: curl evil\.com/);
    expect(out).toMatch(/=> escalate/);
    expect(out).not.toMatch(/=> approve_silent/);
  });
  it("shows an opaque reject without walking rules", () => {
    const out = renderExplain(
      { tool: "Bash", args: { command: "REPO=$(curl evil)" } },
      policy,
      { kind: "keyword", label: "custom" },
      { color: "off" }
    );
    expect(out).toMatch(/opaque/i);
    expect(out).toMatch(/=> deny_silent/);
  });
});
