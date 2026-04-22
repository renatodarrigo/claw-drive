import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  sessionsRoot,
  sessionDir,
  eventsPath,
  statePath,
  socketPath,
  mcpConfigPath,
  settingsPath,
  readyMarkerPath,
  runnerLogPath,
  runnerPidPath,
  approverBinPath,
  isValidSessionId,
  isInsideHome,
  appRoot,
} from "../../src/lib/paths.js";

describe("paths", () => {
  it("appRoot honors CLAW_DRIVE_HOME when set", () => {
    const original = process.env.CLAW_DRIVE_HOME;
    process.env.CLAW_DRIVE_HOME = "/tmp/claw-drive-test-root";
    try {
      expect(appRoot()).toBe("/tmp/claw-drive-test-root");
    } finally {
      if (original === undefined) delete process.env.CLAW_DRIVE_HOME;
      else process.env.CLAW_DRIVE_HOME = original;
    }
  });

  it("appRoot defaults to ~/.claw-drive when env unset", () => {
    const original = process.env.CLAW_DRIVE_HOME;
    delete process.env.CLAW_DRIVE_HOME;
    try {
      expect(appRoot()).toBe(path.join(os.homedir(), ".claw-drive"));
    } finally {
      if (original !== undefined) process.env.CLAW_DRIVE_HOME = original;
    }
  });

  it("sessionsRoot is under appRoot", () => {
    expect(sessionsRoot()).toBe(path.join(appRoot(), "sessions"));
  });

  it("sessionDir(id) composes under sessionsRoot", () => {
    expect(sessionDir("sess_abc")).toBe(path.join(sessionsRoot(), "sess_abc"));
  });

  it.each([
    ["events.jsonl", eventsPath],
    ["state.json", statePath],
    ["control.sock", socketPath],
    ["mcp.json", mcpConfigPath],
    ["settings.json", settingsPath],
    ["ready", readyMarkerPath],
    ["runner.log", runnerLogPath],
    ["runner.pid", runnerPidPath],
  ])("%s sits under sessionDir", (filename, fn) => {
    expect(fn("sess_abc")).toBe(path.join(sessionDir("sess_abc"), filename));
  });

  it("approverBinPath points at bin/claw-drive-approver in the package", () => {
    const p = approverBinPath();
    expect(p.endsWith(path.join("bin", "claw-drive-approver"))).toBe(true);
    // Must be absolute
    expect(path.isAbsolute(p)).toBe(true);
  });

  it("isValidSessionId accepts canonical shape", () => {
    expect(isValidSessionId("sess_20260421T120000_abc123")).toBe(true);
  });

  it("isValidSessionId rejects path traversal or empty", () => {
    expect(isValidSessionId("../evil")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("sess_/abc")).toBe(false);
    expect(isValidSessionId("sess_abc\nother")).toBe(false);
  });

  it("isInsideHome(homedir) is true", () => {
    expect(isInsideHome(os.homedir())).toBe(true);
  });

  it("isInsideHome rejects /etc", () => {
    expect(isInsideHome("/etc")).toBe(false);
  });

  it("isInsideHome rejects inputs containing traversal segments", () => {
    expect(
      isInsideHome(path.join(os.homedir(), "..", "..", os.homedir().split("/").pop()!))
    ).toBe(false);
  });
});
