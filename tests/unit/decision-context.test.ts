import { describe, it, expect } from "vitest";
import {
  buildDecisionContext,
  RATIONALE_CAP,
  DIFF_CAP,
} from "../../src/lib/decision-context.js";

describe("buildDecisionContext — rationale", () => {
  it("attaches the priorAssistantText verbatim when within the cap", () => {
    const ctx = buildDecisionContext({ tool: "Bash", args: { command: "ls" }, priorAssistantText: "why" });
    expect(ctx.rationale).toBe("why");
  });

  it("omits rationale when priorAssistantText is absent", () => {
    const ctx = buildDecisionContext({ tool: "Bash", args: { command: "ls" } });
    expect("rationale" in ctx).toBe(false);
  });

  it("omits rationale when priorAssistantText is empty", () => {
    const ctx = buildDecisionContext({ tool: "Bash", args: { command: "ls" }, priorAssistantText: "" });
    expect("rationale" in ctx).toBe(false);
  });

  it("head-truncates a long rationale to the cap plus a single marker", () => {
    const long = "z".repeat(RATIONALE_CAP + 500);
    const ctx = buildDecisionContext({ tool: "Bash", args: {}, priorAssistantText: long });
    expect(ctx.rationale!.startsWith("z".repeat(RATIONALE_CAP))).toBe(true);
    expect(ctx.rationale!.length).toBe(RATIONALE_CAP + 1); // 1000 chars + "…"
    expect(ctx.rationale!.endsWith("…")).toBe(true);
  });
});

describe("buildDecisionContext — diff", () => {
  it("Edit: unified diff of old_string -> new_string", () => {
    const ctx = buildDecisionContext({
      tool: "Edit",
      args: { file_path: "src/x.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      priorAssistantText: "why",
    });
    expect(ctx.rationale).toBe("why");
    expect(ctx.diff).toContain("--- a/src/x.ts");
    expect(ctx.diff).toContain("+++ b/src/x.ts");
    expect(ctx.diff).toContain("-const a = 1;");
    expect(ctx.diff).toContain("+const a = 2;");
  });

  it("Write without existing content: renders the content verbatim as the added body", () => {
    const ctx = buildDecisionContext({
      tool: "Write",
      args: { file_path: "new.txt", content: "line1\nline2" },
    });
    expect(ctx.diff).toContain("+line1");
    expect(ctx.diff).toContain("+line2");
    // nothing removed for a new file (exclude the `---` header line)
    const removed = ctx.diff!.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(removed).toEqual([]);
  });

  it("Write with existing content: unified diff against the existing file", () => {
    const ctx = buildDecisionContext({
      tool: "Write",
      args: { file_path: "x.txt", content: "new line" },
      existingFileContent: "old line",
    });
    expect(ctx.diff).toContain("-old line");
    expect(ctx.diff).toContain("+new line");
  });

  it("non-file tool yields no diff", () => {
    const ctx = buildDecisionContext({ tool: "Bash", args: { command: "ls" }, priorAssistantText: "why" });
    expect("diff" in ctx).toBe(false);
    expect(ctx.rationale).toBe("why");
  });

  it("Edit with missing/non-string relevant args yields no diff", () => {
    expect("diff" in buildDecisionContext({ tool: "Edit", args: { file_path: "x" } })).toBe(false);
    expect("diff" in buildDecisionContext({ tool: "Edit", args: { old_string: 1, new_string: 2 } })).toBe(false);
  });

  it("caps a large diff at DIFF_CAP with a marker and length <= cap", () => {
    const huge = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n");
    const ctx = buildDecisionContext({ tool: "Write", args: { file_path: "big.txt", content: huge } });
    expect(ctx.diff!.length).toBeLessThanOrEqual(DIFF_CAP);
    expect(ctx.diff!.endsWith("…")).toBe(true);
  });
});
