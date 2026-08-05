import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recoverSession } from "../../src/lib/recover.js";
import { sessionDir, statePath, crashHandoverPath } from "../../src/lib/paths.js";

let home: string;
let savedEnv: string | undefined;
beforeEach(async () => {
  savedEnv = process.env.CLAW_DRIVE_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd11-recover-"));
  process.env.CLAW_DRIVE_HOME = home;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

async function deadSession(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(sessionDir(id), { recursive: true });
  await fs.writeFile(
    statePath(id),
    JSON.stringify({
      session_id: id, status: "stopped", cwd: "/tmp/x", policy: "bypass",
      decision_timeout_seconds: 3600, model: null, runner_pid: null,
      started_at: "2020-01-01T00:00:00.000Z", last_event_at: null,
      turns: 1, exit_code: 137, exit_reason: "crashed:137", ...extra,
    })
  );
}

describe("recoverSession error paths (no claude spawned)", () => {
  it("SESSION_NOT_FOUND for a missing session", async () => {
    const r = await recoverSession({ sessionId: "sess_20200101T000000_zzzzzz" });
    expect(r).toMatchObject({ ok: false, error: "SESSION_NOT_FOUND" });
  });

  it("SESSION_LIVE for a session whose runner pid is alive", async () => {
    await deadSession("sess_20200101T000000_aaaaaa", {
      status: "running",
      runner_pid: process.pid, // this test process — definitely alive
    });
    const r = await recoverSession({ sessionId: "sess_20200101T000000_aaaaaa" });
    expect(r).toMatchObject({ ok: false, error: "SESSION_LIVE" });
  });

  it("ALREADY_RECOVERED when rotated_to is set", async () => {
    await deadSession("sess_20200101T000000_bbbbbb", { rotated_to: "sess_x" });
    const r = await recoverSession({ sessionId: "sess_20200101T000000_bbbbbb" });
    expect(r).toMatchObject({ ok: false, error: "ALREADY_RECOVERED" });
  });

  it("NO_RECORD when there is no crash-handover and no events.jsonl", async () => {
    await deadSession("sess_20200101T000000_cccccc");
    const r = await recoverSession({ sessionId: "sess_20200101T000000_cccccc" });
    expect(r).toMatchObject({ ok: false, error: "NO_RECORD" });
  });

  it("no_start with a pre-existing crash-handover returns it without distilling", async () => {
    await deadSession("sess_20200101T000000_dddddd");
    await fs.writeFile(
      crashHandoverPath("sess_20200101T000000_dddddd"),
      "## Current objective\nresume step 4"
    );
    const r = await recoverSession({ sessionId: "sess_20200101T000000_dddddd", noStart: true });
    expect(r).toMatchObject({ ok: true });
    expect((r as { result: { handover_path: string; distilled: boolean } }).result).toMatchObject({
      handover_path: crashHandoverPath("sess_20200101T000000_dddddd"),
      distilled: false,
    });
  });
});
