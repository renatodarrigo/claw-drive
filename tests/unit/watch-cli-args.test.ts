import { describe, it, expect } from "vitest";
import {
  parseWatchArgs,
  DECISION_ONLY_KINDS,
} from "../../src/cli/commands/watch.js";

describe("parseWatchArgs — session id", () => {
  it("rejects missing session id", () => {
    const r = parseWatchArgs([]);
    expect(r.ok).toBe(false);
  });

  it("rejects malformed session id", () => {
    const r = parseWatchArgs(["not-a-valid-id"]);
    expect(r.ok).toBe(false);
  });

  it("accepts a valid session id", () => {
    // Session IDs are isValidSessionId-shaped; a UUID-ish hex string works.
    const r = parseWatchArgs(["sess_abcdef0123456789"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sessionId).toBe("sess_abcdef0123456789");
      expect(r.since).toBe("current");
      expect(r.allowed).toBeNull();
    }
  });
});

describe("parseWatchArgs — --since / --replay", () => {
  it("--since N parses to numeric since", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--since", "42"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.since).toBe(42);
  });

  it("--replay parses as since=0", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--replay"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.since).toBe(0);
  });

  it("default since is 'current'", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.since).toBe("current");
  });
});

describe("parseWatchArgs — --only", () => {
  it("--only single kind", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--only", "tool_decision_required"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.allowed) {
      expect(r.allowed.size).toBe(1);
      expect(r.allowed.has("tool_decision_required")).toBe(true);
    }
  });

  it("--only multiple kinds", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--only",
      "tool_decision_required,turn_failed,session_stopped",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.allowed) {
      expect(r.allowed.has("tool_decision_required")).toBe(true);
      expect(r.allowed.has("turn_failed")).toBe(true);
      expect(r.allowed.has("session_stopped")).toBe(true);
      expect(r.allowed.size).toBe(3);
    }
  });

  it("--only with whitespace around commas", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--only",
      "tool_decision_required, turn_failed , session_stopped",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.allowed) {
      expect(r.allowed.size).toBe(3);
    }
  });

  it("--only without value → error", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--only"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--only/i);
  });

  it("--only with empty string → error", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--only", ""]);
    expect(r.ok).toBe(false);
  });

  it("--only with only commas → error (no real kinds)", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--only", ",,"]);
    expect(r.ok).toBe(false);
  });

  it("--only with unknown kind → error", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--only",
      "tool_decision_required,nonsense_kind",
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nonsense_kind/);
  });

  it("--only error lists valid kinds for the user", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--only", "bad"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The error should help the user — list at least one valid kind.
      expect(r.error).toMatch(/tool_decision_required/);
    }
  });
});

describe("parseWatchArgs — --decision-only", () => {
  it("--decision-only sets allowed to the preset", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--decision-only"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.allowed) {
      expect(r.allowed.size).toBe(DECISION_ONLY_KINDS.size);
      for (const k of [...DECISION_ONLY_KINDS]) {
        expect(r.allowed.has(k)).toBe(true);
      }
    }
  });
});

describe("parseWatchArgs — mutual exclusion", () => {
  it("--only X --decision-only → error", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--only",
      "tool_decision_required",
      "--decision-only",
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mutually exclusive|--only.*--decision-only|--decision-only.*--only/i);
  });

  it("--decision-only --only X → error (reverse order)", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--decision-only",
      "--only",
      "tool_decision_required",
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("parseWatchArgs — --no-token-filter (v0.5.6)", () => {
  it("--no-token-filter sets the flag", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--no-token-filter"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.noTokenFilter).toBe(true);
  });

  it("default state: noTokenFilter is false", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.noTokenFilter).toBe(false);
    }
  });
});

describe("parseWatchArgs — combinations", () => {
  it("--since 5 --decision-only", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--since", "5", "--decision-only"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.since).toBe(5);
      expect(r.allowed).not.toBeNull();
      expect(r.allowed!.has("tool_decision_required")).toBe(true);
    }
  });

  it("--replay --only turn_failed", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--replay",
      "--only",
      "turn_failed",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.since).toBe(0);
      expect(r.allowed!.size).toBe(1);
    }
  });

  it("no narrowing flags → allowed is null", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allowed).toBeNull();
  });
});

describe("--idle-after parsing", () => {
  it("defaults idleAfterSeconds to 600 when flag absent", () => {
    const r = parseWatchArgs(["sess_xxx"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idleAfterSeconds).toBe(600);
  });

  it("parses --idle-after 300 to 300", () => {
    const r = parseWatchArgs(["sess_xxx", "--idle-after", "300"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idleAfterSeconds).toBe(300);
  });

  it("parses --idle-after 0 to disable", () => {
    const r = parseWatchArgs(["sess_xxx", "--idle-after", "0"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idleAfterSeconds).toBe(0);
  });

  it("rejects --idle-after with no value", () => {
    const r = parseWatchArgs(["sess_xxx", "--idle-after"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/idle-after requires a value/i);
  });

  it("rejects --idle-after with a non-integer", () => {
    const r = parseWatchArgs(["sess_xxx", "--idle-after", "abc"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/idle-after.*integer/i);
  });

  it("rejects --idle-after with a negative value", () => {
    const r = parseWatchArgs(["sess_xxx", "--idle-after", "-5"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/idle-after.*non-negative/i);
  });

  it("rejects --idle-after with a fractional value", () => {
    const r = parseWatchArgs(["sess_xxx", "--idle-after", "10.5"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/idle-after.*integer/i);
  });
});

describe("idle in VALID_WATCH_KINDS", () => {
  it("accepts 'idle' as a valid --only kind", () => {
    const r = parseWatchArgs(["sess_xxx", "--only", "idle,turn_completed"]);
    expect(r.ok).toBe(true);
  });
});

describe("parseWatchArgs — --no-suspected-needs-input (CD-6 backstop toggle)", () => {
  it("defaults suspectedNeedsInput to true when the flag is absent", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suspectedNeedsInput).toBe(true);
  });

  it("--no-suspected-needs-input sets suspectedNeedsInput to false", () => {
    const r = parseWatchArgs(["sess_abcdef0123456789", "--no-suspected-needs-input"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suspectedNeedsInput).toBe(false);
  });

  it("composes with --decision-only, --idle-after, and --no-token-filter without a parse error", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--decision-only",
      "--idle-after",
      "30",
      "--no-token-filter",
      "--no-suspected-needs-input",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.suspectedNeedsInput).toBe(false);
      expect(r.noTokenFilter).toBe(true);
      expect(r.idleAfterSeconds).toBe(30);
      expect(r.allowed).not.toBeNull();
    }
  });

  it("composes with --only without a parse error", () => {
    const r = parseWatchArgs([
      "sess_abcdef0123456789",
      "--only",
      "turn_completed",
      "--no-suspected-needs-input",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.suspectedNeedsInput).toBe(false);
      expect(r.allowed!.has("turn_completed")).toBe(true);
    }
  });
});
