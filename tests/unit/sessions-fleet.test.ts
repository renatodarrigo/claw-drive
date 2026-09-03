import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cmdSessions } from "../../src/cli/commands/sessions.js";

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
      started_at: "2026-09-02T00:00:00Z", last_event_at: null, turns: 2,
      exit_code: null, exit_reason: null, ...over,
    })
  );
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await cmdSessions(argv);
    return { code, out: log.mock.calls.map((c) => c.join(" ")).join("\n"), err: errSpy.mock.calls.map((c) => c.join(" ")).join("\n") };
  } finally {
    log.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd-sessions-fleet-"));
  process.env.CLAW_DRIVE_HOME = home;
  process.env.CLAW_DRIVE_FLEET = "team-a";
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("claw-drive sessions — fleet view", () => {
  it("lists own + untagged rows, hides the other fleet, and hints on stderr; rows are byte-identical to before", async () => {
    await writeSession("sess_own", { fleet: "team-a" });
    await writeSession("sess_other", { fleet: "team-b" });
    await writeSession("sess_free");
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "SESSION_ID\tSTATUS\tTURNS\tPENDING\tCWD",
      "sess_free\trunning\t2\t0\t/tmp/x",
      "sess_own\trunning\t2\t0\t/tmp/x",
    ]);
    expect(r.err).toBe("(1 session in other fleets hidden; --all-fleets shows them)");
  });

  it("--all-fleets appends a FLEET column and shows everyone", async () => {
    await writeSession("sess_own", { fleet: "team-a" });
    await writeSession("sess_other", { fleet: "team-b" });
    await writeSession("sess_free");
    const r = await run(["--all-fleets"]);
    expect(r.out.split("\n")).toEqual([
      "SESSION_ID\tSTATUS\tTURNS\tPENDING\tCWD\tFLEET",
      "sess_free\trunning\t2\t0\t/tmp/x\t-",
      "sess_other\trunning\t2\t0\t/tmp/x\tteam-b",
      "sess_own\trunning\t2\t0\t/tmp/x\tteam-a",
    ]);
    expect(r.err).toBe("");
  });

  it("a corrupt state.json is skipped instead of aborting the listing", async () => {
    await writeSession("sess_good");
    await fs.mkdir(path.join(home, "sessions", "sess_bad"), { recursive: true });
    await fs.writeFile(path.join(home, "sessions", "sess_bad", "state.json"), "{nope");
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toHaveLength(2);
  });

  it("a missing sessions directory still prints '(no sessions)'", async () => {
    const r = await run([]);
    expect(r.out).toBe("(no sessions)");
  });

  it("flag errors exit 2", async () => {
    expect((await run(["--fleet"])).code).toBe(2);
    expect((await run(["--fleet", "a", "--all-fleets"])).code).toBe(2);
  });
});
