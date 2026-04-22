import { describe, it, expect } from "vitest";
import { shouldEmit } from "../../src/cli/commands/watch.js";
import type { Event } from "../../src/lib/events.js";

function ev(partial: Partial<Event>): Event {
  return { seq: 1, at: "2026-04-22T00:00:00Z", ...(partial as any) } as Event;
}

describe("watch filter predicate", () => {
  it("emits tool_decision_required", () => {
    expect(
      shouldEmit(ev({ kind: "tool_decision_required", turn_id: "t1", call_id: "c", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any))
    ).toBe(true);
  });

  it("emits tool_decision_resolved only when resolved_by is timeout", () => {
    expect(shouldEmit(ev({ kind: "tool_decision_resolved", resolved_by: "timeout" } as any))).toBe(true);
    expect(shouldEmit(ev({ kind: "tool_decision_resolved", resolved_by: "policy" } as any))).toBe(false);
    expect(shouldEmit(ev({ kind: "tool_decision_resolved", resolved_by: "user_mcp" } as any))).toBe(false);
    expect(shouldEmit(ev({ kind: "tool_decision_resolved", resolved_by: "user_mcp_auto" } as any))).toBe(false);
  });

  it("emits tool_output_provided / turn_completed / turn_failed / session_stopped / error", () => {
    for (const kind of ["tool_output_provided", "turn_completed", "turn_failed", "session_stopped", "error"] as const) {
      expect(shouldEmit(ev({ kind } as any))).toBe(true);
    }
  });

  it("emits tool_call_result only on error", () => {
    expect(shouldEmit(ev({ kind: "tool_call_result", is_error: true } as any))).toBe(true);
    expect(shouldEmit(ev({ kind: "tool_call_result", is_error: false } as any))).toBe(false);
  });

  it("drops noise", () => {
    for (const kind of ["session_started", "turn_started", "assistant_text", "thinking", "tool_call_requested", "tool_call_started"] as const) {
      expect(shouldEmit(ev({ kind } as any))).toBe(false);
    }
  });
});
