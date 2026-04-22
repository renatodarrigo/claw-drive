import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = ".claw-drive";

export function appRoot(): string {
  return process.env.CLAW_DRIVE_HOME ?? path.join(os.homedir(), APP_DIR);
}

export function sessionsRoot(): string {
  return path.join(appRoot(), "sessions");
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId);
}

export function eventsPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "events.jsonl");
}

export function statePath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "state.json");
}

export function socketPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "control.sock");
}

export function mcpConfigPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "mcp.json");
}

export function settingsPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "settings.json");
}

export function readyMarkerPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "ready");
}

export function runnerLogPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "runner.log");
}

export function runnerPidPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "runner.pid");
}

/**
 * Absolute path to bin/claw-drive-approver in the installed package.
 *
 * At build time this resolves to <package_root>/bin/claw-drive-approver.
 * At runtime (dist/lib/paths.js), we ascend two levels from __dirname to
 * reach the package root, then descend into bin/. This works for:
 *   - developer mode: running from <repo>/dist/lib/paths.js
 *   - npm link: symlink resolves to the package dir
 *   - global install: normal node_modules/claw-drive/bin/claw-drive-approver
 */
export function approverBinPath(): string {
  const here = fileURLToPath(import.meta.url);
  // here: .../dist/lib/paths.js  → package root is two dirs up
  const pkgRoot = path.resolve(path.dirname(here), "..", "..");
  return path.join(pkgRoot, "bin", "claw-drive-approver");
}

const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{1,64}$/;

export function isValidSessionId(id: string): boolean {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

export function isInsideHome(p: string): boolean {
  const home = os.homedir();
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("..")) return false;
  const normalized = path.resolve(p);
  return normalized === home || normalized.startsWith(home + path.sep);
}
