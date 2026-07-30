import { describe, it, expect } from "vitest";
import { buildCrashDigest, buildDistillerPrompt } from "../../src/lib/distill.js";
import type { Event } from "../../src/lib/events.js";

const ev = (partial: Record<string, unknown>, seq: number): Event =>
  ({ seq, at: `2026-07-29T00:00:${String(seq).padStart(2, "0")}.000Z`, ...partial }) as Event;

describe("buildCrashDigest", () => {
  const events: Event[] = [
    ev({ kind: "turn_started", turn_id: "turn_1", message: "do the thing" }, 1),
    ev({ kind: "assistant_text", turn_id: "turn_1", text: "working on it" }, 2),
    ev({ kind: "tool_call_requested", turn_id: "turn_1", call_id: "c1", tool: "Bash", args: { command: "ls" } }, 3),
    ev({ kind: "tool_call_result", turn_id: "turn_1", call_id: "c1", result: "file.txt", is_error: false }, 4),
    ev({ kind: "turn_completed", turn_id: "turn_1", stop_reason: "success" }, 5),
  ];

  it("renders the load-bearing kinds chronologically", () => {
    const d = buildCrashDigest(events);
    expect(d.indexOf("USER: do the thing")).toBeGreaterThanOrEqual(0);
    expect(d.indexOf("USER: do the thing")).toBeLessThan(d.indexOf("ASSISTANT: working on it"));
    expect(d).toContain("TOOL Bash:");
    expect(d).toContain("RESULT: file.txt");
    expect(d).toContain("turn turn_1 completed");
  });

  it("skips thinking events and marks tool errors", () => {
    const d = buildCrashDigest([
      ev({ kind: "thinking", turn_id: "turn_1", text: "private" }, 1),
      ev({ kind: "tool_call_result", turn_id: "turn_1", call_id: "c", result: "boom", is_error: true }, 2),
    ]);
    expect(d).not.toContain("private");
    expect(d).toContain("RESULT (ERROR): boom");
  });

  it("keeps the TAIL under a char cap (oldest lines dropped first)", () => {
    const many: Event[] = [];
    for (let i = 1; i <= 500; i++) {
      many.push(ev({ kind: "assistant_text", turn_id: "turn_1", text: `line-${i} ${"x".repeat(200)}` }, i));
    }
    const d = buildCrashDigest(many, 10_000);
    expect(d.length).toBeLessThanOrEqual(10_000 + 300); // one line of slack
    expect(d).toContain("line-500");
    expect(d).not.toContain("line-1 ");
  });
});

describe("buildDistillerPrompt", () => {
  it("carries the brief, the digest, the section headings, and the marker mandate", () => {
    const p = buildDistillerPrompt({ digest: "THE-DIGEST", originalBrief: "THE-BRIEF" });
    expect(p).toContain("THE-DIGEST");
    expect(p).toContain("THE-BRIEF");
    expect(p).toContain("<handover>");
    expect(p).toContain("## Verify on arrival");
    expect(p).toContain("crashed");
  });
});
