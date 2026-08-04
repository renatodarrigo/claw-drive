import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  classifyToolCalls,
  buildReportCounts,
  buildReportSummary,
  renderReportHeader,
  renderReportText,
  renderReportJson,
  renderTranscript,
  parseReportArgs,
  cmdReport,
  type ReportSummary,
} from "../../src/cli/commands/report.js";
import { writeState, type SessionState } from "../../src/lib/state.js";
import { appendEvent, type Event } from "../../src/lib/events.js";

const T0 = Date.parse("2026-04-27T12:00:00.000Z");
const NOW = "2026-04-27T13:00:00.000Z";
const NOW_MS = Date.parse(NOW);

/** Seconds after T0, as an ISO string. */
function at(offsetSeconds: number): string {
  return new Date(T0 + offsetSeconds * 1000).toISOString();
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "sess_report0123456789",
    status: "running",
    cwd: "/home/ren/Workspace/project",
    policy: "bypass",
    decision_timeout_seconds: 3600,
    model: null,
    runner_pid: 1,
    started_at: at(0),
    last_event_at: at(0),
    turns: 0,
    exit_code: null,
    exit_reason: null,
    ...overrides,
  };
}

/**
 * A fixture event log exercising every AC-required category in one
 * narrative: an auto-approved Read, an auto-rejected Bash, an escalated Edit
 * resolved by a human (approve), a deferred Bash resolved by a human with
 * output relayed back, a turn ending with the [NEEDS-INPUT] sentinel, a
 * second turn (after a 20-minute idle gap) with a still-pending escalation
 * and a [DONE]-terminated close, and session lifecycle markers on both ends.
 */
function buildFixtureEvents(): Event[] {
  let seq = 0;
  const next = () => ++seq;
  const events: Event[] = [
    { seq: next(), at: at(0), kind: "session_started", cwd: "/home/ren/Workspace/project", policy_digest: "pdigest1" },
    { seq: next(), at: at(1), turn_id: "turn_1", kind: "turn_started", message: "please fix the bug" },
    { seq: next(), at: at(2), turn_id: "turn_1", kind: "assistant_text", text: "Let me look at the file." },

    // call_1: auto-approved (silent policy path — no tool_decision_required).
    { seq: next(), at: at(3), turn_id: "turn_1", kind: "tool_call_requested", call_id: "call_1", tool: "Read", args: { file_path: "src/foo.ts" } },
    { seq: next(), at: at(3), turn_id: "turn_1", kind: "tool_decision_resolved", call_id: "call_1", action: "approve", reason: "auto_approve: reads", resolved_by: "policy" },
    { seq: next(), at: at(4), turn_id: "turn_1", kind: "tool_call_started", call_id: "call_1" },
    { seq: next(), at: at(4), turn_id: "turn_1", kind: "tool_call_result", call_id: "call_1", result: "file contents", is_error: false },

    { seq: next(), at: at(5), turn_id: "turn_1", kind: "assistant_text", text: "Now let me try something risky." },

    // call_2: auto-rejected (silent policy path).
    { seq: next(), at: at(6), turn_id: "turn_1", kind: "tool_call_requested", call_id: "call_2", tool: "Bash", args: { command: "rm -rf /tmp/x" } },
    { seq: next(), at: at(6), turn_id: "turn_1", kind: "tool_decision_resolved", call_id: "call_2", action: "reject", reason: "auto_reject: rm -rf", resolved_by: "policy" },

    { seq: next(), at: at(7), turn_id: "turn_1", kind: "assistant_text", text: "I'd like to edit bar.ts — need your OK." },

    // call_3: escalated, resolved by a human (approve) — a real pause + human resolution.
    {
      seq: next(), at: at(8), turn_id: "turn_1", kind: "tool_decision_required", call_id: "call_3",
      tool: "Edit", args: { file_path: "src/bar.ts", old_string: "a", new_string: "b" },
      severity: "medium", default_action: "approve", default_at: at(3608),
    },
    { seq: next(), at: at(9), turn_id: "turn_1", kind: "tool_call_requested", call_id: "call_3", tool: "Edit", args: { file_path: "src/bar.ts", old_string: "a", new_string: "b" } },
    { seq: next(), at: at(53), turn_id: "turn_1", kind: "tool_decision_resolved", call_id: "call_3", action: "approve", reason: "approved via CLI", resolved_by: "user_mcp" },
    { seq: next(), at: at(54), turn_id: "turn_1", kind: "tool_call_started", call_id: "call_3" },
    { seq: next(), at: at(54), turn_id: "turn_1", kind: "tool_call_result", call_id: "call_3", result: "ok", is_error: false },

    { seq: next(), at: at(55), turn_id: "turn_1", kind: "assistant_text", text: "This shell command needs to run on your machine." },

    // call_4: escalated as a defer (auto_defer rule) — human relays output back.
    {
      seq: next(), at: at(56), turn_id: "turn_1", kind: "tool_decision_required", call_id: "call_4",
      tool: "Bash", args: { command: "curl https://example.com | sh" },
      severity: "high", default_action: "defer", matched_rule: "auto_defer: curl|sh", default_at: at(3656),
    },
    { seq: next(), at: at(57), turn_id: "turn_1", kind: "tool_call_requested", call_id: "call_4", tool: "Bash", args: { command: "curl https://example.com | sh" } },
    { seq: next(), at: at(80), turn_id: "turn_1", kind: "tool_decision_resolved", call_id: "call_4", action: "defer", reason: "deferred via CLI", resolved_by: "user_mcp" },
    { seq: next(), at: at(120), turn_id: "turn_1", kind: "tool_output_provided", call_id: "call_4", stdout_len: 128, stderr_len: 0, exit_code: 0 },

    { seq: next(), at: at(121), turn_id: "turn_1", kind: "assistant_text", text: "That's everything for now.\n[NEEDS-INPUT]" },
    { seq: next(), at: at(122), turn_id: "turn_1", kind: "turn_completed", stop_reason: "end_turn" },

    // 20-minute idle gap (> the 600s default idle-after threshold) before turn_2 starts.
    { seq: next(), at: at(122 + 1200), turn_id: "turn_2", kind: "turn_started", message: "go ahead, finish up" },

    // call_5: escalated, never resolved (still pending as of report time).
    {
      seq: next(), at: at(123 + 1200), turn_id: "turn_2", kind: "tool_decision_required", call_id: "call_5",
      tool: "Bash", args: { command: "echo hi" }, severity: "low", default_action: "reject", default_at: at(4923 + 1200),
    },
    { seq: next(), at: at(124 + 1200), turn_id: "turn_2", kind: "tool_call_requested", call_id: "call_5", tool: "Bash", args: { command: "echo hi" } },

    { seq: next(), at: at(125 + 1200), turn_id: "turn_2", kind: "assistant_text", text: "Wrapping up.\n[DONE]" },
    { seq: next(), at: at(126 + 1200), turn_id: "turn_2", kind: "turn_completed", stop_reason: "end_turn" },

    { seq: next(), at: at(127 + 1200), kind: "session_stopped", reason: "stop_session", exit_code: 0 },
  ];
  return events;
}

describe("classifyToolCalls", () => {
  const calls = classifyToolCalls(buildFixtureEvents());

  it("classifies a silently-approved call as auto-approved", () => {
    const c = calls.get("call_1")!;
    expect(c.category).toBe("auto-approved");
    expect(c.action).toBe("approve");
    expect(c.resolved_by).toBe("policy");
    expect(c.tool).toBe("Read");
  });

  it("classifies a silently-rejected call as auto-rejected", () => {
    const c = calls.get("call_2")!;
    expect(c.category).toBe("auto-rejected");
    expect(c.action).toBe("reject");
    expect(c.resolved_by).toBe("policy");
  });

  it("classifies a paused call resolved as approve by a human as escalated", () => {
    const c = calls.get("call_3")!;
    expect(c.category).toBe("escalated");
    expect(c.action).toBe("approve");
    expect(c.resolved_by).toBe("user_mcp");
    expect(c.severity).toBe("medium");
    expect(c.default_action).toBe("approve");
  });

  it("classifies a paused call resolved as defer as deferred, and carries output-provided timing", () => {
    const c = calls.get("call_4")!;
    expect(c.category).toBe("deferred");
    expect(c.action).toBe("defer");
    expect(c.resolved_by).toBe("user_mcp");
    expect(c.output_provided_at).toBe(at(120));
  });

  it("classifies a paused call with no resolution yet as pending", () => {
    const c = calls.get("call_5")!;
    expect(c.category).toBe("pending");
    expect(c.action).toBeUndefined();
    expect(c.severity).toBe("low");
  });

  it("carries tool_call_result is_error onto the record", () => {
    expect(calls.get("call_1")!.is_error).toBe(false);
  });
});

describe("buildReportCounts", () => {
  const counts = buildReportCounts(buildFixtureEvents());

  it("counts turns and tool calls independently", () => {
    expect(counts.turns).toBe(2);
    expect(counts.tool_calls).toBe(5);
  });

  it("counts decisions as the number of distinct call_ids with decision info", () => {
    expect(counts.decisions).toBe(5);
  });

  it("breaks decisions down into the five categories, summing to the total", () => {
    expect(counts.auto_approved).toBe(1);
    expect(counts.auto_rejected).toBe(1);
    expect(counts.escalated).toBe(1);
    expect(counts.deferred).toBe(1);
    expect(counts.pending).toBe(1);
    expect(
      counts.auto_approved + counts.auto_rejected + counts.escalated + counts.deferred + counts.pending
    ).toBe(counts.decisions);
  });
});

describe("buildReportSummary", () => {
  it("returns null when state is null", () => {
    expect(buildReportSummary(null, [], NOW_MS)).toBe(null);
  });

  it("derives ended_at, duration, exit_reason and exit_code from session_stopped", () => {
    const events = buildFixtureEvents();
    const summary = buildReportSummary(baseState(), events, NOW_MS)!;
    expect(summary.ended_at).toBe(at(127 + 1200));
    expect(summary.duration_is_ongoing).toBe(false);
    expect(summary.duration_seconds).toBe(127 + 1200);
    expect(summary.exit_reason).toBe("stop_session");
    expect(summary.exit_code).toBe(0);
  });

  it("falls back to state exit_reason/exit_code and a running duration when the session hasn't stopped", () => {
    const events = buildFixtureEvents().filter((e) => e.kind !== "session_stopped");
    const state = baseState({ exit_reason: null, exit_code: null, status: "running" });
    const summary = buildReportSummary(state, events, NOW_MS)!;
    expect(summary.ended_at).toBeUndefined();
    expect(summary.duration_is_ongoing).toBe(true);
    expect(summary.duration_seconds).toBe(Math.round((NOW_MS - T0) / 1000));
    expect(summary.exit_reason).toBeNull();
  });

  it("includes alias only when set on state", () => {
    const withAlias = buildReportSummary(baseState({ alias: "reviewer" }), [], NOW_MS)!;
    expect(withAlias.alias).toBe("reviewer");
    const without = buildReportSummary(baseState(), [], NOW_MS)!;
    expect(without.alias).toBeUndefined();
  });

  it("labels a bypass policy", () => {
    const summary = buildReportSummary(baseState({ policy: "bypass" }), [], NOW_MS)!;
    expect(summary.policy_label).toBe("bypass");
  });

  it("carries counts through from buildReportCounts", () => {
    const events = buildFixtureEvents();
    const summary = buildReportSummary(baseState(), events, NOW_MS)!;
    expect(summary.counts).toEqual(buildReportCounts(events));
  });
});

describe("renderReportHeader", () => {
  const events = buildFixtureEvents();
  const summary = buildReportSummary(baseState({ alias: "reviewer", model: "claude-x" }), events, NOW_MS)!;
  const header = renderReportHeader(summary);

  it("includes the session id, alias, cwd, and model", () => {
    expect(header).toContain(summary.session_id);
    expect(header).toContain("reviewer");
    expect(header).toContain("/home/ren/Workspace/project");
    expect(header).toContain("claude-x");
  });

  it("includes started/ended timestamps, duration, and exit reason", () => {
    expect(header).toContain(summary.started_at);
    expect(header).toContain(summary.ended_at!);
    expect(header).toContain("Duration:");
    expect(header).toContain("stop_session");
  });

  it("includes turn / tool-call / decision counts with the per-category breakdown", () => {
    expect(header).toContain("Turns:         2");
    expect(header).toContain("Tool calls:    5");
    expect(header).toContain(
      "Decisions:     5 (auto-approved: 1, auto-rejected: 1, deferred: 1, escalated: 1, pending: 1)"
    );
  });

  it("renders '(default)' when model is null", () => {
    const noModel = buildReportSummary(baseState({ model: null }), [], NOW_MS)!;
    expect(renderReportHeader(noModel)).toContain("Model:         (default)");
  });
});

describe("renderTranscript", () => {
  const events = buildFixtureEvents();
  const transcript = renderTranscript(events, { idleAfterSeconds: 600 });

  it("renders session lifecycle markers", () => {
    expect(transcript).toContain("SESSION started");
    expect(transcript).toContain("SESSION stopped (reason: stop_session, exit_code: 0)");
  });

  it("renders user turns and assistant text", () => {
    expect(transcript).toContain('USER turn_1: "please fix the bug"');
    expect(transcript).toContain("ASSISTANT turn_1: Let me look at the file.");
  });

  it("renders an auto-approved tool call", () => {
    expect(transcript).toMatch(/TOOL_CALL turn_1 Read "src\/foo\.ts" → auto-approved \(rule: auto_approve: reads\)/);
  });

  it("renders an auto-rejected tool call", () => {
    expect(transcript).toMatch(/TOOL_CALL turn_1 Bash "rm -rf \/tmp\/x" → auto-rejected \(rule: auto_reject: rm -rf\)/);
  });

  it("renders an escalation resolved by a human, including how the pause was resolved", () => {
    expect(transcript).toContain("escalated (severity: medium, default: approve)");
    expect(transcript).toContain('resolved: approve (by a human, via MCP, reason: "approved via CLI")');
  });

  it("renders a deferred call resolved by a human, including relayed output", () => {
    expect(transcript).toContain("escalated (severity: high, default: defer)");
    expect(transcript).toContain('resolved: defer (by a human, via MCP, reason: "deferred via CLI")');
    expect(transcript).toContain(`output provided at ${at(120)}`);
  });

  it("renders a still-pending escalation distinctly from a resolved one", () => {
    expect(transcript).toContain("escalated (severity: low, default: reject) → still pending");
  });

  it("surfaces sentinel outcomes on turn completion", () => {
    expect(transcript).toContain("TURN turn_1 completed (stop_reason: end_turn) — sentinel: [NEEDS-INPUT]");
    expect(transcript).toContain("TURN turn_2 completed (stop_reason: end_turn) — sentinel: [DONE]");
  });

  it("inserts an idle-gap marker across the 20-minute silence between turns", () => {
    expect(transcript).toMatch(/idle gap of 20m/);
  });

  it("suppresses idle-gap markers when idleAfterSeconds is 0", () => {
    const noIdle = renderTranscript(events, { idleAfterSeconds: 0 });
    expect(noIdle).not.toMatch(/idle gap/);
  });

  it("suppresses idle-gap markers below the configured threshold", () => {
    const highThreshold = renderTranscript(events, { idleAfterSeconds: 3600 });
    expect(highThreshold).not.toMatch(/idle gap/);
  });

  it("preserves chronological order (session start before session stop, turn_1 before turn_2)", () => {
    const startIdx = transcript.indexOf("SESSION started");
    const turn1Idx = transcript.indexOf("USER turn_1");
    const turn2Idx = transcript.indexOf("USER turn_2");
    const stopIdx = transcript.indexOf("SESSION stopped");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(turn1Idx);
    expect(turn1Idx).toBeLessThan(turn2Idx);
    expect(turn2Idx).toBeLessThan(stopIdx);
  });

  it("renders each tool call exactly once even though decision events reference the same call_id", () => {
    const occurrences = transcript.split("TOOL_CALL turn_1 Edit").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("renderReportText / renderReportJson", () => {
  const events = buildFixtureEvents();
  const summary = buildReportSummary(baseState(), events, NOW_MS)!;

  it("composes a header section and a transcript section", () => {
    const text = renderReportText(summary, events, { idleAfterSeconds: 600 });
    expect(text).toContain("=== Session Report:");
    expect(text).toContain("=== Transcript ===");
    expect(text).toContain("SESSION started");
    expect(text).toContain("Decisions:");
  });

  it("emits a parseable JSON summary with header fields and per-category counts", () => {
    const json = renderReportJson(summary);
    const parsed = JSON.parse(json) as ReportSummary;
    expect(parsed.session_id).toBe(summary.session_id);
    expect(parsed.cwd).toBe(summary.cwd);
    expect(parsed.counts.auto_approved).toBe(1);
    expect(parsed.counts.escalated).toBe(1);
    expect(parsed.counts.deferred).toBe(1);
    expect(parsed.counts.auto_rejected).toBe(1);
    expect(parsed.counts.pending).toBe(1);
  });
});

describe("parseReportArgs", () => {
  it("requires a session id", () => {
    const p = parseReportArgs([]);
    expect(p.ok).toBe(false);
  });

  it("accepts a session id with no flags", () => {
    const p = parseReportArgs(["sess_abc"]);
    expect(p).toEqual({ ok: true, help: false, sessionId: "sess_abc", json: false, idleAfterSeconds: 600 });
  });

  it("parses --json", () => {
    const p = parseReportArgs(["sess_abc", "--json"]);
    expect(p.ok).toBe(true);
    expect((p as any).json).toBe(true);
  });

  it("parses --idle-after", () => {
    const p = parseReportArgs(["sess_abc", "--idle-after", "30"]);
    expect(p.ok).toBe(true);
    expect((p as any).idleAfterSeconds).toBe(30);
  });

  it("rejects a non-numeric --idle-after", () => {
    const p = parseReportArgs(["sess_abc", "--idle-after", "soon"]);
    expect(p.ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    const p = parseReportArgs(["sess_abc", "--bogus"]);
    expect(p.ok).toBe(false);
  });

  it("rejects more than one session id", () => {
    const p = parseReportArgs(["sess_abc", "sess_def"]);
    expect(p.ok).toBe(false);
  });

  it("recognizes --help", () => {
    const p = parseReportArgs(["--help"]);
    expect(p).toEqual({ ok: true, help: true });
  });
});

describe("cmdReport end-to-end (tmp CLAW_DRIVE_HOME, no subprocess)", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "claw-drive-report-"));
    origHome = process.env.CLAW_DRIVE_HOME;
    process.env.CLAW_DRIVE_HOME = tmpHome;
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.CLAW_DRIVE_HOME;
    else process.env.CLAW_DRIVE_HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  async function setupSession(sessionId: string, state: SessionState, events: Event[]): Promise<void> {
    const sessDir = path.join(tmpHome, "sessions", sessionId);
    await fs.mkdir(sessDir, { recursive: true });
    await writeState(path.join(sessDir, "state.json"), state);
    for (const ev of events) {
      await appendEvent(path.join(sessDir, "events.jsonl"), ev);
    }
  }

  async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; captured: string }> {
    const chunks: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      chunks.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
    };
    try {
      const code = await fn();
      return { code, captured: chunks.join("") };
    } finally {
      console.log = origLog;
    }
  }

  it("renders a full human report for a dead (stopped) session", async () => {
    const sessionId = "sess_deadreport001";
    await setupSession(
      sessionId,
      baseState({ session_id: sessionId, status: "stopped", runner_pid: null, exit_reason: "stop_session", exit_code: 0 }),
      buildFixtureEvents()
    );
    const { code, captured } = await captureStdout(() => cmdReport([sessionId]));
    expect(code).toBe(0);
    expect(captured).toContain(sessionId);
    expect(captured).toContain("=== Transcript ===");
    expect(captured).toContain("escalated");
    expect(captured).toContain("sentinel: [DONE]");
  });

  it("--json emits a machine-readable summary only", async () => {
    const sessionId = "sess_deadreport002";
    await setupSession(
      sessionId,
      baseState({ session_id: sessionId, status: "stopped", runner_pid: null }),
      buildFixtureEvents()
    );
    const { code, captured } = await captureStdout(() => cmdReport([sessionId, "--json"]));
    expect(code).toBe(0);
    const parsed = JSON.parse(captured);
    expect(parsed.session_id).toBe(sessionId);
    expect(parsed.counts.escalated).toBe(1);
    // --json must not include the prose transcript.
    expect(captured).not.toContain("=== Transcript ===");
  });

  it("works for a live session (runner_pid alive) exactly as it does for a dead one", async () => {
    const sessionId = "sess_livereport003";
    await setupSession(
      sessionId,
      baseState({ session_id: sessionId, status: "running", runner_pid: process.pid }),
      buildFixtureEvents().filter((e) => e.kind !== "session_stopped")
    );
    const { code, captured } = await captureStdout(() => cmdReport([sessionId]));
    expect(code).toBe(0);
    expect(captured).toContain("Ended:         (still running)");
  });

  it("errors on an unknown session without writing anything", async () => {
    const { code, captured } = await captureStdout(() => cmdReport(["sess_doesnotexist00"]));
    expect(code).not.toBe(0);
    expect(captured).toBe("");
  });

  it("never touches events.jsonl or state.json (read-only)", async () => {
    const sessionId = "sess_readonlycheck04";
    const state = baseState({ session_id: sessionId, status: "stopped", runner_pid: null });
    await setupSession(sessionId, state, buildFixtureEvents());
    const statePathOnDisk = path.join(tmpHome, "sessions", sessionId, "state.json");
    const eventsPathOnDisk = path.join(tmpHome, "sessions", sessionId, "events.jsonl");
    const beforeState = await fs.readFile(statePathOnDisk, "utf-8");
    const beforeEvents = await fs.readFile(eventsPathOnDisk, "utf-8");
    const beforeStateMtime = (await fs.stat(statePathOnDisk)).mtimeMs;
    const beforeEventsMtime = (await fs.stat(eventsPathOnDisk)).mtimeMs;

    await captureStdout(() => cmdReport([sessionId, "--json"]));

    const afterState = await fs.readFile(statePathOnDisk, "utf-8");
    const afterEvents = await fs.readFile(eventsPathOnDisk, "utf-8");
    expect(afterState).toBe(beforeState);
    expect(afterEvents).toBe(beforeEvents);
    expect((await fs.stat(statePathOnDisk)).mtimeMs).toBe(beforeStateMtime);
    expect((await fs.stat(eventsPathOnDisk)).mtimeMs).toBe(beforeEventsMtime);
    // No control socket should have been created/touched by report.
    const socketPathOnDisk = path.join(tmpHome, "sessions", sessionId, "control.sock");
    await expect(fs.access(socketPathOnDisk)).rejects.toThrow();
  });
});
