# Compatibility guarantee — claw-drive 1.0

claw-drive 1.0 is a stability promise. Consumers — drivers built on the MCP
tools, hand-authored policy files, CI that shells the CLI — can build on
claw-drive and rely on the surfaces below remaining stable for the entire 1.x
line. Breaking changes are reserved for the next major version (2.0).

The versioning follows [SemVer](https://semver.org/). Within the 1.x line,
releases may be additive (new tools, fields, event kinds, CLI commands, or
flags); they will not remove, rename, or incompatibly change anything listed
here.

---

## Additive vs. breaking

**Additive — allowed in any 1.x minor/patch:**

- A new optional field in the policy schema.
- A new MCP tool.
- A new event kind.
- A new CLI subcommand or flag.
- A new optional response field in any MCP tool.
- A new always-surface sentinel token (existing consumers ignore unknown tokens).

**Breaking — 2.0 only:**

Removing or renaming any frozen field, tool, tool argument, event kind, CLI
flag, or sentinel token; changing a field's type or required-ness; or an
incompatible default-behaviour change.

For calibration: the v0.2.3 evaluation-order flip (`auto_approve` before
`auto_reject` → `auto_reject` before `auto_approve`) and the 300→3600 s
`decision_timeout_seconds` default would both have been "breaking" under this
policy.

---

## Frozen surfaces

### 1. Policy schema (`src/lib/policy.ts`)

A policy is either the string `"bypass"` or a `PolicyObject`. Both forms are
stable.

**`PolicyObject` top-level keys (all optional):**

| Key | Type | Description |
|-----|------|-------------|
| `auto_reject` | `Rule[]` | Matched first of all; matching calls are escalated with `default_action: "reject"`. |
| `auto_defer` | `Rule[]` | Matched second; matching calls are escalated with `default_action: "defer"`. |
| `auto_approve` | `Rule[]` | Matched third; matching calls are approved silently. |
| `escalate_default` | `boolean` | When no rule matches, escalate (`true`, the default) or deny silently (`false`). |
| `decision_timeout_seconds` | `number` | Per-session gate timeout. Defaults to 3600 if absent. |
| `schema_version` | `number` | See [schema\_version](#schema_version) below. _(Introduced by the CD-1 contract-freeze work; part of the 1.0 contract, not a field that predates it.)_ |
| `budget` | `{ max_tool_calls?, max_wall_clock_seconds?, max_consecutive_errors? }` | Run-level circuit-breaker (CD-4). All caps optional and positive; an absent cap is unlimited and an absent `budget` is off. On breach the runner stops the session with `exit_reason: "budget_exceeded:<cap>"`. |

**Evaluation order** (contract as of v0.2.3, frozen):

```
auto_reject > auto_defer > auto_approve > escalate_default
```

Rationale: asymmetric risk — a false-reject produces a human prompt; a
false-approve produces a silent bypass. A command matching both an approve and
a reject rule is rejected.

**`Rule` shape (all fields on each rule object):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool` | `string` | yes | Exact tool name or `/regex/` (slash-delimited) to match against the tool name. |
| `bash_command_matches` | `string` | no | Regex applied to the Bash `command` argument. Only used when `tool` is `"Bash"`. |
| `arg_matches` | `Record<string, string>` | no | Per-argument regex map for non-Bash tools. |
| `severity` | `"low" \| "medium" \| "high"` | no | Severity hint surfaced on escalation events. |
| `name` | `string` | no | Human-readable label for the rule. |

**Metadata keys:** any top-level key that starts with `_` (underscore) is
treated as a comment/metadata field and is silently ignored by the validator.
This convention is frozen; `_`-prefixed keys will never collide with a future
defined key.

**`"bypass"` form:** the literal string `"bypass"` is a valid policy value.
It bypasses policy evaluation entirely; every tool call is approved silently.

#### `schema_version` {#schema_version}

`schema_version` is the policy-file version marker introduced by the CD-1
contract-freeze work and landing in the 1.0 line (a sibling CD task adds it to
`src/lib/policy.ts`). The constant `POLICY_SCHEMA_VERSION = 1` names the schema
version.

Semantics (strict + implicit v1):

- Field **absent** → treated as `1`. Every existing policy file validates
  without modification.
- Field **present and `=== 1`** → accepted.
- Any **other value** → rejected with an error naming the supported version
  (e.g. `policy schema_version 2 is not supported; this build supports version 1`).

This is purely additive: it adds an optional field and a rejection path for
impossible-today values. No existing valid policy becomes invalid.

---

### 2. MCP tools (`src/mcp/tool-defs.ts`, served by `src/mcp/server.ts`)

The server exposes exactly **10 tools**. The tool names, required inputs, and
response shapes listed here are frozen.

#### `start_session`

Start a new driven Claude Code session.

**Inputs:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | `string` | yes | Working directory for the new session (must be inside `$HOME`). |
| `policy` | policy object or `"bypass"` | no | Permission policy. Defaults to `"bypass"`. |
| `scenario_brief` | `string` | no | Scenario text injected into the session. |
| `mcp_extra_config` | `object` | no | Extra MCP server config merged into the session's `mcp.json`. |
| `model` | `string` | no | Claude model override. |
| `decision_timeout_seconds` | `number` | no | Gate timeout in seconds. |
| `wrapper` | `boolean` | no | Whether to inject the sentinel-token wrapper into the driven session's system prompt. Defaults to `true`. Pass `false` for raw (no-token-filter) mode. |

**Response:**

```json
{
  "session_id": "<string>",
  "watch_command": {
    "command": "<string>",
    "args": ["watch", "<session_id>"],
    "description": "<string>",
    "timeout_ms": 3600000,
    "persistent": true
  },
  "notification_contract": { ... }
}
```

The `watch_command` shape is a ready-made payload for the Monitor tool.
The `notification_contract` shape is described in the
[notification\_contract](#notification_contract) section.

#### `stop_session`

Stop a session. Reaps the Claude Code process; keeps the session directory.

**Required input:** `session_id: string`

**Response:** `{ "ok": true }`

#### `send_turn`

Send a user turn to a live session. Non-blocking; returns a `turn_id` to poll.

**Required inputs:** `session_id: string`, `message: string`

**Response:** `{ "turn_id": "<string>", ... }`

#### `poll_turn`

Fetch events and derived status for a specific turn.

**Required inputs:** `session_id: string`, `turn_id: string`

**Optional inputs:** `since_event: number`, `wait_ms: number`

**Response:** `{ "events": [...], "turn_status": "<running|awaiting_approval|completed|failed>", "next_since": <number> }`

#### `poll_session`

Tail events for a session and return current session status.

**Required input:** `session_id: string`

**Optional inputs:** `since_event: number`, `wait_ms: number`

**Response:** `{ "events": [...], "session_status": "<string>", "next_since": <number> }`

#### `list_sessions`

List sessions on disk (live and orphaned).

**Optional input:** `include_orphaned: boolean`

**Response:** `{ "sessions": [{ "session_id", "status", "cwd", "started_at", "last_event_at", "turns", "pending_approvals" }, ...] }`

#### `resolve_tool_call`

Approve or reject a paused tool call by `call_id`.

**Required inputs:** `call_id: string`, `action: "approve" | "reject"`, `reason: string`

**Optional inputs:** `remember_as_policy: boolean`, `preview_only: boolean`, `remembered_rule: Rule`

- `preview_only` — return `{ would_remember, list, source, bypass? }` for the rule that would be remembered; the call is **not** resolved and policy is **not** mutated.
- `remembered_rule` — append this explicit (edited) rule instead of the derived one. Validated; an invalid rule returns `BAD_RULE` and resolves nothing.

**Response:** `{ "ok": true }` — or, when `preview_only: true`: `{ "ok": true, "result": { "would_remember", "list", "source", "bypass"? } }`

#### `provide_tool_output`

Provide the output of a deferred command run manually by the human. Injects
the output as a new user turn; auto-resolves any still-pending approval as
`"defer"`.

**Required inputs:** `session_id: string`, `call_id: string`

**Optional inputs:** `stdout: string`, `stderr: string`, `exit_code: number`, `extra: string`

**Response:** `{ ... }` (forwarded from runner)

#### `update_policy`

Replace a session's permission policy.

**Required inputs:** `session_id: string`, `policy` (policy object or `"bypass"`)

**Response:** `{ "ok": true }`

#### `interrupt_turn`

Send SIGINT to the driven Claude session to interrupt the current turn.
Session remains alive.

**Required inputs:** `session_id: string`, `turn_id: string`

**Response:** `{ "ok": true }`

---

### 3. Event `kind` set (`src/lib/events.ts`)

These are the full set of event kinds written to `events.jsonl`:

```
session_started
session_stopped
turn_started
turn_completed
turn_failed
assistant_text
thinking
tool_call_requested
tool_decision_required
tool_decision_resolved
tool_call_started
tool_call_result
tool_output_provided
error
```

#### `VALID_WATCH_KINDS` — watch-surfaced event kinds

The `VALID_WATCH_KINDS` constant (exported from `src/cli/commands/watch.ts`)
enumerates the 9 event kinds that `claw-drive watch` can surface to consumers.
This set is part of the public contract:

```
tool_decision_required
tool_decision_resolved
tool_output_provided
turn_completed
turn_failed
error
session_stopped
tool_call_result
idle
```

`idle` is a synthetic event (negative `seq`) emitted by `watch` when no
surfaced activity has occurred for the configured threshold
(`--idle-after SECONDS`, default 600).

---

### 4. CLI subcommands (`src/cli/registry.ts`, dispatched by `src/cli/cli.ts`)

**17 subcommands** are frozen (the design doc referenced 18; the actual
implementation has 17).

| Subcommand | Flags |
|------------|-------|
| `sessions` | _(none)_ |
| `show <session>` | _(none)_ |
| `tail <session>` | `--since N`, `--follow` / `-f` |
| `watch <session>` | `--since N`, `--replay`, `--only KIND[,KIND]...`, `--decision-only`, `--no-token-filter`, `--idle-after SECONDS` |
| `pending [<session>]` | _(none)_ |
| `approve <call_id>` | `--reason R`, `--remember`, `--remember-as JSON`, `--preview`, `--json` |
| `reject <call_id>` | `--reason R`, `--remember`, `--remember-as JSON`, `--preview`, `--json` |
| `defer <call_id>` | `--reason R`, `--remember`, `--remember-as JSON`, `--preview`, `--json` |
| `send <session> "<message>"` | _(none)_ |
| `start` | `--cwd PATH` (required), `--policy FILE`, `--brief FILE`, `--no-wrapper` |
| `stop <session>` | _(none)_ |
| `interrupt <session> <turn>` | _(none)_ |
| `policy <session>` | `--set FILE`, `--show` |
| `policy-test '<command>'` | `--tool TOOL`, `--arg KEY=VALUE`, `--policy SPEC`, `--explain`, `--json`, `--exit-on DECISION`, `--no-color`, `--help` / `-h` |
| `status [<session>]` | `--json`, `--help` / `-h` |
| `prune` | `--older-than DURATION` |
| `provide-output <call_id>` | `--stdout S`, `--stderr S`, `--exit N`, `--extra S`, `--from-file PATH` |

**Global flags** (handled before subcommand dispatch):

| Flag | Description |
|------|-------------|
| `--version` / `-v` | Print the installed version and exit. |
| `--help` / `-h` | Print the capability map and exit. |
| `help` (and a bare `claw-drive`) | Print the capability map and exit. |

---

### 5. Sentinel vocabulary (`src/lib/tokens.ts`)

**Two tokens** in `VOCAB`:

| Token | Surface mode | Semantic |
|-------|-------------|---------|
| `[NEEDS-INPUT]` | `always` | The driven session needs the human to provide something to proceed — a fact, decision, confirmation, clarification, or direction after a failure it cannot recover from on its own. |
| `[DONE]` | `always` | Task complete. No further turns expected from the driven session. |

Both tokens are always-surface: `watch` (with its default token filter active)
surfaces a `turn_completed` event whenever the driven session ends a turn with
one of these tokens.

**`TRAILING_TOKEN_RE`** — the canonical trailing-token regex (frozen shape):

```
/(?:^|\n)[ \t]*\[([A-Z][A-Z0-9-]*)\]\s*$/
```

Matches a `[TOKEN]` that is on its own line at the very end of a message.
Identifier shape: starts with `[A-Z]`, then zero or more `[A-Z0-9-]`.
Trailing whitespace (including CRLF) after the token is allowed.

**Surface-mode semantics:** unknown tokens are `"silent"` (conservative
default). A new always-surface token is an additive change; existing consumers
that apply `TRAILING_TOKEN_RE` will extract it but, seeing it absent from their
known-always set, will treat it as silent. This is the safe upgrade path.

---

### 6. `notification_contract` (`src/lib/tokens.ts`)

The `notification_contract` object is returned by `start_session` and
describes the session's vocabulary, surface modes, watch invocation, and idle
configuration. Shape:

```typescript
{
  version: 1;                              // always 1 in the 1.x line
  wrapper_enabled: boolean;                // reflects the `wrapper` flag passed to start_session
  vocabulary: Array<{
    token: string;
    semantic: string;
    surface: "always" | "silent";
  }>;
  watch_command: string;                   // "<bin> watch <session_id>"
  watch_flags: Record<string, string>;     // documentation map for watch flags
  idle_after_seconds: number;              // default 600
}
```

`version: 1` is pinned. The object shape is additive-extensible: new optional
fields may appear in 1.x releases; existing fields will not be removed or
renamed.

Consumers should read `notification_contract` at session-start time rather than
hardcoding assumptions about a specific claw-drive version.
