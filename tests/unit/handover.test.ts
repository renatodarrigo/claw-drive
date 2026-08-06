import { describe, it, expect } from "vitest";
import {
  buildHandoverInstruction,
  extractHandover,
  composeSuccessorBrief,
} from "../../src/lib/handover.js";

describe("extractHandover", () => {
  it("extracts the body between markers, trimmed", () => {
    expect(extractHandover("preamble\n<handover>\n## Current objective\nfix X\n</handover>\ntrailing [DONE]")).toBe(
      "## Current objective\nfix X"
    );
  });
  it("takes the FIRST block when multiple appear", () => {
    expect(extractHandover("<handover>one</handover><handover>two</handover>")).toBe("one");
  });
  it("returns null when markers are absent or the body is empty", () => {
    expect(extractHandover("no markers here")).toBeNull();
    expect(extractHandover("<handover>   \n </handover>")).toBeNull();
  });
});

describe("buildHandoverInstruction", () => {
  it("mandates markers, no tools, no sentinel, compactness, and the 8 headings", () => {
    const t = buildHandoverInstruction({ attempt: 1 });
    expect(t).toContain("<handover>");
    expect(t).toContain("</handover>");
    expect(t).toContain("No tool calls");
    expect(t).toContain("sentinel token");
    expect(t).toContain("2,500");
    for (const h of [
      "## Current objective",
      "## Progress ledger",
      "## Decisions made",
      "## Dead ends and discovered constraints",
      "## Workspace state (believed)",
      "## Verify on arrival",
      "## Next steps",
      "## Pending human threads",
    ]) {
      expect(t).toContain(h);
    }
  });
  it("attempt 2 opens with the sterner retry preamble", () => {
    expect(buildHandoverInstruction({ attempt: 2 })).toContain("SECOND ATTEMPT");
    expect(buildHandoverInstruction({ attempt: 1 })).not.toContain("SECOND ATTEMPT");
  });
});

describe("composeSuccessorBrief", () => {
  const base = {
    originalBrief: "Refactor the frobnicator.\nKeep tests green.",
    handover: "## Current objective\nstep 3",
    generation: 2,
    maxGenerations: 10,
    predecessorId: "sess_old",
    predecessorEventsPath: "/home/u/.claw-drive/sessions/sess_old/events.jsonl",
  };

  it("embeds the original brief verbatim between mission markers", () => {
    const b = composeSuccessorBrief(base);
    expect(b).toContain("=== ORIGINAL MISSION (verbatim) ===\nRefactor the frobnicator.\nKeep tests green.\n=== END ORIGINAL MISSION ===");
  });
  it("carries generation, predecessor id, handover, and the guarded log pointer", () => {
    const b = composeSuccessorBrief(base);
    expect(b).toContain("generation 2 of 10");
    expect(b).toContain("sess_old");
    expect(b).toContain("## Current objective\nstep 3");
    expect(b).toContain(base.predecessorEventsPath);
    expect(b).toContain("only if the handover leaves you blocked");
  });
  it("adds the final-generation notice ONLY at N = M", () => {
    expect(composeSuccessorBrief({ ...base, generation: 10 })).toContain("FINAL GENERATION");
    expect(composeSuccessorBrief(base)).not.toContain("FINAL GENERATION");
  });
  it("keeps the final-generation notice on an overshoot (N > M, reachable via recover)", () => {
    expect(composeSuccessorBrief({ ...base, generation: 12 })).toContain("FINAL GENERATION");
  });
  it("renders an uncapped lineage without a cap number or notice", () => {
    const b = composeSuccessorBrief({ ...base, maxGenerations: 0, generation: 7 });
    expect(b).toContain("generation 7 (no generation cap)");
    expect(b).not.toContain("FINAL GENERATION");
  });
});
