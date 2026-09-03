import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { startWatchMultiplexer } from "../../src/lib/watch-multiplexer.js";

let root: string;
let prevHome: string | undefined;

const FILTERS = {
  since: 0 as const,
  allowed: null,
  noTokenFilter: false,
  suspectedNeedsInput: true,
  idleAfterSeconds: 0,
};

async function makeSession(id: string, over: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
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
    })
  );
  const events = [
    { seq: 1, at: "t", kind: "turn_started", turn_id: "x", message: "go" },
    { seq: 2, at: "t", kind: "assistant_text", turn_id: "x", text: "done\n[DONE]" },
    { seq: 3, at: "t", kind: "turn_completed", turn_id: "x", stop_reason: "success" },
  ];
  await fs.writeFile(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function seen(lines: string[]): Set<string> {
  return new Set(lines.map((l) => JSON.parse(l).session_id as string));
}

async function waitUntil(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function collect(view: { acting: string | undefined; allFleets: boolean }) {
  const lines: string[] = [];
  const mux = startWatchMultiplexer({ emit: (l) => lines.push(l), filters: FILTERS, view, rescanIntervalMs: 25 });
  return { lines, mux };
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd-mux-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("startWatchMultiplexer — fleet view membership", () => {
  it("tails own-fleet and untagged sessions, never another fleet's", async () => {
    await makeSession("sess_own", { fleet: "A" });
    await makeSession("sess_other", { fleet: "B" });
    await makeSession("sess_free");
    const { lines, mux } = collect({ acting: "A", allFleets: false });
    await waitUntil(() => seen(lines).has("sess_own") && seen(lines).has("sess_free"));
    await new Promise((r) => setTimeout(r, 100)); // several rescans: the other fleet must still be absent
    expect(seen(lines).has("sess_other")).toBe(false);
    mux.close();
    await mux.done;
  });

  it("--all-fleets tails every fleet", async () => {
    await makeSession("sess_own", { fleet: "A" });
    await makeSession("sess_other", { fleet: "B" });
    const { lines, mux } = collect({ acting: "A", allFleets: true });
    await waitUntil(() => seen(lines).has("sess_own") && seen(lines).has("sess_other"));
    mux.close();
    await mux.done;
  });

  it("the rescan admits a later own-fleet session and keeps ignoring another fleet's", async () => {
    await makeSession("sess_free");
    const { lines, mux } = collect({ acting: "A", allFleets: false });
    await waitUntil(() => seen(lines).has("sess_free"));
    await makeSession("sess_late_own", { fleet: "A" });
    await makeSession("sess_late_other", { fleet: "B" });
    await waitUntil(() => seen(lines).has("sess_late_own"));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen(lines).has("sess_late_other")).toBe(false);
    mux.close();
    await mux.done;
  });
});
