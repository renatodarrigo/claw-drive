---
name: claw-drive-resolve
description: Resolve a paused tool call in a driven session. Usage — /claw-drive-resolve <call_id> <action> [--remember] [--reason <text>] [--stdout <text>] [--exit <n>]. Action is one of approve, reject, defer. For defer-with-output (the human ran the command locally and is feeding the result back), pass --stdout and --exit to use provide_tool_output instead of resolve_tool_call.
---

# Claw-drive — resolve

The user has invoked this skill to resolve a tool call that's paused waiting for human decision. This is the typical handler for a `tool_decision_required` notification.

## Steps

1. **Capture arguments.** Required:
   - `<call_id>` — the call ID from the `tool_decision_required` event.
   - `<action>` — `approve`, `reject`, or `defer`.

   Optional:
   - `--remember` — derive a policy rule from this decision and append it to the session's live policy. Narrow-by-default for non-Bash tools (matches only the exact arg shape).
   - `--reason <text>` — recorded in the audit event, surfaced in `pending` listings.
   - `--stdout <text>` and `--exit <n>` — for defer-with-output: the human ran the command locally and is feeding the result back to B. When these are present, use `provide_tool_output` instead of `resolve_tool_call`.

   If args are malformed, report usage and stop.

2. **Inspect the pending call** to confirm it exists and matches the user's intent. Either:
   - Re-read the recent `tool_decision_required` event from your conversation context, or
   - Run `claw-drive pending` from a shell and grep for `<call_id>`.

   If the call ID isn't pending (already resolved, expired, etc.), report and stop.

3. **Branch on action and the presence of stdout/exit:**

   **A. `approve` or `reject` (no stdout/exit):** Call MCP `resolve_tool_call`:
   ```json
   {
     "call_id": "<call_id>",
     "action": "<action>",
     "reason": "<reason or null>",
     "remember_as_policy": <true if --remember else false>
   }
   ```

   **B. `defer` with stdout/exit:** This is the defer-round-trip flow — the human ran the command locally and is feeding the output back. Call MCP `provide_tool_output`:
   ```json
   {
     "call_id": "<call_id>",
     "stdout": "<stdout text>",
     "stderr": "<stderr text or empty>",
     "exit_code": <exit number>,
     "extra_context": "<reason or empty>"
   }
   ```

   **C. `defer` without stdout/exit:** Call MCP `resolve_tool_call` with action=defer (the runner emits a tool_decision_required and B remains paused until the human provides the output via case B). The `--remember` flag is honoured here — derives a defer rule.

4. **Confirm the resolution.** The MCP response will include the resolved status. If the resolution failed (e.g., the call already resolved), report what happened.

5. **Watch for follow-on events.** The Monitor (set up in `/claw-drive-start`) should deliver `tool_output_provided` (case B) or `turn_completed` next. If the user is driving a long scenario, just continue.

## Notes

- **`--remember` is opinionated.** For non-Bash tools (Edit, Write, Read, Glob, Grep, Agent), the derived rule scopes on the identifying arg (file_path / pattern / subagent_type) — not tool-wide. To create a tool-wide rule, edit the policy directly via `update_policy`.
- **No partial output.** If the human's command produced output you can't include verbatim, summarise, but the round-trip is most valuable when the actual stdout is fed back so B can react to it.
