import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cmdStatus } from "../../src/cli/commands/status.js";

let home: string;
const ENV_KEYS = ["CLAW_DRIVE_HOME", "CLAW_DRIVE_FLEET", "CLAUDE_CODE_SESSION_ID"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

async function writeSession(id: string, over: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(home, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      session_id: id, status: "running", cwd: "/tmp/x", policy: "bypass",
      decision_timeout_seconds: 3600, model: null, runner_pid: process.pid,
      started_at: "2026-09-02T00:00:00Z", last_event_at: null, turns: 0,
      exit_code: null, exit_reason: null, ...over,
    })
  );
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await cmdStatus(argv);
    return { code, out: log.mock.calls.map((c) => c.join(" ")).join("\n"), err: errSpy.mock.calls.map((c) => c.join(" ")).join("\n") };
  } finally {
    log.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd-status-fleet-"));
  process.env.CLAW_DRIVE_HOME = home;
  process.env.CLAW_DRIVE_FLEET = "team-a";
  delete process.env.CLAUDE_CODE_SESSION_ID;
  await writeSession("sess_own000000000001", { fleet: "team-a" });
  await writeSession("sess_other0000000001", { fleet: "team-b" });
  await writeSession("sess_free000000000001");
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("claw-drive status — fleet view", () => {
  it("lists own + untagged sessions, hides the other fleet, and says so on stderr", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(r.out).toContain("sess_free");
    expect(r.out).toContain("sess_own000000000001");
    expect(r.out).not.toContain("sess_other");
    expect(lines[0]).not.toContain("FLEET");
    expect(r.err).toBe("(1 session in other fleets hidden; --all-fleets shows them)");
  });

  it("--all-fleets shows every session with a FLEET column and no hint", async () => {
    const r = await run(["--all-fleets"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0].endsWith("\tFLEET")).toBe(true);
    expect(lines.find((l) => l.includes("sess_other"))!.endsWith("\tteam-b")).toBe(true);
    expect(lines.find((l) => l.includes("sess_free"))!.endsWith("\t-")).toBe(true);
    expect(r.err).toBe("");
  });

  it("--fleet team-b acts as that fleet", async () => {
    const r = await run(["--fleet", "team-b"]);
    expect(r.out).toContain("sess_other");
    expect(r.out).not.toContain("sess_own");
    expect(r.err).toBe("(1 session in other fleets hidden; --all-fleets shows them)");
  });

  it("--json carries fleet per row and hidden_in_other_fleets, with nothing on stderr", async () => {
    const r = await run(["--json"]);
    const body = JSON.parse(r.out) as { sessions: Array<{ session_id: string; fleet?: string }>; hidden_in_other_fleets?: number };
    expect(body.sessions.map((s) => s.session_id)).toEqual(["sess_free000000000001", "sess_own000000000001"]);
    expect(body.sessions[1].fleet).toBe("team-a");
    expect(body.sessions[0]).not.toHaveProperty("fleet");
    expect(body.hidden_in_other_fleets).toBe(1);
    expect(r.err).toBe("");
    const widened = JSON.parse((await run(["--json", "--all-fleets"])).out) as { hidden_in_other_fleets?: number };
    expect(widened).not.toHaveProperty("hidden_in_other_fleets");
  });

  it("a single-session request by explicit id resolves across fleets", async () => {
    const r = await run(["sess_other0000000001"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Session: sess_other0000000001");
  });

  it("with no identity at all, only the untagged session is in view", async () => {
    delete process.env.CLAW_DRIVE_FLEET;
    const r = await run([]);
    expect(r.out.split("\n")).toHaveLength(2);
    expect(r.out).toContain("sess_free");
    expect(r.err).toBe("(2 sessions in other fleets hidden; --all-fleets shows them)");
  });
});
