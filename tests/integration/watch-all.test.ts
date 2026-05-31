import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const binPath = path.resolve("bin/claw-drive");

let root = "";
let watchProc: ChildProcess | null = null;

afterEach(async () => {
  if (watchProc && watchProc.exitCode === null) watchProc.kill("SIGKILL");
  watchProc = null;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

function stateJson(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: id,
    status: "running",
    cwd: "/tmp",
    policy: "bypass",
    decision_timeout_seconds: 600,
    model: null,
    runner_pid: process.pid, // alive from the child's perspective
    started_at: "2026-05-31T00:00:00Z",
    last_event_at: null,
    turns: 0,
    exit_code: null,
    exit_reason: null,
    ...over,
  });
}

async function writeSession(id: string, events: object[]): Promise<void> {
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), stateJson(id));
  const body = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  await fs.writeFile(path.join(dir, "events.jsonl"), body);
}

async function appendEvent(id: string, ev: object): Promise<void> {
  await fs.appendFile(path.join(root, "sessions", id, "events.jsonl"), JSON.stringify(ev) + "\n");
}

function startWatchAll(): { proc: ChildProcess; lines: string[] } {
  const env = { ...process.env, CLAW_DRIVE_HOME: root };
  const proc = spawn(binPath, ["watch", "--all", "--replay"], { env });
  const lines: string[] = [];
  proc.stdout!.on("data", (c: Buffer) => {
    for (const l of c.toString("utf-8").split("\n").filter(Boolean)) lines.push(l);
  });
  return { proc, lines };
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

function parsed(lines: string[]): Array<Record<string, any>> {
  return lines.map((l) => JSON.parse(l));
}

describe("claw-drive watch --all (integration)", () => {
  it("merges live sessions into one session_id-tagged stream with independent per-session filtering", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cd40a-"));
    await writeSession("sess_aaa01", [
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "a1", text: "a done\n[DONE]" },
      { seq: 2, at: "t", kind: "turn_completed", turn_id: "a1", stop_reason: "success" },
    ]);
    await writeSession("sess_bbb01", [
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "b1", text: "b working" },
      { seq: 2, at: "t", kind: "turn_completed", turn_id: "b1", stop_reason: "success" }, // no token → dropped
      { seq: 3, at: "t", kind: "assistant_text", turn_id: "b2", text: "b ready\n[NEEDS-INPUT]" },
      { seq: 4, at: "t", kind: "turn_completed", turn_id: "b2", stop_reason: "success" }, // token → surfaces
    ]);

    const { proc, lines } = startWatchAll();
    watchProc = proc;

    const ok = await waitFor(
      () =>
        parsed(lines).some((p) => p.session_id === "sess_aaa01" && p.kind === "turn_completed") &&
        parsed(lines).some((p) => p.session_id === "sess_bbb01" && p.turn_id === "b2")
    );
    expect(ok).toBe(true);

    const ps = parsed(lines);
    for (const p of ps) expect(typeof p.session_id).toBe("string"); // every line tagged
    expect(ps.some((p) => p.session_id === "sess_aaa01" && p.kind === "turn_completed" && p.turn_id === "a1")).toBe(true);
    expect(ps.some((p) => p.session_id === "sess_bbb01" && p.kind === "turn_completed" && p.turn_id === "b2")).toBe(true);
    // b1 had no sentinel token → the per-session tokenFilter dropped it
    expect(ps.some((p) => p.session_id === "sess_bbb01" && p.kind === "turn_completed" && p.turn_id === "b1")).toBe(false);
  }, 25000);

  it("a session created after start joins the stream via the rescan (dynamic membership)", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cd40b-"));
    await writeSession("sess_aaa01", [
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "a1", text: "a\n[DONE]" },
      { seq: 2, at: "t", kind: "turn_completed", turn_id: "a1", stop_reason: "success" },
    ]);

    const { proc, lines } = startWatchAll();
    watchProc = proc;
    expect(await waitFor(() => parsed(lines).some((p) => p.session_id === "sess_aaa01"))).toBe(true);

    // Create a brand-new session after watch --all is already running.
    await writeSession("sess_ccc01", [
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "c1", text: "c\n[NEEDS-INPUT]" },
      { seq: 2, at: "t", kind: "turn_completed", turn_id: "c1", stop_reason: "success" },
    ]);

    const joined = await waitFor(() => parsed(lines).some((p) => p.session_id === "sess_ccc01"), 8000);
    expect(joined).toBe(true);
  }, 25000);

  it("a stopping session closes only its tail; the stream continues until SIGINT (exit 0)", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cd40c-"));
    await writeSession("sess_aaa01", [
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "a1", text: "a\n[DONE]" },
      { seq: 2, at: "t", kind: "turn_completed", turn_id: "a1", stop_reason: "success" },
    ]);
    await writeSession("sess_bbb01", [
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "b1", text: "b\n[DONE]" },
      { seq: 2, at: "t", kind: "turn_completed", turn_id: "b1", stop_reason: "success" },
    ]);

    const { proc, lines } = startWatchAll();
    watchProc = proc;
    expect(
      await waitFor(
        () =>
          parsed(lines).some((p) => p.session_id === "sess_aaa01") &&
          parsed(lines).some((p) => p.session_id === "sess_bbb01")
      )
    ).toBe(true);

    // Stop session B.
    await appendEvent("sess_bbb01", { seq: 99, at: "t", kind: "session_stopped", reason: "done", exit_code: 0 });
    expect(
      await waitFor(() => parsed(lines).some((p) => p.session_id === "sess_bbb01" && p.kind === "session_stopped"))
    ).toBe(true);

    // The merged stream is still alive: a new surfacing event on A must appear.
    await appendEvent("sess_aaa01", { seq: 50, at: "t", kind: "assistant_text", turn_id: "a2", text: "more\n[DONE]" });
    await appendEvent("sess_aaa01", { seq: 51, at: "t", kind: "turn_completed", turn_id: "a2", stop_reason: "success" });
    expect(
      await waitFor(() => parsed(lines).some((p) => p.session_id === "sess_aaa01" && p.turn_id === "a2"))
    ).toBe(true);
    expect(proc.exitCode).toBeNull(); // not exited — one session stopping doesn't end --all

    // SIGINT terminates the whole stream cleanly.
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
      proc.kill("SIGINT");
    });
    expect(exitCode).toBe(0);
  }, 30000);
});
