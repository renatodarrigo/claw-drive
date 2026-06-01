import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runnerLogPath } from "../../src/lib/paths.js";
import { openRunnerLog, type RunnerLog } from "../../src/lib/runner-log.js";

let root: string;
let prevHome: string | undefined;
let log: RunnerLog | null = null;
const SID = "sess_log0001";

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "cd43-"));
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
  await fsp.rm(root, { recursive: true, force: true });
});

function readLog(): string {
  return fs.readFileSync(runnerLogPath(SID), "utf-8");
}

// The sink — openRunnerLog().write() — holds all the capture/rotation logic and
// is tested directly here. The process.stdout/stderr redirect on top of it
// (installRunnerLogCapture) is deliberately NOT unit-tested: vitest replaces
// process.stdout.write with its own spy and intercepts reassignment, so neither
// the swap nor console.* routing is observable in-process. That whole path —
// install → console.error → file, nothing leaking to the parent — is covered
// end-to-end by tests/integration/runner-log.test.ts (a real
// `node dist/runner/runner.js` subprocess, where vitest does not intercept).

describe("openRunnerLog — capture sink", () => {
  it("writes a string into runner.log", () => {
    log = openRunnerLog(SID);
    log.write("hello-stdout\n");
    log.flush();
    expect(readLog()).toContain("hello-stdout");
  });

  it("writes a Buffer (e.g. B's stderr chunk) into runner.log", () => {
    log = openRunnerLog(SID);
    log.write(Buffer.from("from-a-buffer\n"));
    log.flush();
    expect(readLog()).toContain("from-a-buffer");
  });

  it("captures a forced exception's message (the runner-fatal shape)", () => {
    log = openRunnerLog(SID);
    try {
      throw new Error("boom-forced-exception");
    } catch (e) {
      log.write(`runner fatal: ${(e as Error).message}\n`);
    }
    log.flush();
    expect(readLog()).toContain("boom-forced-exception");
  });

  it("is byte-faithful across multiple multi-line writes", () => {
    log = openRunnerLog(SID);
    log.write("line one\nline two\n");
    log.write("line three\n");
    log.flush();
    const out = readLog();
    expect(out).toContain("line one\nline two");
    expect(out).toContain("line three");
  });

  it("appends to an existing runner.log rather than truncating it", () => {
    fs.writeFileSync(runnerLogPath(SID), "preexisting\n");
    log = openRunnerLog(SID);
    log.write("appended\n");
    log.flush();
    const out = readLog();
    expect(out.startsWith("preexisting\n")).toBe(true);
    expect(out).toContain("appended");
  });

  it("a write after close() does not throw", () => {
    log = openRunnerLog(SID);
    log.close();
    expect(() => log!.write("after-close\n")).not.toThrow();
    log = null;
  });
});
