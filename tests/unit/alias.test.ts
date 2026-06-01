import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  isValidAlias,
  resolveSessionRef,
  findLiveAliasHolder,
} from "../../src/lib/alias.js";

// A reliably-dead pid: spawn node that exits immediately, reuse its reaped pid.
const DEAD_PID: number = (() => spawnSync(process.execPath, ["-e", ""]).pid as number)();

let root: string;
let prevHome: string | undefined;

function baseState(over: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "x",
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
  };
}

async function writeSession(id: string, over: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(baseState({ session_id: id, ...over })));
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd48-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("isValidAlias", () => {
  it("accepts a leading-letter alphanumeric/_/- alias up to 32 chars", () => {
    expect(isValidAlias("reviewer")).toBe(true);
    expect(isValidAlias("a")).toBe(true);
    expect(isValidAlias("rev-1_b")).toBe(true);
    expect(isValidAlias("A".repeat(32))).toBe(true);
  });

  it("rejects empty, leading-digit, >32 chars, and illegal chars", () => {
    expect(isValidAlias("")).toBe(false);
    expect(isValidAlias("1abc")).toBe(false);
    expect(isValidAlias("a".repeat(33))).toBe(false);
    expect(isValidAlias("has space")).toBe(false);
    expect(isValidAlias("dot.name")).toBe(false);
    expect(isValidAlias("slash/name")).toBe(false);
  });

  it("rejects anything beginning with sess_ (canonical-id collision guard)", () => {
    expect(isValidAlias("sess_abc")).toBe(false);
    expect(isValidAlias("sess_")).toBe(false);
  });
});

describe("resolveSessionRef", () => {
  it("returns a canonical session id unchanged (no disk scan needed)", async () => {
    expect(await resolveSessionRef("sess_abcdef0123456789")).toBe("sess_abcdef0123456789");
  });

  it("resolves a live alias to its canonical session id", async () => {
    await writeSession("sess_live01alias", { alias: "reviewer", status: "running", runner_pid: process.pid });
    expect(await resolveSessionRef("reviewer")).toBe("sess_live01alias");
  });

  it("returns null for an alias held only by a stopped session", async () => {
    await writeSession("sess_stopped001", { alias: "ghost", status: "stopped", runner_pid: process.pid });
    expect(await resolveSessionRef("ghost")).toBeNull();
  });

  it("returns null for an alias held only by an orphaned session (active status, dead pid)", async () => {
    await writeSession("sess_orphan0001", { alias: "zombie", status: "running", runner_pid: DEAD_PID });
    expect(await resolveSessionRef("zombie")).toBeNull();
  });

  it("returns null for an unknown alias and a string that's neither id nor valid alias", async () => {
    expect(await resolveSessionRef("nobody")).toBeNull(); // valid alias, no holder
    expect(await resolveSessionRef("1nvalid")).toBeNull(); // leading digit → not an alias
    expect(await resolveSessionRef("has space")).toBeNull(); // illegal chars → not an alias
  });

  it("passes a canonical-shaped id through unchanged even if no such session exists (existence is checked at the op, not here)", async () => {
    expect(await resolveSessionRef("sess_notreal_butidshaped_zzz")).toBe("sess_notreal_butidshaped_zzz");
  });
});

describe("findLiveAliasHolder", () => {
  it("returns the session id of a live holder", async () => {
    await writeSession("sess_holder0001", { alias: "builder", status: "ready", runner_pid: process.pid });
    expect(await findLiveAliasHolder("builder")).toBe("sess_holder0001");
  });

  it("returns null when no live session holds the alias (stopped holder does not count)", async () => {
    await writeSession("sess_stopped002", { alias: "free", status: "stopped", runner_pid: process.pid });
    expect(await findLiveAliasHolder("free")).toBeNull();
    expect(await findLiveAliasHolder("never-used")).toBeNull();
  });
});
