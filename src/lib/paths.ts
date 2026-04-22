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
 * Absolute path to bin/claw-drive-approver.
 *
 * Resolution order:
 *   1. `CLAW_DRIVE_APPROVER_BIN` env var (set by install.sh's copy-mode shim
 *      so the MCP server points at the user's $BIN_DIR copy, not the repo).
 *   2. Package-relative default: two dirs up from this compiled file
 *      (`dist/lib/paths.js`) + `bin/claw-drive-approver`. Works for:
 *        - developer mode: running from <repo>/dist/lib/paths.js
 *        - symlink install: Node follows symlinks, so import.meta.url
 *          resolves to the real repo path
 *        - npm / global install: normal node_modules layout
 */
export function approverBinPath(): string {
  const override = process.env.CLAW_DRIVE_APPROVER_BIN;
  if (override && override.length > 0) return override;
  const here = fileURLToPath(import.meta.url);
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
