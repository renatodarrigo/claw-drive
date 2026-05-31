import { describe, it, expect } from "vitest";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { lintPolicy, type Finding } from "../../src/lib/policy-lint.js";
import type { PolicyObject } from "../../src/lib/policy.js";

const codes = (f: Finding[]) => f.map((x) => x.code);

describe("lintPolicy — regex compile check (error)", () => {
  it("flags an uncompilable bash_command_matches as an error", () => {
    const p: PolicyObject = { auto_approve: [{ tool: "Bash", bash_command_matches: "[unclosed", name: "bad" }] };
    const f = lintPolicy(p);
    const err = f.find((x) => x.code === "regex_compile");
    expect(err).toBeDefined();
    expect(err!.severity).toBe("error");
    expect(err!.list).toBe("auto_approve");
    expect(err!.rule_index).toBe(0);
    expect(err!.rule_name).toBe("bad");
  });

  it("flags an uncompilable arg_matches value as an error", () => {
    const p: PolicyObject = { auto_reject: [{ tool: "Edit", arg_matches: { file_path: "(" }, name: "bad-arg" }] };
    const f = lintPolicy(p);
    expect(f.some((x) => x.code === "regex_compile" && x.severity === "error")).toBe(true);
  });
});

describe("lintPolicy — shadowed / unreachable check (warn)", () => {
  it("flags an auto_approve rule masked by a broader earlier auto_reject, naming both", () => {
    const p: PolicyObject = {
      auto_approve: [{ tool: "Bash", bash_command_matches: "^git status", name: "git status ok" }],
      auto_reject: [{ tool: "Bash", bash_command_matches: "^git ", name: "no git" }],
    };
    const f = lintPolicy(p);
    const shadow = f.find((x) => x.code === "shadowed_rule");
    expect(shadow).toBeDefined();
    expect(shadow!.severity).toBe("warn");
    expect(shadow!.list).toBe("auto_approve"); // the shadowed rule
    expect(shadow!.rule_name).toBe("git status ok");
    expect(shadow!.message).toContain("no git"); // names the shadowing rule
  });

  it("flags an identical rule shadowed within the same list", () => {
    const p: PolicyObject = {
      auto_approve: [
        { tool: "Bash", bash_command_matches: "^npm ", name: "npm first" },
        { tool: "Bash", bash_command_matches: "^npm ", name: "npm dup" },
      ],
    };
    const f = lintPolicy(p);
    const shadow = f.find((x) => x.code === "shadowed_rule");
    expect(shadow).toBeDefined();
    expect(shadow!.rule_name).toBe("npm dup");
  });
});

describe("lintPolicy — overly-broad heuristic (warn)", () => {
  it("flags a pattern that matches the empty string (matches every command)", () => {
    const p: PolicyObject = { auto_approve: [{ tool: "Bash", bash_command_matches: ".*", name: "everything" }] };
    const f = lintPolicy(p);
    expect(f.some((x) => x.code === "overly_broad" && x.severity === "warn")).toBe(true);
  });

  it("flags a pattern that leads with a wildcard (.*-dominated)", () => {
    const p: PolicyObject = { auto_approve: [{ tool: "Bash", bash_command_matches: ".*foo", name: "wild" }] };
    const f = lintPolicy(p);
    expect(f.some((x) => x.code === "overly_broad" && x.severity === "warn")).toBe(true);
  });
});

describe("lintPolicy — known-false-positive shape (info)", () => {
  it("flags a write-shaped auto_reject rule that catches a read-intent backup as info", () => {
    const p: PolicyObject = {
      auto_reject: [{ tool: "Bash", bash_command_matches: "\\bcp\\s+[^|;&]*config\\.json", name: "no cp config" }],
    };
    const f = lintPolicy(p);
    const info = f.find((x) => x.code === "known_fp_read_shape");
    expect(info).toBeDefined();
    expect(info!.severity).toBe("info");
    expect(info!.rule_name).toBe("no cp config");
  });

  it("does NOT flag the policy-self-protection privilege rule (documented-accepted FP)", () => {
    const p: PolicyObject = {
      auto_reject: [
        { tool: "Bash", bash_command_matches: "(\\bcp\\s+)[^|;&]*?claw-drive-policy[^\\s/]*\\.json", name: "policy file write" },
      ],
    };
    const f = lintPolicy(p);
    expect(f.some((x) => x.code === "known_fp_read_shape")).toBe(false);
  });
});

describe("lintPolicy — clean policy + ordering", () => {
  it("returns an empty array for a structurally clean policy", () => {
    const p: PolicyObject = {
      auto_approve: [{ tool: "Read" }, { tool: "Bash", bash_command_matches: "^git status" }],
      auto_reject: [{ tool: "Bash", bash_command_matches: "\\brm -rf\\b" }],
      escalate_default: true,
    };
    expect(lintPolicy(p)).toEqual([]);
  });

  it("orders findings by severity (error, warn, info) deterministically", () => {
    const p: PolicyObject = {
      auto_approve: [
        { tool: "Bash", bash_command_matches: "[bad", name: "compile-error" }, // error
        { tool: "Bash", bash_command_matches: ".*", name: "broad" }, // warn
      ],
      auto_reject: [{ tool: "Bash", bash_command_matches: "\\bcp\\s+[^|;&]*config\\.json", name: "fp" }], // info
    };
    const f = lintPolicy(p);
    const sevs = f.map((x) => x.severity);
    const firstWarn = sevs.indexOf("warn");
    const firstInfo = sevs.indexOf("info");
    const lastError = sevs.lastIndexOf("error");
    expect(lastError).toBeLessThan(firstWarn);
    expect(firstWarn).toBeLessThan(firstInfo);
  });

  it("the coverage branch is a no-op by default (CD-29) — checkCoverage adds nothing here", () => {
    const p: PolicyObject = { auto_approve: [{ tool: "Read" }] };
    expect(lintPolicy(p, { checkCoverage: false })).toEqual(lintPolicy(p));
  });
});

describe("lintPolicy — both shipped templates lint clean (no findings)", () => {
  const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
  const load = (name: string): PolicyObject =>
    JSON.parse(fsSync.readFileSync(nodePath.resolve(__dirname, "..", "..", "templates", name), "utf-8"));

  for (const name of ["claw-drive-policy.json", "claw-drive-policy-permissive.json"]) {
    it(`${name} → zero findings (default checks)`, () => {
      const f = lintPolicy(load(name));
      expect(f, `unexpected findings: ${JSON.stringify(codes(f))}`).toEqual([]);
    });
  }
});
