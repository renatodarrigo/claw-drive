---
name: claw-drive-start
description: Spawn a driven Claude Code session (Session B) in the given directory and start the Monitor flow against the returned watch_command. Usage — /claw-drive-start <cwd> [--brief <file>] [--policy <file>]. The cwd must exist and be a real project root. If --brief is omitted, the user will be asked for the scenario brief inline. If --policy is omitted, the conservative starter shipped with claw-drive is used.
---

# Claw-drive — start

The user has invoked this skill to kick off a driven session. This is the standard "drive Claude Code from Claude Code" entry point.

## Steps

1. **Validate `<cwd>`.** It must be:
   - An absolute path (or `~`-relative — expand it).
   - An existing directory.
   - Distinct from the current Claude Code session's cwd (don't drive yourself).

   If invalid, report and stop.

2. **Verify the claw-drive MCP server is wired up.** If you (the parent Claude Code session) don't see `claw_drive.start_session` available as an MCP tool, tell the user:
   > claw-drive isn't registered in this project. Run `/claw-drive-init` first, then restart Claude Code (or run `/mcp`).

   Stop. Do not try to call the CLI directly.

3. **Resolve the policy.** If `--policy <file>` was passed, read the file content as JSON. Otherwise pass `null` (claw-drive falls back to the conservative starter).

4. **Resolve the brief.** If `--brief <file>` was passed, read the file content. Otherwise ask the user inline:
   > What's the scenario brief for Session B?
   Capture multi-line input. Strip leading/trailing whitespace.

5. **Call `start_session`.** Invoke the MCP tool:
   ```json
   {
     "cwd": "<absolute-cwd>",
     "policy": <policy-json-or-null>,
     "scenario_brief": "<the brief>"
   }
   ```
   Capture the response: `{ session_id, watch_command }`.

6. **Send the brief as the first user turn.** Call `send_turn` with the brief content as the user message. Capture the `turn_id`.

7. **Start the Monitor.** Call Claude Code's `Monitor` tool with the `watch_command` payload from step 5. This streams notifications (`tool_decision_required`, `tool_output_provided`, `turn_completed`, `turn_failed`, `session_stopped`) back to this session.

8. **Report to the user:**
   - Session ID: `<id>`
   - First turn ID: `<turn_id>`
   - Monitor active. Notifications will surface as they arrive.
   - To resolve a paused call: `/claw-drive-resolve <call_id> <approve|reject|defer> [--remember]`
   - To stop: tell me "stop session `<id>`" or call `claw-drive stop <id>` from a shell.

9. **Wait for notifications.** Do not poll; let the Monitor tool deliver events. Surface `tool_decision_required` events to the user immediately with the relevant context (the tool, the args, the policy match if any).

## What this skill does NOT do

- Register the MCP server. Run `/claw-drive-init` first.
- Decide approvals on the user's behalf. Surface them via the Monitor and let the user direct.
- Continue the session after the first turn. Subsequent turns are driven by user instruction in this Claude Code session ("send another turn telling B to …").
