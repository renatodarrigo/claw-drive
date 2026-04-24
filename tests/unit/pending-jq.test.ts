import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { cmdPending } from "../../src/cli/commands/pending.js";
import { writeState, type SessionState } from "../../src/lib/state.js";
import { appendEvent, type Event } from "../../src/lib/events.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "claw-drive-pending-jq-"));
  origHome = process.env.CLAW_DRIVE_HOME;
  process.env.CLAW_DRIVE_HOME = tmpHome;
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = origHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function setupSession(sessionId: string, events: Event[]): Promise<void> {
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
