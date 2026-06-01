import * as fs from "node:fs/promises";
import { sessionsRoot, statePath, isValidSessionId } from "./paths.js";
import { readState, isPidAlive, type SessionState } from "./state.js";

/**
 * CD-10 session aliases. An alias is an optional human-friendly handle for a
 * session that can be used in place of the canonical `sess_…` id at any
 * session-arg call site. This module owns the alias grammar, the live-holder
 * lookup (for the start-path uniqueness check), and `resolveSessionRef`, which
 * every CLI subcommand + MCP tool routes its session argument through.
 */

const ALIAS_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

/**
 * True iff `value` is a legal alias: 1-32 chars, leading letter, then
 * alphanumeric / underscore / dash — AND does not begin with `sess_` (so an
 * alias can never collide with the canonical session-id format).
 */
export function isValidAlias(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.startsWith("sess_")) return false;
  return ALIAS_RE.test(value);
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "ready", "running"]);

/**
 * Is this state a LIVE session (active status backed by a live runner pid)?
 * Mirrors the orphan logic in live-sessions.ts / sessions.ts / status.ts so an
 * alias held by a stopped/failed/orphaned session does not block reuse or
 * resolve.
 */
function isLive(state: SessionState | null): boolean {
  if (state === null) return false;
  if (!ACTIVE_STATUSES.has(state.status)) return false;
  if (state.runner_pid === null || !isPidAlive(state.runner_pid)) return false;
  return true;
}

/** Scan sessionsRoot() and return the canonical id of the live session holding `alias`, or null. */
export async function findLiveAliasHolder(alias: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot());
  } catch {
    return null;
  }
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    let state: SessionState | null;
    try {
      state = await readState(statePath(id));
    } catch {
      continue;
    }
    if (state && state.alias === alias && isLive(state)) return id;
  }
  return null;
}

/**
 * Resolve a user-supplied session reference to a canonical session id:
 *   - a canonical `sess_…` id is returned unchanged (no disk scan);
 *   - a valid alias is resolved to the canonical id of its live holder;
 *   - anything else (unknown alias, stopped-only holder, malformed input)
 *     returns null.
 *
 * Every session-arg CLI subcommand and MCP tool routes through this so alias
 * support is uniform across the surface.
 */
export async function resolveSessionRef(arg: string): Promise<string | null> {
  if (isValidSessionId(arg)) return arg;
  if (!isValidAlias(arg)) return null;
  return findLiveAliasHolder(arg);
}
