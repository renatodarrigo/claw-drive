/**
 * The text B receives when the human ran a deferred tool call and fed its
 * output back through provide_tool_output. Shared by both delivery paths —
 * released through the paused approval hook as the call's own result (a call
 * still paused in a running turn, within the hook channel's limits), or
 * written to B's stdin as a new user turn (a call deferred earlier, or a
 * paused call that has gone stale) — so B reads the same words whichever way
 * it arrives.
 *
 * Extracted (runner-args.ts precedent) so the wording is unit-testable
 * without spawning the runner.
 */
export interface OutputMessageInput {
  tool: string;
  call_id: string;
  args: Record<string, unknown>;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  extra: string;
}

export function composeOutputMessage(input: OutputMessageInput): string {
  return (
    `[claw-drive] The deferred \`${input.tool}\` call (call_id: ${input.call_id}) was executed by the human.\n\n` +
    `Original args: ${JSON.stringify(input.args)}\n\n` +
    `Exit code: ${input.exit_code === null ? "(not provided)" : String(input.exit_code)}\n\n` +
    `Stdout:\n${input.stdout || "(empty)"}\n\n` +
    `Stderr:\n${input.stderr || "(empty)"}\n\n` +
    `Notes: ${input.extra || "(none)"}\n\n` +
    `Please continue from where you left off, using this as the tool's output.`
  );
}
