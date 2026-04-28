import { describe, it, expect } from "vitest";
import { tokenFilter } from "../../src/cli/commands/watch.js";
import type { Event } from "../../src/lib/events.js";
import type { Policy } from "../../src/lib/policy.js";

function ev(partial: Partial<Event>): Event {
  return { seq: 1, at: "2026-04-27T12:00:00Z", ...(partial as any) } as Event;
}

const NULL_CLI = { surface: [], silence: [] };
const NULL_POLICY: Policy = "bypass";

function turnCompleted(turn_id: string, seq: number): Event {
  return ev({ seq, kind: "turn_completed", turn_id, stop_reason: "success" } as any);
}

function assistantText(turn_id: string, text: string, seq: number): Event {
  return ev({ seq, kind: "assistant_text", turn_id, text } as any);
}

describe("tokenFilter — non-turn_completed kinds bypass", () => {
  it("tool_decision_required passes regardless of token state", () => {
    const e = ev({ kind: "tool_decision_required", turn_id: "t1", call_id: "c", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("turn_failed passes regardless", () => {
    const e = ev({ kind: "turn_failed", turn_id: "t1", error: "x" } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("error passes regardless", () => {
    const e = ev({ kind: "error", message: "x", recoverable: false } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("tool_call_result passes regardless", () => {
    const e = ev({ kind: "tool_call_result", turn_id: "t1", call_id: "c", result: "x", is_error: true } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("session_stopped passes regardless", () => {
    const e = ev({ kind: "session_stopped", reason: "x", exit_code: 0 } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("tool_output_provided passes regardless", () => {
    const e = ev({ kind: "tool_output_provided", turn_id: "t1", call_id: "c", stdout_len: 10, stderr_len: 0, exit_code: 0 } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("tool_decision_resolved passes regardless", () => {
    const e = ev({ kind: "tool_decision_resolved", turn_id: "t1", call_id: "c", action: "approve", reason: "ok", resolved_by: "timeout" } as any);
    expect(tokenFilter(e, [], NULL_POLICY, NULL_CLI, false)).toBe(true);
  });
});

describe("tokenFilter — turn_completed with token", () => {
  it("emits when trailing token defaults to always-surface", () => {
    const events: Event[] = [
      assistantText("t1", "I'm done.\n[INFO-FINISHED]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, NULL_CLI, false)).toBe(true);
  });

  it("drops when trailing token defaults to silent", () => {
    const events: Event[] = [
      assistantText("t1", "Step 1 of 5 done.\n[INFO-PROGRESS]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, NULL_CLI, false)).toBe(false);
  });

  it("drops when no trailing token (autonomous turn)", () => {
    const events: Event[] = [
      assistantText("t1", "Just working.", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, NULL_CLI, false)).toBe(false);
  });

  it("drops when there's no preceding assistant_text", () => {
    const events: Event[] = [
      turnCompleted("t1", 1),
    ];
    expect(tokenFilter(events[0], events, NULL_POLICY, NULL_CLI, false)).toBe(false);
  });

  it("uses ONLY assistant_text from the same turn (ignores other turns')", () => {
    const events: Event[] = [
      assistantText("t0", "old turn ended\n[NEEDS-INPUT]", 1),
      assistantText("t1", "new turn done quietly", 2),
      turnCompleted("t1", 3),
    ];
    expect(tokenFilter(events[2], events, NULL_POLICY, NULL_CLI, false)).toBe(false);
  });

  it("uses the LAST assistant_text from the turn when there are multiple", () => {
    const events: Event[] = [
      assistantText("t1", "thinking aloud", 1),
      assistantText("t1", "final word\n[NEEDS-INPUT]", 2),
      turnCompleted("t1", 3),
    ];
    expect(tokenFilter(events[2], events, NULL_POLICY, NULL_CLI, false)).toBe(true);
  });
});

describe("tokenFilter — CLI overrides", () => {
  it("--surface forces always for a normally-silent token", () => {
    const events: Event[] = [
      assistantText("t1", "step 2 done\n[INFO-PROGRESS]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, { surface: ["INFO-PROGRESS"], silence: [] }, false)).toBe(true);
  });

  it("--silence forces silent for a normally-loud token", () => {
    const events: Event[] = [
      assistantText("t1", "done\n[INFO-FINISHED]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, { surface: [], silence: ["INFO-FINISHED"] }, false)).toBe(false);
  });
});

describe("tokenFilter — policy.surface_tokens", () => {
  it("policy override wins over default for FAILED-WILL-RETRY", () => {
    const policy: Policy = {
      surface_tokens: { "FAILED-WILL-RETRY": "always" },
    };
    const events: Event[] = [
      assistantText("t1", "trying again\n[FAILED-WILL-RETRY]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, policy, NULL_CLI, false)).toBe(true);
  });

  it("policy override silences a normally-loud token", () => {
    const policy: Policy = {
      surface_tokens: { "INFO-CHECKPOINT": "silent" },
    };
    const events: Event[] = [
      assistantText("t1", "milestone\n[INFO-CHECKPOINT]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, policy, NULL_CLI, false)).toBe(false);
  });

  it("CLI overrides policy", () => {
    const policy: Policy = {
      surface_tokens: { "INFO-FINISHED": "silent" },
    };
    const events: Event[] = [
      assistantText("t1", "done\n[INFO-FINISHED]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, policy, { surface: ["INFO-FINISHED"], silence: [] }, false)).toBe(true);
  });
});

describe("tokenFilter — --no-token-filter", () => {
  it("with noTokenFilter=true, turn_completed passes regardless of token", () => {
    const events: Event[] = [
      assistantText("t1", "step done\n[INFO-PROGRESS]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, NULL_CLI, true)).toBe(true);
  });

  it("with noTokenFilter=true, turn_completed without any token also passes", () => {
    const events: Event[] = [
      assistantText("t1", "just done", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, NULL_POLICY, NULL_CLI, true)).toBe(true);
  });
});

describe("tokenFilter — bypass policy", () => {
  it("bypass policy resolves like an empty surface_tokens block (uses defaults)", () => {
    const events: Event[] = [
      assistantText("t1", "done\n[INFO-FINISHED]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, "bypass", NULL_CLI, false)).toBe(true);
  });

  it("bypass policy + silent default = drops", () => {
    const events: Event[] = [
      assistantText("t1", "step\n[INFO-PROGRESS]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, "bypass", NULL_CLI, false)).toBe(false);
  });
});
