import { describe, it, expect } from "vitest";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { lintPolicy } from "../../src/lib/policy-lint.js";
import type { PolicyObject } from "../../src/lib/policy.js";

// Covers git push, dd, mkfs, and the interpreter-escape family (node -e) — but
// NOT rm -rf. Otherwise structurally clean (no regex/shadow/broad/FP findings).
const MISSING_RM: PolicyObject = {
  auto_reject: [
    { tool: "Bash", bash_command_matches: "\\bgit push\\b" },
    { tool: "Bash", bash_command_matches: "\\bdd if=" },
    { tool: "Bash", bash_command_matches: "\\bmkfs\\b" },
  ],
  auto_defer: [{ tool: "Bash", bash_command_matches: "\\bnode\\s+(--eval|--print|-[a-zA-Z]*[ep])\\b" }],
  escalate_default: true,
};

describe("lintPolicy --check-coverage (CD-31)", () => {
  it("reports an advisory finding for an uncovered family only when checkCoverage is set", () => {
    const cov = lintPolicy(MISSING_RM, { checkCoverage: true }).filter((f) => f.code === "missing_coverage");
    expect(cov.length).toBe(1);
    expect(cov[0].severity).toBe("info");
    expect(cov[0].message).toMatch(/rm -rf/);
  });

  it("produces no coverage findings when checkCoverage is off (default)", () => {
    expect(lintPolicy(MISSING_RM).some((f) => f.code === "missing_coverage")).toBe(false);
    expect(lintPolicy(MISSING_RM, { checkCoverage: false }).some((f) => f.code === "missing_coverage")).toBe(false);
  });

  it("a policy that rejects/defers every tracked family produces no coverage findings even with the flag", () => {
    const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
    const starter: PolicyObject = JSON.parse(
      fsSync.readFileSync(nodePath.resolve(__dirname, "..", "..", "templates", "claw-drive-policy.json"), "utf-8")
    );
    const cov = lintPolicy(starter, { checkCoverage: true }).filter((f) => f.code === "missing_coverage");
    expect(cov).toEqual([]);
  });

  it("reports every tracked family for an empty-rules policy", () => {
    const cov = lintPolicy({ escalate_default: true }, { checkCoverage: true }).filter(
      (f) => f.code === "missing_coverage"
    );
    expect(cov.length).toBe(5); // rm -rf, git push, dd, mkfs, interpreter escapes
  });
});
