# Claude CLI contract (captured 2026-04-21 against claude 2.1.117)

## Input format (`--input-format=stream-json`)

Each line is a JSON object. User turn:

    {"type":"user","message":{"role":"user","content":"..."}}

Confirmed: the `content` field accepts a bare string. The spec assumed this
correctly. Whether it also accepts an array of content blocks (e.g.
`[{"type":"text","text":"..."}]`) was not probed; based on the Anthropic
Messages API convention it is likely accepted, but claw-drive should default
to the bare-string form confirmed here.

The input stream is line-delimited — each JSON object must be on its own line.
There is no envelope wrapping multiple turns; each turn is a separate JSON line.

## Output format (`--output-format=stream-json`)

Each line is one of the following event types, in the order they appear:

### `system` events

**`hook_started`** — emitted when a SessionStart hook fires (only present when
`--verbose` is passed and hooks are configured):

    {"type":"system","subtype":"hook_started","hook_id":"...","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"...","session_id":"..."}

**`hook_response`** — emitted when a SessionStart hook responds (only with
`--verbose`). Body contains large hook payloads (superpowers skill content,
etc.). Not present without `--verbose`.

**`init`** — session metadata, emitted once after hooks complete:

    {"type":"system","subtype":"init","cwd":"/path","session_id":"...","tools":[...],"mcp_servers":[{"name":"...","status":"connected"|"pending"|"needs-auth"}],"model":"claude-opus-4-7[1m]","permissionMode":"bypassPermissions","slash_commands":[...],"apiKeySource":"none","claude_code_version":"2.1.117","output_style":"default","agents":[...],"skills":[...],"plugins":[...],"uuid":"...","memory_paths":{"auto":"..."},"fast_mode_state":"off"}

Key fields: `tools` (full list of available tools), `model`, `permissionMode`,
`session_id`, `cwd`.

### `assistant` events

The assistant emits **multiple** `assistant`-typed events per turn, not one.
Each partial chunk of the streamed response is its own JSON line:

First chunk — thinking block (extended thinking, empty `thinking` field but
contains a `signature`):

    {"type":"assistant","message":{"model":"claude-opus-4-7","id":"msg_...","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"..."}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{...},"context_management":null},"parent_tool_use_id":null,"session_id":"...","uuid":"..."}

Second chunk — text or tool_use content:

    {"type":"assistant","message":{"model":"claude-opus-4-7","id":"msg_...","type":"message","role":"assistant","content":[{"type":"text","text":"Hello there, friend."}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{...},"context_management":null},"parent_tool_use_id":null,"session_id":"...","uuid":"..."}

Note: both chunks share the same `message.id`. The `stop_reason` is `null` on
partial chunks. `output_tokens` in `usage` may be 0 on non-final chunks.

### `user` events (tool_result echo)

After a tool_use is executed, the CLI emits a `user`-typed event containing
the tool result. This is NOT the original user input — it is the tool result
being fed back into the conversation:

    {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01...","type":"tool_result","content":"hi from probe","is_error":false}]},"parent_tool_use_id":null,"session_id":"...","uuid":"...","timestamp":"2026-04-22T02:55:37.137Z","tool_use_result":{"stdout":"hi from probe","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}

The original user input is NOT echoed back as a `user` event — it is consumed
silently. Only tool results cause `user`-typed output events.

### `rate_limit_event`

Emitted after tool execution and sometimes between events:

    {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1776826800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"...","session_id":"..."}

### `result` event

Terminal event, emitted once at the end:

    {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":3207,"duration_api_ms":2595,"num_turns":1,"result":"Hello there, friend.","stop_reason":"end_turn","session_id":"...","total_cost_usd":0.11169474999999998,"usage":{...},"modelUsage":{...},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"..."}

Key fields: `subtype` ("success" or "error_*"), `result` (final text output),
`num_turns`, `total_cost_usd`, `stop_reason`, `terminal_reason`.

## Tool call shape

From `tool-call-turn.jsonl`, the `tool_use` block inside an `assistant` event:

```json
{
  "type": "tool_use",
  "id": "toolu_01EuoAtU9fYuZKJddNaWSSQQ",
  "name": "Bash",
  "input": {
    "command": "echo hi from probe",
    "description": "Print probe message"
  },
  "caller": {
    "type": "direct"
  }
}
```

Fields: `type` ("tool_use"), `id` (unique per call), `name` (tool name),
`input` (tool-specific args as object), `caller` ({"type":"direct"} for
model-initiated calls).

## Tool result shape

The tool result appears as a `user`-typed event (not as part of an assistant
event). The `content` field of `message` is an array of tool result blocks:

```json
{
  "tool_use_id": "toolu_01EuoAtU9fYuZKJddNaWSSQQ",
  "type": "tool_result",
  "content": "hi from probe",
  "is_error": false
}
```

Additionally, the top-level `user` event carries a `tool_use_result` object
with richer data:

```json
{
  "stdout": "hi from probe",
  "stderr": "",
  "interrupted": false,
  "isImage": false,
  "noOutputExpected": false
}
```

The `content` field is a bare string (not an array of content blocks) when the
tool produces text output. For image results, `isImage` would be `true` and
`content` format may differ.

## `--permission-prompt-tool`

**This flag does not exist in claude 2.1.117.** It is absent from `claude --help`
and `claude -p --help`. The spec's §14 assumption that `--permission-prompt-tool`
could be used to wire an external approver shim is invalidated.

The available permission flags are:

- `--permission-mode <mode>` — choices: `acceptEdits`, `auto`,
  `bypassPermissions`, `default`, `dontAsk`, `plan`
- `--dangerously-skip-permissions` — bypass all checks (no interactivity)
- `--allow-dangerously-skip-permissions` — expose bypass as an option

For claw-drive's approver shim (Task 16): since there is no
`--permission-prompt-tool` hook, the approver must instead be implemented as a
PreToolUse/PostToolUse hook (via `--settings` pointing to a settings file that
defines hooks), or by running in `bypassPermissions` mode and doing pre-flight
approval at the application layer before issuing the `user` message to claude.
The hook-based approach is the most viable: a PreToolUse hook script can block,
prompt, and exit with code 2 (block) or 0 (allow).

## `--mcp-config`

The flag exists: `--mcp-config <configs...>` — accepts one or more space-separated
JSON file paths or JSON strings. The `--strict-mcp-config` companion flag
makes it ignore all other MCP config sources (useful for hermetic sessions).

The file format was not probed directly, but based on the init event's
`mcp_servers` structure and Claude Code convention, it is:

```json
{
  "mcpServers": {
    "<name>": {
      "command": "...",
      "args": [...],
      "env": {}
    }
  }
}
```

This matches the standard MCP server config format. The `mcp_servers` field in
the `init` event lists each server with `{"name":"...","status":"connected"|"pending"|"needs-auth"}`.

## Surprises and spec deviations

1. **`--permission-prompt-tool` is absent.** The spec referenced this flag but
   it does not exist in 2.1.117. Approver wiring must use a different mechanism
   (hooks via `--settings`, or application-layer pre-approval).

2. **`--verbose` emits hook events as stream-json lines.** Without `--verbose`,
   the `hook_started` and `hook_response` events are suppressed. The `init`
   event still appears. For production claw-drive usage, omit `--verbose` (or
   add `--include-hook-events` if those events are desired — that flag was
   added in 2.1.x).

3. **Multiple `assistant` events per turn.** The spec assumed one assistant
   message per turn. In practice, the streamed output emits multiple partial
   `assistant` events sharing the same `message.id`. The stream parser must
   merge or pass these through correctly.

4. **Thinking blocks appear in the stream.** The model (opus-4-7) emits
   `{"type":"thinking","thinking":"","signature":"..."}` content blocks. These
   appear as a separate `assistant` event before the text/tool_use event.
   The `thinking` field is always empty string (scrubbed); the `signature` is
   present. claw-drive's stream parser should handle `thinking` content blocks
   gracefully.

5. **`user` events appear mid-stream for tool results.** The CLI emits
   `user`-typed events (not just `assistant` events) during a turn when tool
   calls are made. The stream is not purely `assistant` events — it interleaves
   `user` (tool results), `assistant` (next response), and `rate_limit_event`.

6. **`rate_limit_event` is emitted.** Not anticipated in the spec. It appears
   after tool execution. Stream parsers should tolerate unknown event types.

7. **`--replay-user-messages` flag.** New flag that re-emits user messages from
   stdin back on stdout. Not needed for claw-drive's current architecture but
   noted for reference.

## Open questions answered vs still-open

### Answered

- **Input format**: confirmed as `{"type":"user","message":{"role":"user","content":"..."}}` per line.
- **Output event types**: `system` (hook_started, hook_response, init), `assistant` (multiple per turn), `user` (tool results), `rate_limit_event`, `result`.
- **Tool call shape**: `tool_use` block with `id`, `name`, `input`, `caller`.
- **Tool result shape**: `user` event with `tool_result` content block + `tool_use_result` with stdout/stderr.
- **Permission mode**: `--permission-mode=bypassPermissions` works as expected, no prompts.
- **`--mcp-config` format**: standard `{ "mcpServers": {...} }` confirmed.
- **Multiple assistant events per turn**: confirmed (spec assumed one).

### Still open

- **`--permission-prompt-tool` alternative for approver shim**: flag is absent.
  Task 16 (approver shim) must be redesigned. Recommended path: PreToolUse hook
  that calls back to claw-drive's approval API.
- **Content-as-array input**: not probed. Likely works (Anthropic API standard)
  but not confirmed.
- **Error result shape**: `subtype` of error cases (e.g. `error_max_turns`,
  `error_api`, etc.) not observed. Should probe with intentional failures.
- **Multi-turn input after first turn**: how to send a second user message in
  `--max-turns > 1` mode was not probed (only tool results mid-turn were seen).
  May require a second line on stdin or may not be possible in pipe mode.

## Full flag list (relevant subset)

```
-p, --print                    Non-interactive mode (required for all pipe usage)
--input-format stream-json     Line-delimited JSON input
--output-format stream-json    Line-delimited JSON output (streaming)
--permission-mode bypassPermissions   Skip all permission prompts
--max-turns <n>                Maximum turns before terminating
--verbose                      Include hook events in stream (adds noise)
--include-hook-events          Include hook lifecycle events (alternative to --verbose)
--include-partial-messages     Include streaming chunks as they arrive
--no-session-persistence       Do not save session to disk
--mcp-config <file-or-json>    Load MCP server configs
--strict-mcp-config            Use only --mcp-config servers (ignore ~/.claude/mcp.json etc.)
--tools <list>                 Restrict to specific built-in tools
--allowedTools / --disallowedTools   Fine-grained tool allow/deny lists
--system-prompt <text>         Override system prompt
--append-system-prompt <text>  Append to default system prompt
--bare                         Minimal mode: skip hooks, plugins, CLAUDE.md, keychain
--replay-user-messages         Echo stdin user messages back on stdout
--session-id <uuid>            Use a specific session ID
--model <alias-or-full-name>   Override model
--max-budget-usd <amount>      Spend cap
```
