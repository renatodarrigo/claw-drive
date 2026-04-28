import { describe, it, expect } from "vitest";
import {
  shouldEmit,
  catchUpPending,
  userFilter,
  DECISION_ONLY_KINDS,
  VALID_WATCH_KINDS,
} from "../../src/cli/commands/watch.js";
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

describe("catchUpPending", () => {
  it("empty history → empty catch-up", () => {
    expect(catchUpPending([])).toEqual([]);
  });

  it("emits unresolved tool_decision_required", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "turn_1", message: "go" } as any),
      ev({ seq: 2, kind: "tool_decision_required", turn_id: "turn_1", call_id: "c_open", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any),
    ];
    const out = catchUpPending(events);
    expect(out).toHaveLength(1);
    expect((out[0] as any).call_id).toBe("c_open");
  });

  it("skips tool_decision_required that has a matching tool_decision_resolved", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "tool_decision_required", turn_id: "turn_1", call_id: "c_done", tool: "Bash", args: {}, severity: "high", default_action: "approve", default_at: "" } as any),
      ev({ seq: 2, kind: "tool_decision_resolved", turn_id: "turn_1", call_id: "c_done", action: "approve", reason: "ok", resolved_by: "user_mcp" } as any),
    ];
    expect(catchUpPending(events)).toEqual([]);
  });

  it("mix: emits only unresolved", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "tool_decision_required", turn_id: "turn_1", call_id: "c_done", tool: "Bash", args: {}, severity: "high", default_action: "approve", default_at: "" } as any),
      ev({ seq: 2, kind: "tool_decision_resolved", turn_id: "turn_1", call_id: "c_done", action: "approve", reason: "ok", resolved_by: "user_mcp" } as any),
      ev({ seq: 3, kind: "tool_decision_required", turn_id: "turn_1", call_id: "c_open_1", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any),
      ev({ seq: 4, kind: "tool_decision_required", turn_id: "turn_2", call_id: "c_open_2", tool: "Read", args: {}, severity: "medium", default_action: "approve", default_at: "" } as any),
    ];
    const out = catchUpPending(events);
    expect(out.map((e) => (e as any).call_id)).toEqual(["c_open_1", "c_open_2"]);
  });

  it("emits session_stopped when present (tells driver to exit)", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "session_started", cwd: "/x", policy_digest: "p" } as any),
      ev({ seq: 2, kind: "session_stopped", reason: "stop_session", exit_code: 0 } as any),
    ];
    const out = catchUpPending(events);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("session_stopped");
  });

  it("ignores turn_completed / assistant_text / other noise", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "turn_1", message: "go" } as any),
      ev({ seq: 2, kind: "assistant_text", turn_id: "turn_1", text: "hi" } as any),
      ev({ seq: 3, kind: "turn_completed", turn_id: "turn_1", stop_reason: "success" } as any),
    ];
    expect(catchUpPending(events)).toEqual([]);
  });

  it("preserves original seq order of emitted events", () => {
    const events: Event[] = [
      ev({ seq: 10, kind: "tool_decision_required", turn_id: "t", call_id: "a", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any),
      ev({ seq: 5, kind: "tool_decision_required", turn_id: "t", call_id: "b", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any),
    ];
    // catchUpPending preserves array order (which is the order input arrives —
    // caller is responsible for passing events in seq order). Here we pass [10, 5]
    // deliberately and expect the same order back.
    const out = catchUpPending(events);
    expect(out.map((e) => (e as any).call_id)).toEqual(["a", "b"]);
  });
});

describe("userFilter", () => {
  it("null allowed → passes everything", () => {
    for (const kind of [...VALID_WATCH_KINDS]) {
      expect(userFilter(ev({ kind } as any), null)).toBe(true);
    }
  });

  it("empty allowed set → passes nothing", () => {
    const empty = new Set<string>();
    for (const kind of [...VALID_WATCH_KINDS]) {
      expect(userFilter(ev({ kind } as any), empty)).toBe(false);
    }
  });

  it("kind in allowed set → passes", () => {
    const allowed = new Set(["tool_decision_required", "turn_failed"]);
    expect(userFilter(ev({ kind: "tool_decision_required" } as any), allowed)).toBe(true);
    expect(userFilter(ev({ kind: "turn_failed" } as any), allowed)).toBe(true);
  });

  it("kind not in allowed set → drops", () => {
    const allowed = new Set(["tool_decision_required"]);
    expect(userFilter(ev({ kind: "turn_completed" } as any), allowed)).toBe(false);
    expect(userFilter(ev({ kind: "tool_output_provided" } as any), allowed)).toBe(false);
    expect(userFilter(ev({ kind: "session_stopped" } as any), allowed)).toBe(false);
  });
});

describe("DECISION_ONLY_KINDS preset", () => {
  it("includes the six human-attention kinds", () => {
    expect(DECISION_ONLY_KINDS.has("tool_decision_required")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("tool_decision_resolved")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("turn_failed")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("error")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("session_stopped")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("tool_call_result")).toBe(true);
  });

  it("excludes the two info-only kinds", () => {
    expect(DECISION_ONLY_KINDS.has("turn_completed")).toBe(false);
    expect(DECISION_ONLY_KINDS.has("tool_output_provided")).toBe(false);
  });

  it("has exactly 6 entries", () => {
    expect(DECISION_ONLY_KINDS.size).toBe(6);
  });
});

describe("VALID_WATCH_KINDS", () => {
  it("contains all 8 kinds shouldEmit can pass", () => {
    expect(VALID_WATCH_KINDS.has("tool_decision_required")).toBe(true);
    expect(VALID_WATCH_KINDS.has("tool_decision_resolved")).toBe(true);
    expect(VALID_WATCH_KINDS.has("tool_output_provided")).toBe(true);
    expect(VALID_WATCH_KINDS.has("turn_completed")).toBe(true);
    expect(VALID_WATCH_KINDS.has("turn_failed")).toBe(true);
    expect(VALID_WATCH_KINDS.has("error")).toBe(true);
    expect(VALID_WATCH_KINDS.has("session_stopped")).toBe(true);
    expect(VALID_WATCH_KINDS.has("tool_call_result")).toBe(true);
  });

  it("does not contain non-actionable kinds", () => {
    expect(VALID_WATCH_KINDS.has("session_started")).toBe(false);
    expect(VALID_WATCH_KINDS.has("turn_started")).toBe(false);
    expect(VALID_WATCH_KINDS.has("assistant_text")).toBe(false);
    expect(VALID_WATCH_KINDS.has("thinking")).toBe(false);
    expect(VALID_WATCH_KINDS.has("tool_call_requested")).toBe(false);
    expect(VALID_WATCH_KINDS.has("tool_call_started")).toBe(false);
  });

  it("has exactly 9 entries", () => {
    expect(VALID_WATCH_KINDS.size).toBe(9);
  });

  it("DECISION_ONLY_KINDS is a subset of VALID_WATCH_KINDS", () => {
    for (const k of [...DECISION_ONLY_KINDS]) {
      expect(VALID_WATCH_KINDS.has(k)).toBe(true);
    }
  });
});
