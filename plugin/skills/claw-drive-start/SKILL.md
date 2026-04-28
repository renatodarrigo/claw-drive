---
name: claw-drive-start
description: Spawn a driven Claude Code session (Session B) in the given directory and start the Monitor flow against the returned watch_command. Usage — /claw-drive-start <cwd> [--brief <file>] [--policy <file>] [--verbose]. The cwd must exist and be a real project root. If --brief is omitted, the user will be asked for the scenario brief inline. If --policy is omitted, the conservative starter shipped with claw-drive is used. By default Session B receives a system-prompt wrapper teaching it to end attention-needing turns with literal [TOKEN] sentinels (e.g. [NEEDS-INPUT], [ERROR], [INFO-FINISHED]); the Monitor stream surfaces turn_completed only when such a token's surface mode is "always". Pass --verbose to bypass both the wrapper injection and the sentinel filter (raw v0.5.5-style stream including every turn_completed and tool_output_provided).
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

5. **Call `start_session`.** Invoke the MCP tool. If `--verbose` was passed, include `wrapper: false` so Session B doesn't receive the sentinel-token contract (raw v0.5.5-style behavior); otherwise the wrapper is auto-injected.
   ```json
   {
     "cwd": "<absolute-cwd>",
     "policy": <policy-json-or-null>,
     "scenario_brief": "<the brief>",
     "wrapper": <false if --verbose, else omit>
   }
   ```
   Capture the response: `{ session_id, watch_command }`.

6. **Send the brief as the first user turn.** Call `send_turn` with the brief content as the user message. Capture the `turn_id`.

7. **Start the Monitor.** Decide the watch_command:
   - If `--verbose` was passed, append ` --no-token-filter` to the watch_command. Monitor will stream all eight actionable kinds without the sentinel-aware filter (matches the v0.5.5-style behavior; pairs with `wrapper: false` from step 5 so neither side of the v0.5.6 contract is engaged).
   - Otherwise, use the watch_command from step 5 unchanged. The watch parser is now sentinel-aware by default: `tool_decision_required`, timeout-resolved decisions, `turn_failed`, `error`, `session_stopped`, and is-error `tool_call_result` always surface; `turn_completed` surfaces only when Session B's last message ends with a `[TOKEN]` whose configured surface mode is `"always"` (default vocabulary loaded from the policy `surface_tokens` block, falling back to built-in defaults). `tool_output_provided` always surfaces.

   Then call Claude Code's `Monitor` tool with the (possibly modified) watch_command.

8. **Report to the user:**
   - Session ID: `<id>`
   - First turn ID: `<turn_id>`
   - Monitor active. Notifications will surface as they arrive.
   - **(Default)** Session B has been taught a sentinel-token contract: it'll only complete turns with `[NEEDS-INPUT]` / `[ERROR]` / `[INFO-FINISHED]` etc. when human attention is genuinely needed, and Monitor will surface those turn_completed events. Other actionable events (decisions, failures, session stops) always fire. Pass `--verbose` next time for the raw v0.5.5-style stream.
   - **(If `--verbose`)** Both wrapper injection and the sentinel filter are disabled. Monitor surfaces every actionable event. Omit `--verbose` next time for the sentinel-aware default.
   - To resolve a paused call: `/claw-drive-resolve <call_id> <approve|reject|defer> [--remember]`
   - To stop: tell me "stop session `<id>`" or call `claw-drive stop <id>` from a shell.

9. **Wait for notifications.** Do not poll; let the Monitor tool deliver events. Surface `tool_decision_required` events to the user immediately with the relevant context (the tool, the args, the policy match if any).

## What this skill does NOT do

- Register the MCP server. Run `/claw-drive-init` first.
- Decide approvals on the user's behalf. Surface them via the Monitor and let the user direct.
- Continue the session after the first turn. Subsequent turns are driven by user instruction in this Claude Code session ("send another turn telling B to …").
