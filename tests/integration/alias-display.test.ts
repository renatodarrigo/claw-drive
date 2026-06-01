import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

// CD-51: surface the alias alongside session_id in sessions / status / pending /
// watch --all. Driven against SYNTHETIC state files (runner_pid: process.pid →
// "live" from the child's view) so no real claude is needed — fast + stable.

const binPath = path.resolve("bin/claw-drive");
let root: string;

function stateJson(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: id,
    status: "running",
    cwd: "/tmp",
    policy: "bypass",
    decision_timeout_seconds: 600,
    model: null,
    runner_pid: process.pid,
    started_at: "2026-05-31T00:00:00Z",
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
    ...over,
  });
}

async function writeSession(id: string, over: Record<string, unknown>, events: object[] = []): Promise<void> {
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), stateJson(id, over));
  if (events.length) {
    await fs.writeFile(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(binPath, args, { env: { ...process.env, CLAW_DRIVE_HOME: root } });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd51-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("alias display surfaces (integration, synthetic state)", () => {
  it("sessions shows the alias inline for aliased sessions and not for un-aliased ones", async () => {
    await writeSession("sess_aliased01", { alias: "reviewer" });
    await writeSession("sess_plain0001", {});
    const r = await runCli(["sessions"]);
    expect(r.code).toBe(0);
    const aliasedLine = r.stdout.split("\n").find((l) => l.includes("sess_aliased01"))!;
    const plainLine = r.stdout.split("\n").find((l) => l.includes("sess_plain0001"))!;
    expect(aliasedLine).toContain("(reviewer)");
    expect(plainLine).not.toContain("(");
  }, 20_000);

  it("status --json includes alias when present and omits it when absent", async () => {
    await writeSession("sess_aliased02", { alias: "builder" });
    await writeSession("sess_plain0002", {});
    const r = await runCli(["status", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const aliased = parsed.sessions.find((s: any) => s.session_id === "sess_aliased02");
    const plain = parsed.sessions.find((s: any) => s.session_id === "sess_plain0002");
    expect(aliased.alias).toBe("builder");
    expect("alias" in plain).toBe(false);
  }, 20_000);

  it("status <alias> detail resolves and shows an Alias: line", async () => {
    await writeSession("sess_aliased03", { alias: "qa" });
    const r = await runCli(["status", "qa"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Alias:");
    expect(r.stdout).toContain("qa");
    expect(r.stdout).toContain("sess_aliased03");
  }, 20_000);

  it("pending includes the alias on each decision line for an aliased session", async () => {
    await writeSession(
      "sess_aliased04",
      { alias: "gate" },
      [
        {
          seq: 1,
          at: "t",
          turn_id: "t1",
          kind: "tool_decision_required",
          call_id: "c1",
          tool: "Bash",
          args: { command: "ls" },
          severity: "high",
          default_action: "defer",
          default_at: "t",
        },
      ]
    );
    const r = await runCli(["pending", "sess_aliased04"]);
    expect(r.code).toBe(0);
    const line = r.stdout.split("\n").filter(Boolean)[0];
    const obj = JSON.parse(line);
    expect(obj.session_id).toBe("sess_aliased04");
    expect(obj.alias).toBe("gate");
  }, 20_000);
});
