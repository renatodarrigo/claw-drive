import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runnerLogPath } from "../../src/lib/paths.js";
import { openRunnerLog, type RunnerLog } from "../../src/lib/runner-log.js";

let root: string;
let prevHome: string | undefined;
const ENV_KEYS = ["CLAW_DRIVE_LOG_MAX_BYTES", "CLAW_DRIVE_LOG_KEEP"];
const savedEnv: Record<string, string | undefined> = {};
let log: RunnerLog | null = null;
const SID = "sess_rot00001";

function logFile(suffix = ""): string {
  return runnerLogPath(SID) + suffix;
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "cd44-"));
  process.env.CLAW_DRIVE_HOME = root;
  await fsp.mkdir(path.join(root, "sessions", SID), { recursive: true });
});

afterEach(async () => {
  if (log) {
    log.close();
    log = null;
  }
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  await fsp.rm(root, { recursive: true, force: true });
});

/** Write n ~50-byte lines through the sink. */
function emit(n: number): void {
  for (let i = 0; i < n; i++) log!.write("x".repeat(48) + "\n");
}

describe("openRunnerLog — size-based rotation", () => {
  it("rotates to runner.log.1 when a write crosses LOG_MAX_BYTES; live log stays bounded", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "200";
    log = openRunnerLog(SID);
    emit(20); // ~980 bytes ≫ 200 → several rotations
    log.flush();
    expect(fs.existsSync(logFile(".1"))).toBe(true);
    expect(fs.statSync(logFile()).size).toBeLessThanOrEqual(200 + 64);
  });

  it("runner.log.1 holds the pre-rotation tail; the new runner.log is fresh", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "200";
    log = openRunnerLog(SID);
    log.write("FIRST".repeat(50) + "\n"); // ~250 bytes fills the live log
    log.write("SECOND-after-roll\n"); // triggers rotation, lands in fresh live log
    log.flush();
    expect(fs.readFileSync(logFile(".1"), "utf-8")).toContain("FIRST");
    const live = fs.readFileSync(logFile(), "utf-8");
    expect(live).toContain("SECOND-after-roll");
    expect(live).not.toContain("FIRST");
  });

  it("LOG_KEEP caps the number of generations (oldest deleted on the N+1th rotation)", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "100";
    process.env.CLAW_DRIVE_LOG_KEEP = "2";
    log = openRunnerLog(SID);
    emit(40); // many rotations
    log.flush();
    expect(fs.existsSync(logFile(".1"))).toBe(true);
    expect(fs.existsSync(logFile(".2"))).toBe(true);
    expect(fs.existsSync(logFile(".3"))).toBe(false); // never beyond KEEP=2
  });

  it("honors a custom CLAW_DRIVE_LOG_MAX_BYTES", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "1024";
    log = openRunnerLog(SID);
    emit(40); // ~2000 bytes > 1024
    log.flush();
    expect(fs.existsSync(logFile(".1"))).toBe(true);
  });

  it("invalid CLAW_DRIVE_LOG_MAX_BYTES falls back to the (large) default — no rotation for small output", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "not-a-number";
    log = openRunnerLog(SID);
    emit(20);
    log.flush();
    expect(fs.existsSync(logFile(".1"))).toBe(false);
  });

  it("zero/negative CLAW_DRIVE_LOG_MAX_BYTES falls back to default (bound never disabled)", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "0";
    log = openRunnerLog(SID);
    emit(20);
    log.flush();
    expect(fs.existsSync(logFile(".1"))).toBe(false);
  });

  it("accounts for a pre-existing log's size when deciding to rotate", () => {
    process.env.CLAW_DRIVE_LOG_MAX_BYTES = "200";
    fs.writeFileSync(logFile(), "y".repeat(250) + "\n"); // already over threshold
    log = openRunnerLog(SID);
    log.write("trigger\n");
    log.flush();
    expect(fs.existsSync(logFile(".1"))).toBe(true);
    expect(fs.readFileSync(logFile(".1"), "utf-8")).toContain("y".repeat(250));
  });
});
