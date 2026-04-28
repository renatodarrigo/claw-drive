import { describe, it, expect } from "vitest";
import {
  newIdleState,
  noteSurface,
  cancelIdle,
  shouldFireIdle,
  deriveCurrentTurn,
} from "../../src/cli/commands/watch.js";
import type { Event } from "../../src/lib/events.js";

describe("idle state machine", () => {
  describe("newIdleState", () => {
    it("converts seconds to ms", () => {
      const s = newIdleState(600, 1000);
      expect(s.thresholdMs).toBe(600_000);
    });

    it("starts un-cancelled", () => {
      const s = newIdleState(600, 1000);
      expect(s.cancelled).toBe(false);
    });

    it("seeds lastSurfaceMs to the provided start time", () => {
      const s = newIdleState(600, 12345);
      expect(s.lastSurfaceMs).toBe(12345);
    });
  });

  describe("shouldFireIdle", () => {
    it("returns false before threshold elapses", () => {
      const s = newIdleState(600, 0);
      expect(shouldFireIdle(s, 599_999)).toBe(false);
    });

    it("returns true exactly at threshold", () => {
      const s = newIdleState(600, 0);
      expect(shouldFireIdle(s, 600_000)).toBe(true);
    });

    it("returns true past threshold", () => {
      const s = newIdleState(600, 0);
      expect(shouldFireIdle(s, 1_200_000)).toBe(true);
    });

    it("returns false when threshold is 0 (disabled)", () => {
      const s = newIdleState(0, 0);
      expect(shouldFireIdle(s, 600_000_000)).toBe(false);
    });

    it("returns false after cancellation, even past threshold", () => {
      const s = newIdleState(600, 0);
      cancelIdle(s);
      expect(shouldFireIdle(s, 600_000)).toBe(false);
    });
  });

  describe("noteSurface", () => {
    it("resets the silence window", () => {
      const s = newIdleState(600, 0);
      // 500s into silence
      expect(shouldFireIdle(s, 500_000)).toBe(false);
      // event arrives at 500s, resetting the window
      noteSurface(s, 500_000);
      // now we need another 600s from this point — at 1099_999 not yet
      expect(shouldFireIdle(s, 1_099_999)).toBe(false);
      // at 1100_000 (= 500_000 + 600_000) — fire
      expect(shouldFireIdle(s, 1_100_000)).toBe(true);
    });
  });

  describe("cancelIdle", () => {
    it("disables future firings permanently", () => {
      const s = newIdleState(600, 0);
      cancelIdle(s);
      expect(shouldFireIdle(s, 600_000)).toBe(false);
      expect(shouldFireIdle(s, 6_000_000)).toBe(false);
    });
  });
});

describe("deriveCurrentTurn", () => {
  function ev(seq: number, kind: string, turnId?: string): Event {
    return { seq, at: "2026-01-01T00:00:00Z", kind, turn_id: turnId } as unknown as Event;
  }

  it("returns null on empty history", () => {
    expect(deriveCurrentTurn([])).toBe(null);
  });

  it("returns null when no turn_started has been seen", () => {
    const events = [ev(1, "session_started"), ev(2, "tool_decision_required")];
    expect(deriveCurrentTurn(events)).toBe(null);
  });

  it("returns turn_id of the active turn", () => {
    const events = [
      ev(1, "session_started"),
      ev(2, "turn_started", "turn_1"),
      ev(3, "tool_call_requested", "turn_1"),
    ];
    expect(deriveCurrentTurn(events)).toBe("turn_1");
  });

  it("returns null when the only turn has completed", () => {
    const events = [
      ev(1, "turn_started", "turn_1"),
      ev(2, "turn_completed", "turn_1"),
    ];
    expect(deriveCurrentTurn(events)).toBe(null);
  });

  it("returns the latest active turn when multiple are present", () => {
    const events = [
      ev(1, "turn_started", "turn_1"),
      ev(2, "turn_completed", "turn_1"),
      ev(3, "turn_started", "turn_2"),
      ev(4, "tool_call_requested", "turn_2"),
    ];
    expect(deriveCurrentTurn(events)).toBe("turn_2");
  });

  it("handles out-of-order completions correctly", () => {
    const events = [
      ev(1, "turn_started", "turn_1"),
      ev(2, "turn_started", "turn_2"),
      ev(3, "turn_completed", "turn_2"),
      // turn_1 is still active
    ];
    expect(deriveCurrentTurn(events)).toBe("turn_1");
  });
});
