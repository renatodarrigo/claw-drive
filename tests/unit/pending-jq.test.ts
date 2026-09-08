import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { cmdPending } from "../../src/cli/commands/pending.js";
import { writeState, type SessionState } from "../../src/lib/state.js";
import { appendEvent, type Event } from "../../src/lib/events.js";

let tmpHome: string;
let origHome: string | undefined;
let origFleet: string | undefined;
let origSid: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "claw-drive-pending-jq-"));
  origHome = process.env.CLAW_DRIVE_HOME;
  process.env.CLAW_DRIVE_HOME = tmpHome;
  // Fleets: cmdPending now reaches resolveActingFleet through process.env on
  // every call. Pin CLAW_DRIVE_FLEET / CLAUDE_CODE_SESSION_ID for the whole
  // file so the pre-fleet suites below are not at the mercy of whatever the
  // ambient environment (e.g. the Claude Code session driving this process)
  // happens to export.
  origFleet = process.env.CLAW_DRIVE_FLEET;
  origSid = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAW_DRIVE_FLEET;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = origHome;
  if (origFleet === undefined) delete process.env.CLAW_DRIVE_FLEET;
  else process.env.CLAW_DRIVE_FLEET = origFleet;
  if (origSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = origSid;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function setupSession(
  sessionId: string,
  events: Event[],
  overrides: Partial<SessionState> = {}
): Promise<void> {
  const sessDir = path.join(tmpHome, "sessions", sessionId);
  await fs.mkdir(sessDir, { recursive: true });
  const state: SessionState = {
    session_id: sessionId,
    status: "ready",
    cwd: "/tmp",
    policy: "bypass",
    decision_timeout_seconds: 300,
    model: null,
    runner_pid: process.pid,
    started_at: "2026-04-24T00:00:00Z",
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
    ...overrides,
  };
  await writeState(path.join(sessDir, "state.json"), state);
  for (const ev of events) {
    await appendEvent(path.join(sessDir, "events.jsonl"), ev);
  }
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; captured: string }> {
  // cmdPending emits via console.log. We monkey-patch console.log rather than
  // process.stdout.write because vitest wraps stdout and silently swallows
  // direct process.stdout.write overrides in test scope.
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

function makeDecisionEvent(command: string): Event {
  return {
    seq: 1,
    at: "2026-04-24T00:00:00Z",
    turn_id: "turn_1",
    kind: "tool_decision_required",
    call_id: "c1",
    tool: "Bash",
    args: { command },
    severity: "high",
    default_action: "defer",
    default_at: "2026-04-24T00:01:00Z",
  } as Event;
}

describe("cmdPending output is jq-parseable for tricky byte ranges", () => {
  const byteSamples: Array<{ name: string; command: string }> = [
    {
      name: "control chars 0x01–0x1f",
      command: Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join(""),
    },
    { name: "tab/CR/LF mix", command: "\t\r\n" },
    { name: "quotes and backslashes", command: 'a"b\\c\'d' },
    { name: "multibyte UTF-8", command: "é 日 🚀" },
    { name: "shell string with embedded newlines", command: "bash -c 'foo\nbar'" },
    { name: "DEL (0x7f)", command: "\x7f" },
  ];

  for (const { name, command } of byteSamples) {
    it(`pipes through jq cleanly for: ${name}`, async () => {
      const sessionId = "sess_test";
      await setupSession(sessionId, [makeDecisionEvent(command)]);

      const { code, captured } = await captureStdout(() => cmdPending([sessionId]));
      expect(code).toBe(0);
      expect(captured.length).toBeGreaterThan(0);

      const jq = spawnSync("jq", ["-c", "."], { input: captured });
      expect(jq.status, `jq stderr: ${jq.stderr.toString()}`).toBe(0);

      const parsed = JSON.parse(jq.stdout.toString().trim());
      expect(parsed.args.command).toBe(command);
    });
  }
});

describe("cmdPending alias/generation tag shape (CD-1: machine-readable fields are additive-only)", () => {
  it("carries the bare alias plus an additive generation field — never a composed display string", async () => {
    const sessionId = "sess_aliased";
    await setupSession(sessionId, [makeDecisionEvent("echo hi")], {
      alias: "reviewer",
      generation: 2,
    });

    const { code, captured } = await captureStdout(() => cmdPending([sessionId]));
    expect(code).toBe(0);
    const parsed = JSON.parse(captured.trim());
    expect(parsed.alias).toBe("reviewer");
    expect(parsed.generation).toBe(2);
  });

  it("omits both alias and generation when the session has neither", async () => {
    const sessionId = "sess_bare";
    await setupSession(sessionId, [makeDecisionEvent("echo hi")]);

    const { captured } = await captureStdout(() => cmdPending([sessionId]));
    const parsed = JSON.parse(captured.trim());
    expect(parsed).not.toHaveProperty("alias");
    expect(parsed).not.toHaveProperty("generation");
  });

  it("carries alias without generation when the session isn't part of a rotation lineage", async () => {
    const sessionId = "sess_alias_only";
    await setupSession(sessionId, [makeDecisionEvent("echo hi")], { alias: "scout" });

    const { captured } = await captureStdout(() => cmdPending([sessionId]));
    const parsed = JSON.parse(captured.trim());
    expect(parsed.alias).toBe("scout");
    expect(parsed).not.toHaveProperty("generation");
  });
});

describe("cmdPending — fleet view", () => {
  let savedFleet: string | undefined;
  let savedSid: string | undefined;
  beforeEach(() => {
    savedFleet = process.env.CLAW_DRIVE_FLEET;
    savedSid = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAW_DRIVE_FLEET = "team-a";
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
  afterEach(() => {
    if (savedFleet === undefined) delete process.env.CLAW_DRIVE_FLEET;
    else process.env.CLAW_DRIVE_FLEET = savedFleet;
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
  });

  it("no-arg form lists own + untagged pending calls, tags lines with fleet, hides the other fleet", async () => {
    await setupSession("sess_own", [makeDecisionEvent("ls own")], { fleet: "team-a" });
    await setupSession("sess_other", [makeDecisionEvent("ls other")], { fleet: "team-b" });
    await setupSession("sess_free", [makeDecisionEvent("ls free")]);
    const { code, captured } = await captureStdout(() => cmdPending([]));
    expect(code).toBe(0);
    const lines = captured.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.session_id)).toEqual(["sess_free", "sess_own"]);
    expect(lines[1].fleet).toBe("team-a");
    expect(lines[0]).not.toHaveProperty("fleet");
  });

  it("--all-fleets includes the other fleet", async () => {
    await setupSession("sess_other", [makeDecisionEvent("ls other")], { fleet: "team-b" });
    const { captured } = await captureStdout(() => cmdPending(["--all-fleets"]));
    expect(JSON.parse(captured.trim()).fleet).toBe("team-b");
  });

  it("an explicit target resolves across fleets, but rejects the fleet flags", async () => {
    await setupSession("sess_other", [makeDecisionEvent("ls other")], { fleet: "team-b" });
    const { code, captured } = await captureStdout(() => cmdPending(["sess_other"]));
    expect(code).toBe(0);
    expect(JSON.parse(captured.trim()).session_id).toBe("sess_other");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await cmdPending(["sess_other", "--all-fleets"])).toBe(2);
      expect(errSpy.mock.calls.flat().join("\n")).toContain("--fleet/--all-fleets apply only to the fleet view");
    } finally {
      errSpy.mockRestore();
    }
  });
});
