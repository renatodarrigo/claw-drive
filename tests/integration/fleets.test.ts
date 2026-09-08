/**
 * Fleets: through-the-binary scoping (status / sessions / send --all).
 *
 * Fixture sessions, no live claude — the CLI runs as a real child process
 * against synthetic state.json files, never a spawned Claude process. Two
 * of the three fixtures carry a `fleet` tag, standing in for what
 * `start --fleet <tag>` stamps on a real session; the third is left
 * untagged (unowned).
 *
 * Env hygiene: tests/helpers/tmp-session.ts's usual
 * `{ ...process.env, CLAW_DRIVE_HOME }` would let a spawned claw-drive
 * inherit this test runner's own CLAUDE_CODE_SESSION_ID (and any ambient
 * CLAW_DRIVE_FLEET). Every invocation below builds its own env via env()
 * instead, which always explicitly sets or deletes both identity
 * variables — never ambient — so the acting fleet a given assertion relies
 * on is exactly the one that call chose.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCliBlocking } from "../helpers/tmp-session.js";

const binPath = path.resolve("bin/claw-drive");
let root = "";

function stateJson(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: id, status: "running", cwd: "/tmp", policy: "bypass",
    decision_timeout_seconds: 600, model: null, runner_pid: process.pid,
    started_at: "2026-09-02T00:00:00Z", last_event_at: null, turns: 0,
    exit_code: null, exit_reason: null, ...over,
  });
}

async function writeSession(id: string, over: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), stateJson(id, over));
  await fs.writeFile(path.join(dir, "events.jsonl"), "");
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Pin both identity sources: the vitest process inherits CLAUDE_CODE_SESSION_ID from Claude Code.
  const e: NodeJS.ProcessEnv = { ...process.env, CLAW_DRIVE_HOME: root, CLAW_DRIVE_FLEET: "team-a" };
  delete e.CLAUDE_CODE_SESSION_ID;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd-fleets-it-"));
  await writeSession("sess_own000000000001", { fleet: "team-a", alias: "reviewer" });
  await writeSession("sess_other0000000001", { fleet: "team-b" });
  await writeSession("sess_free000000000001");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  root = "";
});

describe("fleets (integration, through the binary)", () => {
  it("status --json is scoped and counts the hidden fleet; --all-fleets widens", async () => {
    const scoped = await runCliBlocking(binPath, env(), ["status", "--json"]);
    expect(scoped.code).toBe(0);
    const body = JSON.parse(scoped.stdout) as { sessions: Array<{ session_id: string; fleet?: string }>; hidden_in_other_fleets?: number };
    expect(body.sessions.map((s) => s.session_id)).toEqual(["sess_free000000000001", "sess_own000000000001"]);
    expect(body.sessions[1].fleet).toBe("team-a");
    expect(body.hidden_in_other_fleets).toBe(1);
    const widened = await runCliBlocking(binPath, env(), ["status", "--json", "--all-fleets"]);
    expect(JSON.parse(widened.stdout).sessions).toHaveLength(3);
  });

  it("sessions prints the hint on stderr and a FLEET column under --all-fleets", async () => {
    const scoped = await runCliBlocking(binPath, env(), ["sessions"]);
    expect(scoped.stdout.trim().split("\n")).toHaveLength(3);
    expect(scoped.stderr.trim()).toBe("(1 session in other fleets hidden; --all-fleets shows them)");
    const widened = await runCliBlocking(binPath, env(), ["sessions", "--all-fleets"]);
    expect(widened.stdout.split("\n")[0].endsWith("\tFLEET")).toBe(true);
  });

  it("the default identity comes from CLAUDE_CODE_SESSION_ID when CLAW_DRIVE_FLEET is unset", async () => {
    const asOther = await runCliBlocking(binPath, env({ CLAW_DRIVE_FLEET: undefined, CLAUDE_CODE_SESSION_ID: "team-b" }), ["status", "--json"]);
    const body = JSON.parse(asOther.stdout) as { sessions: Array<{ session_id: string }> };
    expect(body.sessions.map((s) => s.session_id)).toEqual(["sess_free000000000001", "sess_other0000000001"]);
  });

  it("send --all reaches own + untagged members only, one line each, and exits 1 when their runners are unreachable", async () => {
    const r = await runCliBlocking(binPath, env(), ["send", "--all", "wrap up"]);
    expect(r.code).toBe(1); // fixture sessions have no runner socket → every line is SESSION_UNREACHABLE
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { session_id: string; ok: boolean; error?: string; alias?: string; fleet?: string });
    expect(lines.map((l) => l.session_id)).toEqual(["sess_free000000000001", "sess_own000000000001"]);
    expect(lines.every((l) => l.ok === false && l.error === "SESSION_UNREACHABLE")).toBe(true);
    expect(lines[1]).toMatchObject({ alias: "reviewer", fleet: "team-a" });
    // Stop the untagged session: with it dead, a fleet nobody uses sees no live session at all.
    await fs.writeFile(path.join(root, "sessions", "sess_free000000000001", "state.json"), stateJson("sess_free000000000001", { status: "stopped", runner_pid: null }));
    const empty = await runCliBlocking(binPath, env({ CLAW_DRIVE_FLEET: "team-z" }), ["send", "--all", "wrap up"]);
    expect(empty.code).toBe(2);
    expect(empty.stderr.trim()).toBe("no live sessions in view (2 live in other fleets; --all-fleets broadcasts to them)");
  });

  it("an explicit id resolves across fleets", async () => {
    const r = await runCliBlocking(binPath, env(), ["status", "sess_other0000000001"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Session: sess_other0000000001");
  });
});
