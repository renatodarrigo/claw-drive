import { describe, it, expect } from "vitest";
import {
  matchPolicy,
  deriveRuleFromResolved,
  validatePolicy,
  type Policy,
  type Rule,
} from "../../src/lib/policy.js";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

describe("matchPolicy", () => {
  it("bypass approves everything without decision events", () => {
    const r = matchPolicy("bypass", { tool: "Bash", args: { command: "rm -rf /" } });
    expect(r.decision).toBe("approve_silent");
  });

  it("auto_approve Read tool matches", () => {
    const p: Policy = { auto_approve: [{ tool: "Read" }] };
    const r = matchPolicy(p, { tool: "Read", args: { file_path: "/x" } });
    expect(r.decision).toBe("approve_silent");
    expect(r.matched_rule).toBeDefined();
  });

  it("auto_approve Bash with command regex matches", () => {
    const p: Policy = {
      auto_approve: [{ tool: "Bash", bash_command_matches: "^git (status|diff) " }],
    };
    const ok = matchPolicy(p, { tool: "Bash", args: { command: "git status -s" } });
    expect(ok.decision).toBe("approve_silent");
    const no = matchPolicy(p, { tool: "Bash", args: { command: "git push" } });
    expect(no.decision).toBe("escalate");
  });

  it("auto_approve beats auto_reject when both match", () => {
    const p: Policy = {
      auto_approve: [{ tool: "Bash", bash_command_matches: "^git status" }],
      auto_reject: [{ tool: "Bash", bash_command_matches: "^git " }],
    };
    const r = matchPolicy(p, { tool: "Bash", args: { command: "git status" } });
    expect(r.decision).toBe("approve_silent");
  });

  it("auto_reject triggers escalate with default reject", () => {
    const p: Policy = {
      auto_reject: [{ tool: "Bash", bash_command_matches: "rm -rf", severity: "high" }],
    };
    const r = matchPolicy(p, { tool: "Bash", args: { command: "rm -rf /tmp/x" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("reject");
      expect(r.severity).toBe("high");
    }
  });

  it("unmatched with escalate_default=false becomes deny_silent", () => {
    const p: Policy = { escalate_default: false };
    const r = matchPolicy(p, { tool: "Bash", args: { command: "whatever" } });
    expect(r.decision).toBe("deny_silent");
  });

  it("unmatched with escalate_default=true becomes escalate/approve-default", () => {
    const p: Policy = {};
    const r = matchPolicy(p, { tool: "Bash", args: { command: "whatever" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("approve");
      expect(r.severity).toBe("medium");
    }
  });

  it("regex tool via /pattern/ syntax", () => {
    const p: Policy = { auto_approve: [{ tool: "/^mcp__cloverleaf__/" }] };
    const r = matchPolicy(p, { tool: "mcp__cloverleaf__foo", args: {} });
    expect(r.decision).toBe("approve_silent");
  });

  it("arg_matches for non-Bash tools", () => {
    const p: Policy = {
      auto_approve: [{ tool: "Write", arg_matches: { file_path: "^/tmp/" } }],
    };
    const ok = matchPolicy(p, { tool: "Write", args: { file_path: "/tmp/x", content: "y" } });
    expect(ok.decision).toBe("approve_silent");
    const no = matchPolicy(p, { tool: "Write", args: { file_path: "/etc/x", content: "y" } });
    expect(no.decision).toBe("escalate");
  });

  it("auto_defer matches before auto_reject when both would match", () => {
    const p: Policy = {
      auto_defer: [{ tool: "Bash", bash_command_matches: "^sudo " }],
      auto_reject: [{ tool: "Bash", bash_command_matches: "sudo" }],
    };
    const r = matchPolicy(p, { tool: "Bash", args: { command: "sudo apt install foo" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("defer");
      expect(r.severity).toBe("high");
    }
  });

  it("auto_approve wins over auto_defer", () => {
    const p: Policy = {
      auto_approve: [{ tool: "Bash", bash_command_matches: "^sudo -n true$" }],
      auto_defer: [{ tool: "Bash", bash_command_matches: "^sudo " }],
    };
    const r = matchPolicy(p, { tool: "Bash", args: { command: "sudo -n true" } });
    expect(r.decision).toBe("approve_silent");
  });

  it("auto_defer with custom severity is honored", () => {
    const p: Policy = {
      auto_defer: [{ tool: "Bash", bash_command_matches: "^echo 'CLAW-GATE:", severity: "medium" }],
    };
    const r = matchPolicy(p, { tool: "Bash", args: { command: "echo 'CLAW-GATE: review please'" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("defer");
      expect(r.severity).toBe("medium");
    }
  });
});

describe("deriveRuleFromResolved", () => {
  it("Bash rule extracts first token + anchors", () => {
    const rule = deriveRuleFromResolved("approve", "Bash", { command: "pytest tests/foo" });
    expect(rule).toEqual({
      tool: "Bash",
      bash_command_matches: "^pytest ",
      name: "remembered: approve pytest",
    });
  });

  it("non-Bash rule has no arg_matches", () => {
    const rule = deriveRuleFromResolved("approve", "Read", { file_path: "/x" });
    expect(rule).toEqual({ tool: "Read", name: "remembered: approve Read" });
  });
});

describe("validatePolicy", () => {
  it("bypass string is valid", () => {
    expect(validatePolicy("bypass")).toEqual({ ok: true });
  });

  it("object with well-formed rules is valid", () => {
    const p: Policy = { auto_approve: [{ tool: "Read" }] };
    expect(validatePolicy(p)).toEqual({ ok: true });
  });

  it("unknown top-level key is rejected", () => {
    const r = validatePolicy({ typo_key: 1 } as any);
    expect(r.ok).toBe(false);
  });

  it("rule missing tool is rejected", () => {
    const r = validatePolicy({ auto_approve: [{} as any] });
    expect(r.ok).toBe(false);
  });

  it("invalid regex in bash_command_matches is rejected", () => {
    const r = validatePolicy({
      auto_approve: [{ tool: "Bash", bash_command_matches: "[unclosed" }],
    });
    expect(r.ok).toBe(false);
  });

  it("auto_defer is a valid top-level key", () => {
    expect(validatePolicy({ auto_defer: [{ tool: "Bash", bash_command_matches: "^sudo " }] })).toEqual({ ok: true });
  });

  it("invalid regex in auto_defer is rejected", () => {
    const r = validatePolicy({ auto_defer: [{ tool: "Bash", bash_command_matches: "[bad" }] });
    expect(r.ok).toBe(false);
  });
});

describe("permissive policy template", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = nodePath.dirname(__filename);
  const templatePath = nodePath.resolve(__dirname, "..", "..", "templates", "claw-drive-policy-permissive.json");
  const policy: Policy = JSON.parse(fsSync.readFileSync(templatePath, "utf-8"));

  it("validates without errors", () => {
    const v = validatePolicy(policy);
    expect(v.ok).toBe(true);
  });

  it("auto-approves common read/inspect CLIs", () => {
    for (const command of ["rg foo src/", "sed -n '1,10p' file", "awk '{print $1}' file", "jq .foo data.json", "diff a b"]) {
      const r = matchPolicy(policy, { tool: "Bash", args: { command } });
      expect(r.decision, `cmd: ${command}`).toBe("approve_silent");
    }
  });

  it("auto-approves common non-destructive file ops", () => {
    for (const command of ["mkdir -p x/y/z", "touch foo", "cp src dest", "mv a b"]) {
      const r = matchPolicy(policy, { tool: "Bash", args: { command } });
      expect(r.decision, `cmd: ${command}`).toBe("approve_silent");
    }
  });

  it("auto-approves common safe git ops", () => {
    for (const command of ["git fetch origin", "git pull --ff-only origin main", "git rebase --abort"]) {
      const r = matchPolicy(policy, { tool: "Bash", args: { command } });
      expect(r.decision, `cmd: ${command}`).toBe("approve_silent");
    }
  });

  it("auto-approves common path/env introspection", () => {
    for (const command of ["which node", "env", "realpath foo"]) {
      const r = matchPolicy(policy, { tool: "Bash", args: { command } });
      expect(r.decision, `cmd: ${command}`).toBe("approve_silent");
    }
  });

  it("does NOT auto-approve cp -r (stays under escalation)", () => {
    const r = matchPolicy(policy, { tool: "Bash", args: { command: "cp -r src dest" } });
    expect(r.decision).not.toBe("approve_silent");
  });

  it("still auto-rejects destructive commands", () => {
    const r = matchPolicy(policy, { tool: "Bash", args: { command: "rm -rf foo" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("reject");
    }
  });

  it("still auto-rejects git push", () => {
    const r = matchPolicy(policy, { tool: "Bash", args: { command: "git push origin main" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("reject");
    }
  });

  it("still auto-defers sudo", () => {
    const r = matchPolicy(policy, { tool: "Bash", args: { command: "sudo apt update" } });
    expect(r.decision).toBe("escalate");
    if (r.decision === "escalate") {
      expect(r.default_action).toBe("defer");
    }
  });
});
