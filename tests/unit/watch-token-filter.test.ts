import { describe, it, expect } from "vitest";
import {
  tokenFilter,
  detectSuspectedNeedsInput,
  decideWatchEmit,
  SUSPECTED_NEEDS_INPUT_SIGNAL,
} from "../../src/cli/commands/watch.js";
import type { Event } from "../../src/lib/events.js";

function ev(partial: Partial<Event>): Event {
  return { seq: 1, at: "2026-04-27T12:00:00Z", ...(partial as any) } as Event;
}

function turnCompleted(turn_id: string, seq: number): Event {
  return ev({ seq, kind: "turn_completed", turn_id, stop_reason: "success" } as any);
}

function assistantText(turn_id: string, text: string, seq: number): Event {
  return ev({ seq, kind: "assistant_text", turn_id, text } as any);
}

describe("tokenFilter — non-turn_completed kinds bypass", () => {
  it("tool_decision_required passes regardless of token state", () => {
    const e = ev({ kind: "tool_decision_required", turn_id: "t1", call_id: "c", tool: "Bash", args: {}, severity: "high", default_action: "defer", default_at: "" } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });

  it("turn_failed passes regardless", () => {
    const e = ev({ kind: "turn_failed", turn_id: "t1", error: "x" } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });

  it("error passes regardless", () => {
    const e = ev({ kind: "error", message: "x", recoverable: false } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });

  it("tool_call_result passes regardless", () => {
    const e = ev({ kind: "tool_call_result", turn_id: "t1", call_id: "c", result: "x", is_error: true } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });

  it("session_stopped passes regardless", () => {
    const e = ev({ kind: "session_stopped", reason: "x", exit_code: 0 } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });

  it("tool_output_provided passes regardless", () => {
    const e = ev({ kind: "tool_output_provided", turn_id: "t1", call_id: "c", stdout_len: 10, stderr_len: 0, exit_code: 0 } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });

  it("tool_decision_resolved passes regardless", () => {
    const e = ev({ kind: "tool_decision_resolved", turn_id: "t1", call_id: "c", action: "approve", reason: "ok", resolved_by: "timeout" } as any);
    expect(tokenFilter(e, [], false)).toBe(true);
  });
});

describe("tokenFilter — turn_completed with token", () => {
  it("emits when trailing token defaults to always-surface", () => {
    const events: Event[] = [
      assistantText("t1", "I'm done.\n[DONE]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, false)).toBe(true);
  });

  it("drops when no trailing token (autonomous turn)", () => {
    const events: Event[] = [
      assistantText("t1", "Just working.", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, false)).toBe(false);
  });

  it("drops when there's no preceding assistant_text", () => {
    const events: Event[] = [
      turnCompleted("t1", 1),
    ];
    expect(tokenFilter(events[0], events, false)).toBe(false);
  });

  it("uses ONLY assistant_text from the same turn (ignores other turns')", () => {
    const events: Event[] = [
      assistantText("t0", "old turn ended\n[NEEDS-INPUT]", 1),
      assistantText("t1", "new turn done quietly", 2),
      turnCompleted("t1", 3),
    ];
    expect(tokenFilter(events[2], events, false)).toBe(false);
  });

  it("uses the LAST assistant_text from the turn when there are multiple", () => {
    const events: Event[] = [
      assistantText("t1", "thinking aloud", 1),
      assistantText("t1", "final word\n[NEEDS-INPUT]", 2),
      turnCompleted("t1", 3),
    ];
    expect(tokenFilter(events[2], events, false)).toBe(true);
  });
});

describe("tokenFilter — --no-token-filter", () => {
  it("with noTokenFilter=true, turn_completed passes regardless of token", () => {
    const events: Event[] = [
      assistantText("t1", "step done\n[NEEDS-INPUT]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, true)).toBe(true);
  });

  it("with noTokenFilter=true, turn_completed without any token also passes", () => {
    const events: Event[] = [
      assistantText("t1", "just done", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, true)).toBe(true);
  });
});

describe("tokenFilter — unknown tokens are silent", () => {
  it("unknown token resolves to silent and drops", () => {
    const events: Event[] = [
      assistantText("t1", "done\n[UNKNOWN-TOKEN]", 1),
      turnCompleted("t1", 2),
    ];
    expect(tokenFilter(events[1], events, false)).toBe(false);
  });
});

describe("detectSuspectedNeedsInput — CD-6 silent-miss backstop heuristic", () => {
  it("a no-token turn whose final line ends in '?' is suspected, with the trailing-? signal", () => {
    const events: Event[] = [
      assistantText("t1", "Found two configs.\nWhich environment should I deploy to?", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, true)).toEqual({
      suspected: true,
      signal: SUSPECTED_NEEDS_INPUT_SIGNAL,
    });
  });

  it("a no-token statement turn (final line not a question) is not suspected", () => {
    const events: Event[] = [
      assistantText("t1", "All migrations applied. Tests are green.", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, true).suspected).toBe(false);
  });

  it("ignores trailing blank/whitespace lines — tests the final NON-EMPTY line", () => {
    const events: Event[] = [
      assistantText("t1", "Ready to proceed?\n\n   \n", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, true).suspected).toBe(true);
  });

  it("a '?' that is not on the final non-empty line does not trigger", () => {
    const events: Event[] = [
      assistantText("t1", "Should I retry?\nI went ahead and retried; it worked.", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, true).suspected).toBe(false);
  });

  it("a tokened turn ([NEEDS-INPUT]) is never a backstop case", () => {
    const events: Event[] = [
      assistantText("t1", "Which path?\n[NEEDS-INPUT]", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, true).suspected).toBe(false);
  });

  it("a tokened turn ([DONE]) whose prior line is a question is never a backstop case", () => {
    const events: Event[] = [
      assistantText("t1", "Done. Anything else?\n[DONE]", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, true).suspected).toBe(false);
  });

  it("when disabled, a no-token '?' turn is not suspected", () => {
    const events: Event[] = [
      assistantText("t1", "Which environment should I deploy to?", 1),
      turnCompleted("t1", 2),
    ];
    expect(detectSuspectedNeedsInput(events[1], events, false).suspected).toBe(false);
  });

  it("non-turn_completed events are never suspected (even if their text ends in '?')", () => {
    const e = ev({ kind: "turn_failed", turn_id: "t1", error: "what now?" } as any);
    expect(detectSuspectedNeedsInput(e, [e], true).suspected).toBe(false);
  });

  it("a turn with no assistant_text is not suspected", () => {
    const events: Event[] = [turnCompleted("t1", 1)];
    expect(detectSuspectedNeedsInput(events[0], events, true).suspected).toBe(false);
  });

  it("uses ONLY the same turn's last assistant_text (ignores other turns')", () => {
    const events: Event[] = [
      assistantText("t0", "Old turn — ready?", 1),
      assistantText("t1", "New turn finished cleanly.", 2),
      turnCompleted("t1", 3),
    ];
    expect(detectSuspectedNeedsInput(events[2], events, true).suspected).toBe(false);
  });
});

describe("decideWatchEmit — CD-6 surface decision + additive marker", () => {
  const opts = { noTokenFilter: false, suspectedNeedsInput: true };

  it("surfaces a no-token '?' turn with an additive suspected_needs_input marker + signal", () => {
    const events: Event[] = [
      assistantText("t1", "Which environment should I deploy to?", 1),
      turnCompleted("t1", 2),
    ];
    const d = decideWatchEmit(events[1], events, opts);
    expect(d.emit).toBe(true);
    const p = d.payload as any;
    expect(p.suspected_needs_input).toBe(true);
    expect(p.suspected_needs_input_signal).toBe(SUSPECTED_NEEDS_INPUT_SIGNAL);
  });

  it("the marker is additive — kind stays turn_completed, originals preserved, only two fields added", () => {
    const events: Event[] = [
      assistantText("t1", "Proceed?", 1),
      turnCompleted("t1", 2),
    ];
    const original = events[1] as any;
    const p = decideWatchEmit(events[1], events, opts).payload as any;
    expect(p.kind).toBe("turn_completed"); // no new event kind
    for (const k of Object.keys(original)) {
      expect(p[k]).toEqual(original[k]); // every original field carried through
    }
    const added = Object.keys(p).filter((k) => !(k in original));
    expect(added.sort()).toEqual([
      "suspected_needs_input",
      "suspected_needs_input_signal",
    ]);
  });

  it("drops a no-token statement turn (unchanged pre-backstop behaviour)", () => {
    const events: Event[] = [
      assistantText("t1", "All set. Nothing else to do.", 1),
      turnCompleted("t1", 2),
    ];
    expect(decideWatchEmit(events[1], events, opts).emit).toBe(false);
  });

  it("a [NEEDS-INPUT] turn surfaces unchanged, with NO suspected marker", () => {
    const events: Event[] = [
      assistantText("t1", "Which path?\n[NEEDS-INPUT]", 1),
      turnCompleted("t1", 2),
    ];
    const d = decideWatchEmit(events[1], events, opts);
    expect(d.emit).toBe(true);
    expect(d.payload).toBe(events[1]); // same object, untouched
    expect((d.payload as any).suspected_needs_input).toBeUndefined();
  });

  it("a [DONE] turn surfaces unchanged, with NO suspected marker", () => {
    const events: Event[] = [
      assistantText("t1", "Finished.\n[DONE]", 1),
      turnCompleted("t1", 2),
    ];
    const d = decideWatchEmit(events[1], events, opts);
    expect(d.emit).toBe(true);
    expect((d.payload as any).suspected_needs_input).toBeUndefined();
  });

  it("with the backstop disabled, a no-token '?' turn drops", () => {
    const events: Event[] = [
      assistantText("t1", "Which environment?", 1),
      turnCompleted("t1", 2),
    ];
    const d = decideWatchEmit(events[1], events, {
      noTokenFilter: false,
      suspectedNeedsInput: false,
    });
    expect(d.emit).toBe(false);
  });

  it("with --no-token-filter, a no-token '?' turn surfaces RAW (no suspected marker)", () => {
    const events: Event[] = [
      assistantText("t1", "Which environment?", 1),
      turnCompleted("t1", 2),
    ];
    const d = decideWatchEmit(events[1], events, {
      noTokenFilter: true,
      suspectedNeedsInput: true,
    });
    expect(d.emit).toBe(true);
    expect(d.payload).toBe(events[1]);
    expect((d.payload as any).suspected_needs_input).toBeUndefined();
  });
});
