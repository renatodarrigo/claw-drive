import { describe, it, expect } from "vitest";
import { shouldEmit, VALID_WATCH_KINDS, DECISION_ONLY_KINDS } from "../../src/cli/commands/watch.js";
import { aliasWithGeneration } from "../../src/lib/alias.js";
import { buildNotificationContract } from "../../src/lib/tokens.js";
import { buildSessionSnapshot, renderSummaryTable } from "../../src/cli/commands/status.js";
import type { Event } from "../../src/lib/events.js";
import type { SessionState } from "../../src/lib/state.js";

const ROTATION_KINDS = [
  "context_threshold_reached",
  "session_rotated",
  "rotation_failed",
  "rotation_refused",
] as const;

describe("watch surfaces rotation kinds", () => {
  it("shouldEmit passes all four rotation kinds", () => {
    for (const kind of ROTATION_KINDS) {
      expect(shouldEmit({ kind } as unknown as Event)).toBe(true);
    }
  });
  it("VALID_WATCH_KINDS includes them; --decision-only includes all but session_rotated", () => {
    for (const kind of ROTATION_KINDS) expect(VALID_WATCH_KINDS.has(kind)).toBe(true);
    expect(DECISION_ONLY_KINDS.has("context_threshold_reached")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("rotation_failed")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("rotation_refused")).toBe(true);
    expect(DECISION_ONLY_KINDS.has("session_rotated")).toBe(false);
  });
});

describe("aliasWithGeneration", () => {
  it("formats alias (N), passes bare alias through, and undefined stays undefined", () => {
    expect(aliasWithGeneration("reviewer", 2)).toBe("reviewer (2)");
    expect(aliasWithGeneration("reviewer", undefined)).toBe("reviewer");
    expect(aliasWithGeneration(undefined, 3)).toBeUndefined();
  });
});

describe("notification contract rotation field", () => {
  const base = { watchCommand: "claw-drive watch sess_x", wrapperEnabled: true };
  it("carries rotation info when provided, omits it otherwise", () => {
    const withRot = buildNotificationContract({
      ...base,
      rotation: { threshold_tokens: 120000, max_generations: 10 },
    });
    expect(withRot.rotation).toEqual({ threshold_tokens: 120000, max_generations: 10 });
    expect(buildNotificationContract(base).rotation).toBeUndefined();
  });
});

describe("status shows context + generation", () => {
  const state: SessionState = {
    session_id: "sess_20260729T000000_aaaaaa",
    status: "stopped",
    cwd: "/tmp/x",
    policy: { rotation: { threshold_tokens: 120000 } },
    decision_timeout_seconds: 3600,
    model: null,
    runner_pid: null,
    started_at: "2026-07-29T00:00:00.000Z",
    last_event_at: null,
    turns: 3,
    exit_code: null,
    exit_reason: null,
    alias: "reviewer",
    generation: 2,
    context_tokens: 123456,
    rotated_from: "sess_prev",
  };
  it("snapshot carries the context-rotation fields and the table renders alias (N) + context", () => {
    const snap = buildSessionSnapshot(state, [], Date.parse("2026-07-29T01:00:00.000Z"));
    expect(snap).toMatchObject({
      generation: 2,
      context_tokens: 123456,
      rotation_threshold: 120000,
      rotated_from: "sess_prev",
    });
    const table = renderSummaryTable([snap!], Date.parse("2026-07-29T01:00:00.000Z"));
    expect(table).toContain("reviewer (2)");
    expect(table).toContain("123k/120k");
    expect(table.split("\n")[0]).toContain("CONTEXT");
  });
});
