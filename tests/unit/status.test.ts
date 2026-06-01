import { describe, it, expect } from "vitest";
import {
  parseStatusArgs,
  buildSessionSnapshot,
  extractTrailingToken,
  truncateHead,
  renderSummaryTable,
  renderDetailedBlock,
  renderJson,
  type SessionSnapshot,
} from "../../src/cli/commands/status.js";
import type { SessionState } from "../../src/lib/state.js";
import type { Event } from "../../src/lib/events.js";

const NOW = "2026-04-27T12:45:01Z";
const NOW_MS = Date.parse(NOW);

function ev(partial: Partial<Event>): Event {
  return { seq: 1, at: NOW, ...(partial as any) } as Event;
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "sess_abcdef0123456789",
    status: "running",
    cwd: "/home/ren/Workspace/cloverleaf",
    policy: "bypass",
    decision_timeout_seconds: 3600,
    model: null,
    runner_pid: 1, // PID 1 is always alive (init); good for "live session" tests
    started_at: "2026-04-27T12:00:00Z",
    last_event_at: NOW,
    turns: 0,
    exit_code: null,
    exit_reason: null,
    ...overrides,
  };
}

describe("extractTrailingToken", () => {
  it("matches a token at end-of-message after a blank line", () => {
    expect(extractTrailingToken("I'm done\n\n[DONE]")).toBe("DONE");
  });

  it("matches a token followed by trailing newline", () => {
    expect(extractTrailingToken("I'm done\n[NEEDS-INPUT]\n")).toBe("NEEDS-INPUT");
  });

  it("matches a token immediately after content + newline", () => {
    expect(extractTrailingToken("done.\n[ERROR]")).toBe("ERROR");
  });

  it("matches an only-token message", () => {
    expect(extractTrailingToken("[DONE]")).toBe("DONE");
  });

  it("does NOT match a token mid-message", () => {
    expect(extractTrailingToken("I said [NEEDS-INPUT] earlier but actually we're fine")).toBe(null);
  });

  it("returns null when no token present", () => {
    expect(extractTrailingToken("Just done.")).toBe(null);
  });

  it("matches a token surrounded by trailing whitespace", () => {
    expect(extractTrailingToken("done.\n[DONE]\n\n  \t\n")).toBe("DONE");
  });

  it("matches each of the v0.5.7 vocabulary tokens", () => {
    const vocab = ["NEEDS-INPUT", "DONE"];
    for (const t of vocab) {
      expect(extractTrailingToken(`done\n[${t}]`)).toBe(t);
    }
  });

  it("matches CRLF line endings", () => {
    expect(extractTrailingToken("done.\r\n[NEEDS-INPUT]\r\n")).toBe("NEEDS-INPUT");
  });

  it("matches arbitrary identifiers regardless of vocab membership", () => {
    // The regex matches any uppercase identifier; vocab enforcement happens
    // elsewhere (resolveSurfaceMode treats unknown tokens as silent in v0.5.7).
    expect(extractTrailingToken("trace\n[CUSTOM-TOKEN]")).toBe("CUSTOM-TOKEN");
  });

  it("does NOT match a token if anything non-whitespace follows", () => {
    expect(extractTrailingToken("[NEEDS-INPUT] please")).toBe(null);
  });
});

describe("truncateHead", () => {
  it("returns short text unchanged", () => {
    expect(truncateHead("hello", 1000)).toBe("hello");
  });

  it("truncates long text and appends ellipsis", () => {
    const long = "a".repeat(1500);
    const out = truncateHead(long, 1000);
    expect(out.length).toBe(1001); // 1000 chars + 1 ellipsis char
    expect(out.slice(0, 1000)).toBe("a".repeat(1000));
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns text equal to limit unchanged", () => {
    const exact = "a".repeat(50);
    expect(truncateHead(exact, 50)).toBe(exact);
  });
});

describe("buildSessionSnapshot — empty / edge cases", () => {
  it("returns null when state is null", () => {
    expect(buildSessionSnapshot(null, [], NOW_MS)).toBe(null);
  });

  it("freshly-started session with no events has no current_turn or last_completed_turn", () => {
    const snap = buildSessionSnapshot(baseState(), [], NOW_MS);
    expect(snap).not.toBe(null);
    expect(snap!.current_turn).toBeUndefined();
    expect(snap!.last_completed_turn).toBeUndefined();
    expect(snap!.pending_decisions).toEqual([]);
    expect(snap!.recent_errors).toEqual([]);
    expect(snap!.turns).toBe(0);
  });
});

describe("buildSessionSnapshot — orphan detection", () => {
  it("reports orphaned when status is running but pid is dead", () => {
    // PID 999999999 is unlikely to exist; isPidAlive returns false.
    const state = baseState({ status: "running", runner_pid: 999999999 });
    const snap = buildSessionSnapshot(state, [], NOW_MS);
    expect(snap!.status).toBe("orphaned");
  });

  it("preserves status when pid is alive (PID 1)", () => {
    const state = baseState({ status: "running", runner_pid: 1 });
    const snap = buildSessionSnapshot(state, [], NOW_MS);
    expect(snap!.status).toBe("running");
  });

  it("preserves stopped status (no orphan check)", () => {
    const state = baseState({ status: "stopped", runner_pid: 999999999 });
    const snap = buildSessionSnapshot(state, [], NOW_MS);
    expect(snap!.status).toBe("stopped");
  });
});

describe("buildSessionSnapshot — current_turn detection", () => {
  it("detects current turn from turn_started without matching completion", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "turn_1", message: "go" } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.current_turn).toEqual(
      expect.objectContaining({
        turn_id: "turn_1",
        started_at: expect.any(String),
      })
    );
  });

  it("no current_turn when most recent turn has completed", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "turn_1", message: "go" } as any),
      ev({ seq: 2, kind: "turn_completed", turn_id: "turn_1", stop_reason: "success" } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.current_turn).toBeUndefined();
  });

  it("current_turn includes the most recent assistant_text and extracted token", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "t1", message: "go" } as any),
      ev({
        seq: 2,
        kind: "assistant_text",
        turn_id: "t1",
        text: "I drafted the auth section.\n[NEEDS-INPUT]",
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.current_turn?.last_assistant_text).toContain("I drafted the auth section.");
    expect(snap!.current_turn?.last_token).toBe("NEEDS-INPUT");
  });

  it("current_turn last_token is null when no sentinel", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "t1", message: "go" } as any),
      ev({ seq: 2, kind: "assistant_text", turn_id: "t1", text: "still working" } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.current_turn?.last_token).toBe(null);
  });
});

describe("buildSessionSnapshot — last_completed_turn", () => {
  it("captures the most recent turn_completed event", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "t1", message: "go" } as any),
      ev({ seq: 2, kind: "assistant_text", turn_id: "t1", text: "step 1 done" } as any),
      ev({ seq: 3, kind: "turn_completed", turn_id: "t1", stop_reason: "success" } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.last_completed_turn).toEqual(
      expect.objectContaining({
        turn_id: "t1",
        stop_reason: "success",
        last_assistant_text: "step 1 done",
        last_token: null,
      })
    );
  });

  it("includes turn_failed in last_completed_turn (uses 'failed' stop_reason marker)", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "t1", message: "go" } as any),
      ev({ seq: 2, kind: "assistant_text", turn_id: "t1", text: "tried" } as any),
      ev({ seq: 3, kind: "turn_failed", turn_id: "t1", error: "rate limit" } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.last_completed_turn?.turn_id).toBe("t1");
    expect(snap!.last_completed_turn?.stop_reason).toBe("failed");
  });
});

describe("buildSessionSnapshot — pending_decisions", () => {
  it("collects only unresolved tool_decision_required events", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_a",
        tool: "Bash",
        args: { command: "git push" },
        severity: "high",
        default_action: "reject",
        default_at: "2026-04-27T12:42:46Z",
      } as any),
      ev({
        seq: 2,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_b",
        tool: "Bash",
        args: { command: "ls" },
        severity: "low",
        default_action: "approve",
        default_at: "2026-04-27T12:43:00Z",
      } as any),
      ev({
        seq: 3,
        kind: "tool_decision_resolved",
        turn_id: "t1",
        call_id: "call_b",
        action: "approve",
        reason: "ok",
        resolved_by: "user_mcp",
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.pending_decisions).toHaveLength(1);
    expect(snap!.pending_decisions[0].call_id).toBe("call_a");
  });

  it("orders pending decisions chronologically (oldest first)", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_old",
        tool: "Bash",
        args: { command: "old" },
        severity: "high",
        default_action: "reject",
        default_at: "2026-04-27T12:00:00Z",
        at: "2026-04-27T12:00:00Z",
      } as any),
      ev({
        seq: 2,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_new",
        tool: "Bash",
        args: { command: "new" },
        severity: "high",
        default_action: "reject",
        default_at: "2026-04-27T12:30:00Z",
        at: "2026-04-27T12:30:00Z",
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.pending_decisions.map((p) => p.call_id)).toEqual(["call_old", "call_new"]);
  });

  it("computes age_seconds against the provided 'now'", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_a",
        tool: "Bash",
        args: { command: "x" },
        severity: "high",
        default_action: "reject",
        default_at: "2026-04-27T12:43:00Z",
        at: "2026-04-27T12:43:00Z",
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    // NOW = 12:45:01, decision at 12:43:00 → 121 seconds
    expect(snap!.pending_decisions[0].age_seconds).toBe(121);
  });

  it("summarizes Bash args as the command", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_a",
        tool: "Bash",
        args: { command: "git push origin main" },
        severity: "high",
        default_action: "reject",
        default_at: NOW,
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.pending_decisions[0].args_summary).toBe("git push origin main");
  });

  it("summarizes Edit args as file_path", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "call_a",
        tool: "Edit",
        args: { file_path: "/etc/passwd", old_string: "x" },
        severity: "high",
        default_action: "defer",
        default_at: NOW,
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.pending_decisions[0].args_summary).toBe("/etc/passwd");
  });
});

describe("buildSessionSnapshot — recent_errors", () => {
  it("collects turn_failed, error, and is-error tool_call_result events", () => {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_failed", turn_id: "t1", error: "rate limit", at: "2026-04-27T12:30:00Z" } as any),
      ev({ seq: 2, kind: "error", message: "runner error", recoverable: false, at: "2026-04-27T12:31:00Z" } as any),
      ev({
        seq: 3,
        kind: "tool_call_result",
        turn_id: "t1",
        call_id: "c",
        result: "command failed",
        is_error: true,
        at: "2026-04-27T12:32:00Z",
      } as any),
      ev({
        seq: 4,
        kind: "tool_call_result",
        turn_id: "t1",
        call_id: "c2",
        result: "ok",
        is_error: false,
        at: "2026-04-27T12:33:00Z",
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.recent_errors).toHaveLength(3);
    // Should NOT include the is_error: false tool_call_result
    expect(snap!.recent_errors.map((e) => e.kind)).toEqual([
      "tool_call_result",
      "error",
      "turn_failed",
    ]);
  });

  it("caps recent_errors at 3 (most recent first)", () => {
    const events: Event[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push(
        ev({
          seq: i,
          kind: "turn_failed",
          turn_id: `t${i}`,
          error: `err ${i}`,
          at: `2026-04-27T12:${10 + i}:00Z`,
        } as any)
      );
    }
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    expect(snap!.recent_errors).toHaveLength(3);
    // Most recent first → err 5, err 4, err 3
    expect(snap!.recent_errors.map((e) => (e.summary ?? "").slice(0, 5))).toEqual([
      "err 5",
      "err 4",
      "err 3",
    ]);
  });
});

describe("buildSessionSnapshot — last_assistant_text truncation", () => {
  it("truncates long assistant_text from the head and extracts trailing token before truncation", () => {
    const longBody = "x".repeat(1500);
    const text = longBody + "\n[NEEDS-INPUT]";
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "t1", message: "go" } as any),
      ev({ seq: 2, kind: "assistant_text", turn_id: "t1", text } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, NOW_MS);
    // Token extracted from full text:
    expect(snap!.current_turn?.last_token).toBe("NEEDS-INPUT");
    // Text truncated from head — the token is gone from the visible text
    // (it sits past the 1000-char cutoff), but `…` is appended.
    expect(snap!.current_turn?.last_assistant_text?.endsWith("…")).toBe(true);
    expect(snap!.current_turn?.last_assistant_text?.length).toBe(1001);
  });
});

describe("renderSummaryTable", () => {
  it("emits header + one row per session", () => {
    const snaps: SessionSnapshot[] = [
      {
        session_id: "sess_abcdef0123456789",
        status: "running",
        cwd: "/home/ren/Workspace/cloverleaf",
        policy_digest: "p123",
        runner_pid: 1,
        created_at: "2026-04-27T12:00:00Z",
        last_activity_at: NOW,
        turns: 5,
        pending_decisions: [],
        recent_errors: [],
      },
    ];
    const out = renderSummaryTable(snaps, NOW_MS);
    expect(out).toMatch(/SESSION_ID.*STATUS.*TURNS.*PENDING.*ERRORS.*LAST_ACTIVITY.*CWD/);
    expect(out).toMatch(/sess_abcdef/);
    expect(out).toMatch(/running/);
  });

  it("renders '(no sessions)' when empty", () => {
    const out = renderSummaryTable([], NOW_MS);
    expect(out).toMatch(/no sessions/i);
  });
});

describe("renderDetailedBlock", () => {
  it("renders all sections when populated", () => {
    const snap: SessionSnapshot = {
      session_id: "sess_abcdef0123456789",
      status: "running",
      cwd: "/home/ren/Workspace/cloverleaf",
      policy_label: "starter",
      policy_digest: "p3a7f9e2",
      runner_pid: 12345,
      created_at: "2026-04-27T12:00:00Z",
      last_activity_at: NOW,
      turns: 5,
      current_turn: {
        turn_id: "turn_5",
        started_at: "2026-04-27T12:44:30Z",
        last_assistant_text: "I've drafted the auth section.",
        last_token: "NEEDS-INPUT",
      },
      pending_decisions: [
        {
          call_id: "call_abc",
          tool: "Bash",
          args_summary: "git push origin main",
          severity: "high",
          default_action: "reject",
          deferred_at: "2026-04-27T12:42:46Z",
          age_seconds: 135,
        },
      ],
      recent_errors: [
        {
          kind: "turn_failed",
          at: "2026-04-27T12:30:18Z",
          summary: "rate limit",
        },
      ],
    };
    const out = renderDetailedBlock(snap);
    expect(out).toMatch(/Session.*sess_abcdef/);
    expect(out).toMatch(/Status:.*running/);
    expect(out).toMatch(/Cwd:.*cloverleaf/);
    expect(out).toMatch(/Policy:.*starter.*p3a7f9e2/);
    expect(out).toMatch(/Current turn:.*turn_5/);
    expect(out).toMatch(/Token:.*NEEDS-INPUT/);
    expect(out).toMatch(/Pending decisions: \(1\)/);
    expect(out).toMatch(/git push origin main/);
    expect(out).toMatch(/Recent errors: \(1\)/);
  });

  it("omits empty sections", () => {
    const snap: SessionSnapshot = {
      session_id: "sess_xyz123456789abc",
      status: "running",
      cwd: "/x",
      policy_digest: "p0",
      runner_pid: 1,
      created_at: NOW,
      last_activity_at: NOW,
      turns: 0,
      pending_decisions: [],
      recent_errors: [],
    };
    const out = renderDetailedBlock(snap);
    expect(out).not.toMatch(/Pending decisions/);
    expect(out).not.toMatch(/Recent errors/);
    expect(out).not.toMatch(/Current turn/);
    expect(out).not.toMatch(/Token:/);
  });

  it("omits Token line when last_token is null", () => {
    const snap: SessionSnapshot = {
      session_id: "sess_xyz123456789abc",
      status: "running",
      cwd: "/x",
      policy_digest: "p0",
      runner_pid: 1,
      created_at: NOW,
      last_activity_at: NOW,
      turns: 1,
      current_turn: {
        turn_id: "t1",
        started_at: NOW,
        last_assistant_text: "still working",
        last_token: null,
      },
      pending_decisions: [],
      recent_errors: [],
    };
    const out = renderDetailedBlock(snap);
    expect(out).toMatch(/Current turn:.*t1/);
    expect(out).not.toMatch(/Token:/);
  });
});

describe("renderJson", () => {
  it("renders single-session as a bare object", () => {
    const snap: SessionSnapshot = {
      session_id: "sess_abc123456789defx",
      status: "running",
      cwd: "/x",
      policy_digest: "p0",
      runner_pid: 1,
      created_at: NOW,
      last_activity_at: NOW,
      turns: 0,
      pending_decisions: [],
      recent_errors: [],
    };
    const json = renderJson(snap);
    const parsed = JSON.parse(json);
    expect(parsed.session_id).toBe("sess_abc123456789defx");
    expect(parsed.sessions).toBeUndefined();
  });

  it("renders multiple sessions wrapped in { sessions: [...] }", () => {
    const snap: SessionSnapshot = {
      session_id: "sess_abc123456789defx",
      status: "running",
      cwd: "/x",
      policy_digest: "p0",
      runner_pid: 1,
      created_at: NOW,
      last_activity_at: NOW,
      turns: 0,
      pending_decisions: [],
      recent_errors: [],
    };
    const json = renderJson([snap]);
    const parsed = JSON.parse(json);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].session_id).toBe("sess_abc123456789defx");
  });
});

describe("parseStatusArgs", () => {
  it("no args → all sessions, human format", () => {
    const r = parseStatusArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.sessionId).toBeUndefined();
      expect(r.json).toBe(false);
    }
  });

  it("--json → all sessions, json format", () => {
    const r = parseStatusArgs(["--json"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.json).toBe(true);
    }
  });

  it("session id positional", () => {
    const r = parseStatusArgs(["sess_abcdef0123456789"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.sessionId).toBe("sess_abcdef0123456789");
    }
  });

  it("session id + --json", () => {
    const r = parseStatusArgs(["sess_abcdef0123456789", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) {
      expect(r.sessionId).toBe("sess_abcdef0123456789");
      expect(r.json).toBe(true);
    }
  });

  it("a ref that is neither a canonical id nor a valid alias shape → error", () => {
    // CD-10: the positional accepts an id OR an alias shape; a space (or a
    // leading digit) is neither, so it's still rejected at parse time.
    expect(parseStatusArgs(["not valid"]).ok).toBe(false);
    expect(parseStatusArgs(["9bad"]).ok).toBe(false);
  });

  it("accepts an alias-shaped positional (resolution happens in cmdStatus)", () => {
    const r = parseStatusArgs(["reviewer"]);
    expect(r.ok).toBe(true);
    if (r.ok && !r.help) expect(r.sessionId).toBe("reviewer");
  });

  it("--help → help action", () => {
    const r = parseStatusArgs(["--help"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.help).toBe(true);
  });

  it("unknown flag → error", () => {
    const r = parseStatusArgs(["--frobnicate"]);
    expect(r.ok).toBe(false);
  });
});

describe("status — CD-8 rationale + diff in pending decisions", () => {
  const ms = Date.parse("2026-05-01T00:01:00Z");

  function snapWith(tdrExtra: object): SessionSnapshot {
    const events: Event[] = [
      ev({ seq: 1, kind: "turn_started", turn_id: "t1", message: "go" } as any),
      ev({
        seq: 2,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "c-x",
        tool: "Edit",
        args: { file_path: "x.ts" },
        severity: "high",
        default_action: "defer",
        default_at: "2026-05-01T00:00:05Z",
        ...tdrExtra,
      } as any),
    ];
    return buildSessionSnapshot(baseState(), events, ms)!;
  }

  const EDIT_EXTRA = {
    rationale: "patching x",
    diff: "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
  };

  it("status --json includes rationale + diff for an escalated Edit", () => {
    const json = JSON.parse(renderJson(snapWith(EDIT_EXTRA)));
    expect(json.pending_decisions[0].rationale).toBe("patching x");
    expect(json.pending_decisions[0].diff).toContain("+const a = 2;");
  });

  it("status detail shows the rationale + diff lines", () => {
    const detail = renderDetailedBlock(snapWith(EDIT_EXTRA));
    expect(detail).toContain("rationale: patching x");
    expect(detail).toContain("+const a = 2;");
  });

  it("a non-file tool surfaces rationale only (no diff)", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "c-b",
        tool: "Bash",
        args: { command: "ls" },
        severity: "high",
        default_action: "defer",
        default_at: "2026-05-01T00:00:05Z",
        rationale: "listing",
      } as any),
    ];
    const snap = buildSessionSnapshot(baseState(), events, ms)!;
    expect(snap.pending_decisions[0].rationale).toBe("listing");
    expect(snap.pending_decisions[0].diff).toBeUndefined();
    expect(renderJson(snap)).not.toContain('"diff"');
  });

  it("a decision lacking the fields renders with neither key", () => {
    const events: Event[] = [
      ev({
        seq: 1,
        kind: "tool_decision_required",
        turn_id: "t1",
        call_id: "c-n",
        tool: "Bash",
        args: { command: "ls" },
        severity: "high",
        default_action: "defer",
        default_at: "2026-05-01T00:00:05Z",
      } as any),
    ];
    const json = JSON.parse(renderJson(buildSessionSnapshot(baseState(), events, ms)!));
    expect("rationale" in json.pending_decisions[0]).toBe(false);
    expect("diff" in json.pending_decisions[0]).toBe(false);
  });
});
