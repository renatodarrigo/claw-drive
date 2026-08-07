import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recoverSession } from "../../src/lib/recover.js";
import { cmdRecover } from "../../src/cli/commands/recover.js";
import { sessionDir, statePath, crashHandoverPath } from "../../src/lib/paths.js";
import { readState } from "../../src/lib/state.js";

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

describe("cmdRecover arg parsing", () => {
  it("errors when --model is missing its value (final arg)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await cmdRecover(["sess_20200101T000000_aaaaaa", "--model"]);
      expect(code).toBe(2);
      expect(spy.mock.calls.flat().join("\n")).toMatch(/--model/);
    } finally {
      spy.mockRestore();
    }
  });
  it("errors when --model would swallow a following flag", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await cmdRecover(["sess_20200101T000000_aaaaaa", "--model", "--no-start"]);
      expect(code).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("recoverSession successor scaffolding (stub runner bin)", () => {
  let stubDir: string;
  let prevBin: string | undefined;
  beforeEach(async () => {
    prevBin = process.env.CLAW_DRIVE_BIN;
    stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "cd11-recover-stub-"));
    const stub = path.join(stubDir, "fake-runner");
    await fs.writeFile(stub, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', {
      mode: 0o755,
    });
    await fs.chmod(stub, 0o755);
    process.env.CLAW_DRIVE_BIN = stub;
  });
  afterEach(async () => {
    if (prevBin === undefined) delete process.env.CLAW_DRIVE_BIN;
    else process.env.CLAW_DRIVE_BIN = prevBin;
    await fs.rm(stubDir, { recursive: true, force: true });
  });

  it("threads the predecessor's mcp.json mcpServers into the successor", async () => {
    const id = "sess_20200101T000000_eeeeee";
    await deadSession(id, { cost_usd: 4.5 });
    await fs.writeFile(crashHandoverPath(id), "## Current objective\nresume");
    await fs.writeFile(
      path.join(sessionDir(id), "mcp.json"),
      JSON.stringify({ mcpServers: { extra: { command: "x" } } })
    );
    const r = await recoverSession({ sessionId: id });
    expect(r.ok).toBe(true);
    const newId = (r as { result: { new_session_id: string } }).result.new_session_id;
    const mcp = JSON.parse(
      await fs.readFile(path.join(sessionDir(newId), "mcp.json"), "utf-8")
    ) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers).toMatchObject({ extra: { command: "x" } });
    const succ = await readState(statePath(newId));
    expect(succ?.cost_usd_base).toBeCloseTo(4.5, 10);
  });

  it("carries the predecessor's own cost_usd_base as the successor's base when the predecessor never stamped a cost_usd", async () => {
    const id = "sess_20200101T000000_gggggg";
    await deadSession(id, { cost_usd_base: 3.0 });
    await fs.writeFile(crashHandoverPath(id), "## Current objective\nresume");
    const r = await recoverSession({ sessionId: id });
    expect(r.ok).toBe(true);
    const newId = (r as { result: { new_session_id: string } }).result.new_session_id;
    const succ = await readState(statePath(newId));
    expect(succ?.cost_usd_base).toBeCloseTo(3.0, 10);
  });

  it("omits cost_usd_base on the successor when the predecessor never stamped a cost_usd", async () => {
    const id = "sess_20200101T000000_ffffff";
    await deadSession(id);
    await fs.writeFile(crashHandoverPath(id), "## Current objective\nresume");
    const r = await recoverSession({ sessionId: id });
    expect(r.ok).toBe(true);
    const newId = (r as { result: { new_session_id: string } }).result.new_session_id;
    const succ = await readState(statePath(newId));
    expect(succ?.cost_usd_base).toBeUndefined();
  });

  it("a recovered successor of a born-with-base turnless predecessor carries the base forward and is itself born with cost_usd (stable fixed point)", async () => {
    const id = "sess_20260101T000000_chain1";
    await deadSession(id, { cost_usd_base: 3.0, cost_usd: 3.0 });
    await fs.writeFile(crashHandoverPath(id), "## Current objective\nresume");
    const out = await recoverSession({ sessionId: id });
    expect(out.ok).toBe(true);
    const succId = (out as { result: { new_session_id: string } }).result.new_session_id;
    const succ = await readState(statePath(succId));
    expect(succ?.cost_usd_base).toBeCloseTo(3.0, 10);
    expect(succ?.cost_usd).toBeCloseTo(3.0, 10);
  });
});

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
