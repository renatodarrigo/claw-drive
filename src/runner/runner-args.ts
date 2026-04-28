import { WRAPPER_PROMPT } from "../lib/tokens.js";

export interface BuildClaudeArgsInput {
  mcpConfigPath: string;
  settingsPath: string;
  model: string | null;
  /**
   * Whether to inject the v0.5.6 sentinel-token contract wrapper into B's
   * system prompt via `--append-system-prompt`. Defaults to `true` when
   * undefined. Pass `false` to opt out (raw v0.5.5-and-earlier behavior).
   */
  wrapper?: boolean;
}

/**
 * Build the argv for spawning `claude -p` for a driven Session B.
 *
 * Extracted into its own module so v0.5.6's `--append-system-prompt`
 * injection is unit-testable without spawning the runner.
 */
export function buildClaudeArgs(input: BuildClaudeArgsInput): string[] {
  const argv: string[] = [
    "-p",
    "--output-format=stream-json",
    "--input-format=stream-json",
    "--verbose",
    "--mcp-config",
    input.mcpConfigPath,
    "--settings",
    input.settingsPath,
  ];
  if (input.model) {
    argv.push("--model", input.model);
  }
  if (input.wrapper !== false) {
    argv.push("--append-system-prompt", WRAPPER_PROMPT);
  }
  return argv;
}
