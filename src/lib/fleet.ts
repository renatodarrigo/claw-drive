/**
 * Fleets: driver-scoped sessions.
 *
 * Every fleet surface (`status`, `sessions`, `pending`, `watch --all`,
 * `prune`, the call-id scans, `send --all`, and the MCP `list_sessions` /
 * `resolve_tool_call` scans) acts as ONE fleet — the "acting fleet" — and
 * shows that fleet's sessions plus untagged ones. `--all-fleets` widens the
 * view to every session on the machine. `start` stamps the acting fleet on
 * the new session (see SessionState.fleet); lineage successors inherit it.
 *
 * Acting-fleet resolution, identical everywhere:
 *   1. explicit  — CLI `--fleet <tag>` / MCP `fleet` input
 *   2. env       — CLAW_DRIVE_FLEET
 *   3. observed  — CLAUDE_CODE_SESSION_ID (Claude Code exports its session
 *                  UUID to Bash subprocesses and stdio MCP servers; observed
 *                  on claude 2.1.258, not a documented guarantee — a
 *                  malformed or absent value simply yields no identity)
 *   4. none      — the view is untagged sessions only
 *
 * Explicit ids and aliases are never scoped: only enumeration is.
 */

/** 1–64 chars; letters, digits, '_', '.', '-'; must start with a letter or digit. */
export const FLEET_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const FLEET_TAG_RULE =
  "1-64 chars of letters, digits, '_', '.', '-' and starts with a letter or digit";

/** MCP `BAD_REQUEST` wording for an invalid `fleet` input. */
export const FLEET_TAG_MCP_MESSAGE =
  "fleet must be 1-64 chars of letters, digits, '_', '.', '-' and start with a letter or digit";

/** Usage error when `--fleet` / `--all-fleets` accompany a single-session form. */
export const FLEET_FLAGS_SINGLE_FORM_ERROR = "--fleet/--all-fleets apply only to the fleet view";

export function isValidFleetTag(v: unknown): v is string {
  return typeof v === "string" && FLEET_TAG_RE.test(v);
}

export interface FleetView {
  /** The fleet this command acts as; undefined = no identity. */
  acting: string | undefined;
  /** `--all-fleets`: every session is in view. */
  allFleets: boolean;
}

export class FleetTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetTagError";
  }
}

/**
 * Resolve the acting fleet. An invalid EXPLICIT source (flag or
 * CLAW_DRIVE_FLEET) throws FleetTagError; an empty CLAW_DRIVE_FLEET counts
 * as unset; a malformed CLAUDE_CODE_SESSION_ID is ignored.
 */
export function resolveActingFleet(
  opts: { flag?: string; env?: NodeJS.ProcessEnv } = {}
): string | undefined {
  const env = opts.env ?? process.env;
  if (opts.flag !== undefined) {
    if (!isValidFleetTag(opts.flag)) {
      throw new FleetTagError(`invalid --fleet '${opts.flag}': a fleet tag is ${FLEET_TAG_RULE}`);
    }
    return opts.flag;
  }
  const explicit = env.CLAW_DRIVE_FLEET;
  if (explicit !== undefined && explicit !== "") {
    if (!isValidFleetTag(explicit)) {
      throw new FleetTagError(
        `invalid CLAW_DRIVE_FLEET '${explicit}': a fleet tag is ${FLEET_TAG_RULE}`
      );
    }
    return explicit;
  }
  const observed = env.CLAUDE_CODE_SESSION_ID;
  return isValidFleetTag(observed) ? observed : undefined;
}

/** In view iff `--all-fleets`, or the session is untagged, or its tag is the acting fleet. */
export function inFleetView(state: { fleet?: string } | null, view: FleetView): boolean {
  if (view.allFleets) return true;
  const tag = state?.fleet;
  if (tag === undefined) return true;
  return tag === view.acting;
}

export type ParsedFleetFlags =
  | { ok: true; rest: string[]; view: FleetView; flagsSeen: boolean }
  | { ok: false; error: string };

/**
 * Lift `--fleet <tag>` / `--all-fleets` out of argv (any position, up to a
 * bare `--`, which is passed through with everything after it) and resolve
 * the view. Each fleet surface's handler calls this BEFORE its own parser,
 * so non-fleet commands keep today's unknown-flag behavior.
 */
export function parseFleetFlags(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): ParsedFleetFlags {
  const rest: string[] = [];
  let flag: string | undefined;
  let allFleets = false;
  let flagsSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === "--fleet") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: "--fleet requires a tag" };
      flag = v;
      flagsSeen = true;
    } else if (a === "--all-fleets") {
      allFleets = true;
      flagsSeen = true;
    } else {
      rest.push(a);
    }
  }
  if (flag !== undefined && allFleets) {
    return { ok: false, error: "--fleet and --all-fleets are mutually exclusive" };
  }
  let acting: string | undefined;
  try {
    acting = resolveActingFleet({ flag, env });
  } catch (e) {
    if (e instanceof FleetTagError) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, rest, view: { acting, allFleets }, flagsSeen };
}

/** One stderr line for the human `status` / `sessions` tables when the view hid something. */
export function hiddenFleetsHint(n: number): string {
  return `(${n} session${n === 1 ? "" : "s"} in other fleets hidden; --all-fleets shows them)`;
}
