import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parseLintArgs, cmdPolicyLint, summarize } from "../../src/cli/commands/policy-lint.js";
import type { Finding } from "../../src/lib/policy-lint.js";

describe("parseLintArgs", () => {
  it("parses a positional file", () => {
    const r = parseLintArgs(["my.json"]);
    expect(r.ok && !r.help && r.file).toBe("my.json");
  });

  it("parses --json, --check-coverage, --max-severity, --no-color", () => {
    const r = parseLintArgs(["--json", "--check-coverage", "--max-severity", "warn", "--no-color", "f.json"]);
    expect(r.ok && !r.help).toBe(true);
    if (r.ok && !r.help) {
      expect(r.json).toBe(true);
      expect(r.checkCoverage).toBe(true);
      expect(r.maxSeverity).toBe("warn");
      expect(r.color).toBe("off");
      expect(r.file).toBe("f.json");
    }
  });

  it("rejects a bad --max-severity value", () => {
    const r = parseLintArgs(["--max-severity", "loud", "f.json"]);
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    expect(parseLintArgs(["--frobnicate", "f.json"]).ok).toBe(false);
  });

  it("rejects more than one positional", () => {
    expect(parseLintArgs(["a.json", "b.json"]).ok).toBe(false);
  });

  it("--help short-circuits", () => {
    const r = parseLintArgs(["--help"]);
    expect(r.ok && r.help).toBe(true);
  });
});

describe("summarize", () => {
  it("counts findings per severity", () => {
    const f: Finding[] = [
      { severity: "error", code: "a", message: "" },
      { severity: "warn", code: "b", message: "" },
      { severity: "warn", code: "c", message: "" },
    ];
    expect(summarize(f)).toEqual({ error: 1, warn: 2, info: 0 });
  });
});

describe("cmdPolicyLint", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const tmp: string[] = [];
  let counter = 0;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const p of tmp.splice(0)) {
      try { fs.rmSync(p); } catch { /* */ }
    }
  });

  const out = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  function writePolicy(obj: unknown): string {
    const p = nodePath.join(os.tmpdir(), `cd5-lint-${counter++}.json`);
    fs.writeFileSync(p, JSON.stringify(obj));
    tmp.push(p);
    return p;
  }

  it("lints both shipped templates clean — exit 0, no findings", async () => {
    for (const spec of ["starter", "permissive"]) {
      const code = await cmdPolicyLint([spec, "--no-color"]);
      expect(code, spec).toBe(0);
      expect(out(), spec).toContain("No findings");
      logSpy.mockClear();
    }
  });

  it("reports an overly-broad finding in human output", async () => {
    const file = writePolicy({ auto_approve: [{ tool: "Bash", bash_command_matches: ".*", name: "broad" }] });
    const code = await cmdPolicyLint([file, "--no-color"]);
    expect(code).toBe(0); // report-only without --max-severity
    expect(out()).toContain("overly_broad");
    expect(out()).toContain("warning");
  });

  it("--json emits a structured object with findings + summary", async () => {
    const file = writePolicy({ auto_approve: [{ tool: "Bash", bash_command_matches: ".*", name: "broad" }] });
    const code = await cmdPolicyLint(["--json", file]);
    expect(code).toBe(0);
    const obj = JSON.parse(out());
    expect(obj.summary).toEqual({ error: 0, warn: 1, info: 0 });
    expect(obj.findings[0].code).toBe("overly_broad");
    expect(obj.file).toContain(file);
  });

  it("--max-severity warn exits 1 when a warn finding is present", async () => {
    const file = writePolicy({ auto_approve: [{ tool: "Bash", bash_command_matches: ".*" }] });
    expect(await cmdPolicyLint([file, "--max-severity", "warn", "--no-color"])).toBe(1);
  });

  it("--max-severity error exits 0 for a warn-only policy", async () => {
    const file = writePolicy({ auto_approve: [{ tool: "Bash", bash_command_matches: ".*" }] });
    expect(await cmdPolicyLint([file, "--max-severity", "error", "--no-color"])).toBe(0);
  });

  it("--max-severity error exits 1 for an error finding (arg_matches bad regex)", async () => {
    const file = writePolicy({ auto_reject: [{ tool: "Edit", arg_matches: { file_path: "(" } }] });
    expect(await cmdPolicyLint([file, "--max-severity", "error", "--no-color"])).toBe(1);
  });

  it("omitting --max-severity always exits 0 even with findings", async () => {
    const file = writePolicy({ auto_reject: [{ tool: "Edit", arg_matches: { file_path: "(" } }] });
    expect(await cmdPolicyLint([file, "--no-color"])).toBe(0);
  });

  it("an unreadable file exits non-zero with a clear message", async () => {
    const code = await cmdPolicyLint(["/no/such/policy-file.json"]);
    expect(code).not.toBe(0);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/cannot read|ENOENT|no such/i);
  });

  it("missing file argument exits 2 with usage", async () => {
    expect(await cmdPolicyLint([])).toBe(2);
  });
});
