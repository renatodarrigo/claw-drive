import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cmdPrune } from "../../src/cli/commands/prune.js";
import { sessionDir, statePath, crashHandoverPath } from "../../src/lib/paths.js";

let home: string;
let savedEnv: string | undefined;
beforeEach(async () => {
  savedEnv = process.env.CLAW_DRIVE_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd11-prune-"));
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
const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe("prune context-rotation unconsumed-crash-handover guard", () => {
  it("skips a dead session with an unconsumed crash-handover", async () => {
    await deadSession("sess_20200101T000000_aaaaaa");
    await fs.writeFile(crashHandoverPath("sess_20200101T000000_aaaaaa"), "## Current objective\nx");
    await cmdPrune([]);
    expect(await exists(sessionDir("sess_20200101T000000_aaaaaa"))).toBe(true);
  });

  it("prunes when the handover was consumed (rotated_to set)", async () => {
    await deadSession("sess_20200101T000000_bbbbbb", { rotated_to: "sess_x" });
    await fs.writeFile(crashHandoverPath("sess_20200101T000000_bbbbbb"), "x");
    await cmdPrune([]);
    expect(await exists(sessionDir("sess_20200101T000000_bbbbbb"))).toBe(false);
  });

  it("prunes with --force regardless, and prunes plain dead sessions as before", async () => {
    await deadSession("sess_20200101T000000_cccccc");
    await fs.writeFile(crashHandoverPath("sess_20200101T000000_cccccc"), "x");
    await deadSession("sess_20200101T000000_dddddd");
    await cmdPrune(["--force"]);
    expect(await exists(sessionDir("sess_20200101T000000_cccccc"))).toBe(false);
    expect(await exists(sessionDir("sess_20200101T000000_dddddd"))).toBe(false);
  });
});
