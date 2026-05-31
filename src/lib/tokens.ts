/**
 * Sentinel-token vocabulary, wrapper prompt, surface-mode resolver, and
 * notification-contract builder. Shared by the runner (which injects the
 * wrapper into B's system prompt), the watch parser (which extracts trailing
 * tokens from B's assistant_text), and the MCP server (which assembles the
 * notification_contract returned from start_session).
 *
 * v0.5.7: vocabulary shrunk to two tokens ([NEEDS-INPUT], [DONE]); both
 * always-surface; DEBUG-* wildcard, three-layer override chain, and the
 * surface_tokens policy block all retired. notification_contract added.
 */

export const WRAPPER_PROMPT: string = `You are running as a driven Claude Code session inside claw-drive.
A driver session (Session A) is watching your turn endings and will
notify its human user only when one of the two tokens below appears
on its own line, in literal brackets, at the very end of your message.

If your turn ends without one of these tokens, the human is NOT
notified — the driver assumes you're working autonomously. Use the
tokens to choose when the human gets pulled in.

  [NEEDS-INPUT]   The human's turn. Use this when you need a fact, a
                  decision, a confirmation, a clarification, or help
                  recovering from a failure you can't proceed through
                  on your own.

  [DONE]          Task complete. Use this only when the work in the
                  scenario brief is genuinely finished — terminal,
                  with no further turns expected from you.

Format rules:
  • One token per turn, on its own line, at the very end of your message.
  • Use the literal bracketed text as shown — no variations, no rewording.
  • If neither applies, end your turn without a token.

The scenario brief that follows is the actual work you're being asked to do.

---`;

export const VOCAB: ReadonlySet<string> = new Set(["NEEDS-INPUT", "DONE"]);

export const DEFAULT_SURFACE_MODES: Readonly<Record<string, "always" | "silent">> = {
  "NEEDS-INPUT": "always",
  "DONE": "always",
};

/**
 * Trailing-token regex.
 *
 * - Token must be on its own line at the very end of the message.
 * - Identifier shape: starts with `[A-Z]`, then `[A-Z0-9-]*`.
 * - Trailing whitespace (incl. CRLF) after the token is allowed.
 */
export const TRAILING_TOKEN_RE: RegExp = /(?:^|\n)[ \t]*\[([A-Z][A-Z0-9-]*)\]\s*$/;

export function extractTrailingToken(text: string): string | null {
  const m = TRAILING_TOKEN_RE.exec(text);
  return m ? m[1] : null;
}

/**
 * Resolve the surface mode for a token.
 *
 * v0.5.7: vocabulary is fixed to two always-surface tokens. The three-layer
 * override chain (CLI overrides → policy `surface_tokens` → defaults) is
 * retired along with `surface_tokens` itself. Unknown tokens are silent
 * (conservative).
 */
export function resolveSurfaceMode(token: string): "always" | "silent" {
  return DEFAULT_SURFACE_MODES[token] ?? "silent";
}

/**
 * Idle-event default threshold, in seconds. Used by both `claw-drive watch`
 * (when --idle-after isn't passed) and `notification_contract.idle_after_seconds`
 * (so the consumer sees the same value the watch_command was built with).
 */
export const DEFAULT_IDLE_AFTER_SECONDS: number = 600;

export interface NotificationContractVocabEntry {
  token: string;
  semantic: string;
  surface: "always" | "silent";
}

export interface NotificationContract {
  version: 1;
  wrapper_enabled: boolean;
  vocabulary: NotificationContractVocabEntry[];
  watch_command: string;
  watch_flags: Record<string, string>;
  idle_after_seconds: number;
}

const VOCAB_SEMANTICS: Record<string, string> = {
  "NEEDS-INPUT":
    "The driven session needs the human to provide something to proceed — a fact, decision, confirmation, clarification, or direction after a failure it cannot recover from on its own.",
  "DONE":
    "Task complete. No further turns expected from the driven session.",
};

const WATCH_FLAGS_DOC: Record<string, string> = {
  "--no-token-filter":
    "Surface every event regardless of trailing token. For consumers that apply their own filter logic instead of relying on B's token compliance.",
  "--decision-only":
    "Narrow to the human-attention event kinds; drops turn_completed and tool_output_provided.",
  "--only KIND[,KIND]...":
    "Restrict to a subset of valid event kinds.",
  "--idle-after SECONDS":
    "Emit a synthetic 'idle' event after N seconds of no surfaced activity. Default 600. Pass 0 to disable.",
  "--no-suspected-needs-input":
    "Disable the silent-miss backstop. By default, a no-token turn whose final line ends in '?' is surfaced with a suspected_needs_input marker (B likely meant to emit [NEEDS-INPUT]); this flag drops such turns as before.",
};

export function buildNotificationContract(args: {
  watchCommand: string;
  wrapperEnabled: boolean;
  idleAfterSeconds?: number;
}): NotificationContract {
  return {
    version: 1,
    wrapper_enabled: args.wrapperEnabled,
    vocabulary: [...VOCAB].map((token) => ({
      token,
      semantic: VOCAB_SEMANTICS[token],
      surface: resolveSurfaceMode(token),
    })),
    watch_command: args.watchCommand,
    watch_flags: { ...WATCH_FLAGS_DOC },
    idle_after_seconds: args.idleAfterSeconds ?? DEFAULT_IDLE_AFTER_SECONDS,
  };
}
