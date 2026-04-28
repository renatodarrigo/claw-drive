/**
 * Sentinel-token vocabulary, wrapper prompt, and surface-mode resolver shared
 * by the runner (which injects the wrapper into B's system prompt) and the
 * watch parser (which extracts trailing tokens from B's assistant_text).
 *
 * v0.5.5's `status.ts` also imports `TRAILING_TOKEN_RE` and
 * `extractTrailingToken` from here so both consumers use a single regex.
 */

export const WRAPPER_PROMPT: string = `You are running as a driven Claude Code session inside claw-drive.
A driver session (Session A) is watching your turn endings and will
only notify its human user when one of the tokens below appears on
its own line, in literal brackets, at the very end of your message.

If your turn ends without one of these tokens, the human is NOT
notified — the driver assumes you're working autonomously. Use the
tokens to choose when the human gets pulled in.

When the human needs to act:
  [NEEDS-INPUT]          You need input to proceed (a question, a missing fact).
  [NEEDS-DECISION]       You want the human to pick from options you've laid out.
  [NEEDS-CONFIRMATION]   You're about to do something risky and want explicit go-ahead.
  [NEEDS-CLARIFICATION]  The brief is ambiguous; you want it disambiguated.

When something has gone wrong:
  [ERROR]                Unrecoverable. You can't proceed without human action.
  [FAILED-NO-RETRY]      Retries exhausted. You tried, failed, gave up.
  [FAILED-WILL-RETRY]    Failure, but you have retries remaining. (Default silent.)
  [PARTIAL-FAILURE]      Some sub-tasks succeeded, others didn't. Human decides next.

Lifecycle:
  [INFO-FINISHED]        Task complete. Terminal — nothing more to do.
  [INFO-CHECKPOINT]      Milestone hit. You're continuing; human may want to inspect.

Quiet status (default silent — emit when relevant; the human will see
these only if they've configured surfacing for them):
  [INFO-PROGRESS]        Quiet progress beat ("step N of M done").
  [INFO-WAITING]         Paused on an external thing (long build, async API).

Format rules:
  • One token per turn, on its own line, at the very end of your message.
  • Use the literal bracketed text as shown — no variations, no rewording.
  • If multiple states apply, pick the highest-attention one. Priority:
    NEEDS-* > ERROR / FAILED-* / PARTIAL-FAILURE > INFO-FINISHED >
    INFO-CHECKPOINT > INFO-PROGRESS / INFO-WAITING.
  • If none of these genuinely apply, end your turn without a token —
    that's correct for most autonomous turns.

The scenario brief that follows is the actual work you're being asked to do.

---`;

export const VOCAB: ReadonlySet<string> = new Set([
  "NEEDS-INPUT",
  "NEEDS-DECISION",
  "NEEDS-CONFIRMATION",
  "NEEDS-CLARIFICATION",
  "ERROR",
  "FAILED-NO-RETRY",
  "FAILED-WILL-RETRY",
  "PARTIAL-FAILURE",
  "INFO-FINISHED",
  "INFO-CHECKPOINT",
  "INFO-PROGRESS",
  "INFO-WAITING",
  "DEBUG-*",
]);

export const DEFAULT_SURFACE_MODES: Readonly<Record<string, "always" | "silent">> = {
  "NEEDS-INPUT": "always",
  "NEEDS-DECISION": "always",
  "NEEDS-CONFIRMATION": "always",
  "NEEDS-CLARIFICATION": "always",
  "ERROR": "always",
  "FAILED-NO-RETRY": "always",
  "FAILED-WILL-RETRY": "silent",
  "PARTIAL-FAILURE": "always",
  "INFO-FINISHED": "always",
  "INFO-CHECKPOINT": "always",
  "INFO-PROGRESS": "silent",
  "INFO-WAITING": "silent",
  "DEBUG-*": "silent",
};

/**
 * Trailing-token regex. Must match v0.5.5's `status.ts` regex byte-for-byte
 * (the latter now imports this constant).
 *
 * - Token must be on its own line at the very end of the message.
 * - Identifier shape: starts with `[A-Z*]`, then `[A-Z0-9*-]*`.
 * - Trailing whitespace (incl. CRLF) after the token is allowed.
 */
export const TRAILING_TOKEN_RE: RegExp = /(?:^|\n)[ \t]*\[([A-Z*][A-Z0-9*-]*)\]\s*$/;

export function extractTrailingToken(text: string): string | null {
  const m = TRAILING_TOKEN_RE.exec(text);
  return m ? m[1] : null;
}

/**
 * True iff the token name matches the DEBUG-X family (X being any non-empty
 * suffix). Bare "DEBUG" without a suffix does NOT match.
 */
export function isDebugToken(token: string): boolean {
  return /^DEBUG-[A-Z0-9-]+$/.test(token);
}

export interface CliSurfaceOverrides {
  surface: string[];
  silence: string[];
}

/**
 * Resolve the surface mode for a token using the three-layer chain:
 *   1. CLI overrides (--surface / --silence flags on `claw-drive watch`)
 *   2. Policy `surface_tokens` block
 *   3. DEFAULT_SURFACE_MODES (built-in)
 *   4. Final fallback: silent (conservative — unknown tokens don't surface).
 *
 * For DEBUG-X tokens, falls back to the DEBUG-* wildcard entry in the policy
 * and defaults if the specific DEBUG-X isn't listed.
 */
export function resolveSurfaceMode(
  token: string,
  cli: CliSurfaceOverrides,
  policy: Readonly<Record<string, "always" | "silent">>
): "always" | "silent" {
  // Layer 1: CLI overrides.
  if (cli.surface.includes(token)) return "always";
  if (cli.silence.includes(token)) return "silent";

  // Layer 2: Policy.
  if (Object.prototype.hasOwnProperty.call(policy, token)) {
    return policy[token];
  }
  // DEBUG-* wildcard fallback in policy.
  if (isDebugToken(token) && Object.prototype.hasOwnProperty.call(policy, "DEBUG-*")) {
    return policy["DEBUG-*"];
  }

  // Layer 3: Defaults.
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SURFACE_MODES, token)) {
    return DEFAULT_SURFACE_MODES[token];
  }
  if (isDebugToken(token)) {
    return DEFAULT_SURFACE_MODES["DEBUG-*"];
  }

  // Layer 4: Conservative final fallback.
  return "silent";
}
