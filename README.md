# claw-drive

Drive-as-user MCP server + CLI for Claude Code. Lets one Claude Code session drive a second fresh Claude Code session end-to-end for dogfooding — multi-turn conversation, async event polling, policy-gated permissions with human-in-the-loop escalation, restart-resilient across caller restarts.

> Status: v0.1.0. Single-user, single-host, local only.

## How it works

- Your **dev session** (Session A, running Claude Code where you're building something) asks claw-drive to spawn a fresh **driven session** (Session B) in another directory.
- Session B is a real `claude -p --input-format=stream-json --output-format=stream-json` subprocess. It runs like a user would — it even uses hooks.
- Every tool call B makes is gated through a PreToolUse hook that talks to claw-drive's runner. Policy rules auto-approve, auto-reject, or escalate to you.
- Events stream to `~/.claw-drive/sessions/<id>/events.jsonl` — MCP `poll_*` tools and `claw-drive tail` both read it.

See `docs/superpowers/specs/2026-04-21-claw-drive-design.md` for the full design.

## Install

```bash
git clone <your fork> claw-drive
cd claw-drive
./install.sh
```

The installer symlinks `claw-drive` + `claw-drive-approver` into `~/.local/bin/`, builds if needed, and sanity-runs the CLI. If `~/.local/bin` isn't on your `PATH`, it prints the one-liner to add.

Runtime deps for the Bash approver: **`jq`** and a Unix-socket-capable **`nc`** (OpenBSD `nc` or nmap `ncat`). The installer warns if either is missing — install via your package manager:

- Debian/Ubuntu: `sudo apt install jq netcat-openbsd`
- macOS: `brew install jq nmap`

### Install flags

```bash
./install.sh --copy                              # Copy binaries instead of symlinking (snapshot install;
                                                 # re-run after repo updates to refresh the copy)
./install.sh --bin-dir /usr/local/bin            # Custom install location (may need sudo)
./install.sh --project ~/Workspace/cloverleaf    # Also register claw-drive in that project's .mcp.json
./install.sh --policy ~/Workspace/cloverleaf/.cloverleaf/claw-drive-policy.json
                                                 # Also drop the starter policy template there
./install.sh --uninstall                         # Remove bins (and the .mcp.json entry with --project)
```

All flags compose. Typical first-run for a cloverleaf dogfood:

```bash
./install.sh \
  --project ~/Workspace/cloverleaf \
  --policy  ~/Workspace/cloverleaf/.cloverleaf/claw-drive-policy.json
```

Installer is idempotent — re-run it any time (to switch modes, change bin dir, re-register a project, etc.).

### Manual install (without the script)

```bash
npm install && npm run build
ln -s "$(pwd)/bin/claw-drive"          ~/.local/bin/
ln -s "$(pwd)/bin/claw-drive-approver" ~/.local/bin/
```

## Quick start — from the CLI

```bash
# Start a session with bypass policy
mkdir -p ~/tmp/demo && echo hi > ~/tmp/demo/readme.txt
echo '"bypass"' > /tmp/policy.json
SESS=$(claw-drive start --cwd ~/tmp/demo --policy /tmp/policy.json)

# Drive it
claw-drive send "$SESS" "Read readme.txt and report its contents."
claw-drive tail "$SESS" --follow  # Ctrl-C when you see turn_completed

# Stop
claw-drive stop "$SESS"
```

## Quick start — from a Claude Code MCP client

Add to your project's `.mcp.json`:

```json
{ "mcpServers": { "claw-drive": { "command": "claw-drive", "args": ["mcp"] } } }
```

In your Claude Code session ask:

> Use claw-drive to start a session in `/path/to/project`, send the contents of `scenario.md` as a user turn, and poll until it's done. Surface any pending approvals.

Claude Code calls `start_session`, `send_turn`, `poll_turn`, `resolve_tool_call` via MCP.

## Recommended driving pattern (Monitor + watch)

Instead of polling `poll_turn` in a loop-and-ask-user cycle, wire Session A to react to notable events via Claude Code's `Monitor` tool. `start_session` returns a ready-made `watch_command` payload for exactly this:

```
// A's flow
const { session_id, watch_command } = await claw-drive.start_session({
  cwd: "/path/to/project",
  policy: <policy>,
  scenario_brief: "<the brief>",
});

await Monitor(watch_command);  // spawns `claw-drive watch <id>` and streams notifications

// A now waits for notifications. For each:
//   kind === "tool_decision_required" → surface to human, resolve_tool_call or provide_tool_output
//   kind === "tool_output_provided"   → confirm defer follow-through completed
//   kind === "turn_completed"         → decide whether to send next turn or wrap up
//   kind === "turn_failed"            → surface the failure details
//   kind === "session_stopped"        → wrap up
```

`claw-drive watch` filters `events.jsonl` to only events a human/A needs to act on (see `docs/superpowers/specs/...` §4.8 for the exact predicate). It exits cleanly on `session_stopped` or SIGINT.

## Policy

A policy is either `"bypass"` (no gating) or an object. Rules in order: `auto_approve` wins over `auto_reject`; unmatched calls escalate by default.

```json
{
  "auto_approve": [
    { "tool": "Read" },
    { "tool": "Bash", "bash_command_matches": "^git (status|diff|log|show|branch) " }
  ],
  "auto_reject": [
    { "tool": "Bash", "bash_command_matches": "sudo |rm -rf |git push ", "severity": "high" }
  ],
  "escalate_default": true,
  "decision_timeout_seconds": 300
}
```

On timeout: the `default_action` for escalated calls is `approve` (when `escalate_default: true`) or `reject` (when `escalate_default: false`). The approver script self-times-out 5s before claude's 600s hook ceiling and fails secure (exit 2 / deny).

### Deferring commands the human must run

Some commands can't run inside B (sudo, interactive logins, anything needing auth or a TTY). Put them in `auto_defer` in your policy:

```json
"auto_defer": [
  { "tool": "Bash", "bash_command_matches": "^sudo\\s", "name": "sudo → human" }
]
```

When B attempts a matching call, the approver hook denies it with a `DEFERRED:` message, a `tool_decision_required` event surfaces to the monitor, and the human runs the command locally. Once they have the output, call `claw-drive provide-output <call_id> --stdout "<output>" --exit 0` (or the `provide_tool_output` MCP tool). The runner formats the output as a user turn to B and B continues.

### Review gates (B pauses for human OK mid-task)

Use the `CLAW-GATE:` convention — baked into the default policy template:

```json
"auto_defer": [
  { "tool": "Bash", "bash_command_matches": "^echo 'CLAW-GATE:" }
]
```

In the scenario brief, tell B: *"Before each risky step, run `echo 'CLAW-GATE: <your question>'` with the Bash tool and wait for my response."*

B's echo fires the hook → policy defers → monitor alerts A → human answers → A calls `provide_tool_output` with the answer as stdout → B reads it and proceeds. No new primitive; same flow as sudo.

## MCP tools

| Tool | Purpose |
|---|---|
| `start_session` | Start a driven session; returns `{session_id, watch_command}` (the latter is a ready-made Monitor payload) |
| `stop_session` | Reap B; keep session dir for inspection |
| `send_turn` | Non-blocking; returns `turn_id` |
| `poll_turn` | Fetch events + status for a turn (optional long-poll) |
| `poll_session` | Tail all events for a session |
| `list_sessions` | List live + orphaned sessions |
| `resolve_tool_call` | Approve/reject a paused tool call; optionally remember as policy |
| `update_policy` | Replace a session's policy |
| `interrupt_turn` | SIGINT B to cancel the current turn |
| `provide_tool_output` | Inject human-run command output back into B's conversation; auto-resolves pending defer if needed |

Full signatures in `docs/superpowers/specs/2026-04-21-claw-drive-design.md` §5.

## CLI

| Command | Purpose |
|---|---|
| `sessions` | List sessions (live + orphaned) |
| `show <session>` | State + last 20 events |
| `tail <session> [--since N] [--follow]` | Stream events |
| `pending [<session>]` | List awaiting-approval calls |
| `approve <call_id> [--reason R]` | Approve a paused call |
| `reject <call_id> [--reason R]` | Reject a paused call |
| `send <session> "<msg>"` | Send a user turn |
| `start --cwd PATH [--policy FILE] [--brief FILE]` | Start a session |
| `stop <session>` | Reap B |
| `interrupt <session> <turn>` | SIGINT B |
| `policy <session> [--set FILE] [--show]` | View/replace policy |
| `prune [--older-than 24h]` | Remove dead sessions older than cutoff |
| `watch <session>` | Stream noteworthy events as JSONL (used internally by the Monitor flow) |
| `provide-output <call_id> [--stdout S] [--stderr S] [--exit N] [--extra S] [--from-file PATH]` | Relay human-run command output to a deferred call |

## Troubleshooting

### Orphaned sessions

`claw-drive sessions` flags sessions as `orphaned` when the runner pid is dead but state still says running. `claw-drive prune --older-than 1h` cleans them up.

### Stuck on an approval

`claw-drive pending` shows paused calls. `claw-drive approve <call_id>` or `reject <call_id>` unsticks B. If decision times out, the default action fires automatically.

### Missing `jq` / `nc`

The Bash approver requires `jq` and a Unix-socket-capable `nc` (or `ncat`). Install via your package manager. If the approver script exits 2 with `"approver: neither ncat nor nc found on PATH"`, that's the cause.

### Stream-json parse errors in events

If you see `error` events with `"unparseable stream-json line"`, claude's output format may have changed. Re-run `scripts/probe-claude-cli.sh` and update the stream parser accordingly.

## Defaults worth knowing

### `decision_timeout_seconds: 3600` (1 hour)

The v0.2 start-time default. If an escalation sits unresolved for this long, the runner fires the rule's `default_action` (`approve` for plain escalations, `reject` for `auto_reject` matches, `defer` for `auto_defer` matches) and emits `tool_decision_resolved(resolved_by:"timeout")`. You can override per-session via `start_session`'s `decision_timeout_seconds` arg, or per-policy via the policy object's field.

The v0.1 default was 300 s. It was a footgun for interactive dogfoods — if the driver's monitor had a transient gap, sensitive calls auto-approved silently. 1 h gives humans enough slack.

### `claw-drive watch` defaults to current seq

`watch` does **not** replay historical events by default — it starts from the current end of `events.jsonl` and streams new ones as they arrive. Pass `--replay` (or `--since 0`) for a full replay.

This was a deliberate change from `tail --follow`, which does replay from 0. `watch` is intended for `Monitor` flows where a mid-run subscription should not flood the driver.

### `poll_session` can hit the MCP token budget

Under heavy concurrency (e.g., B with many subagents), a single `poll_session` call can return hundreds of events. The MCP response has a token limit. Use `claw-drive watch` (filtered + streaming) for active driving; reserve `poll_session` for one-shot catch-up between clear checkpoints.

A future pagination overhaul is tracked for v0.3.

## Policy templates

Two policy templates ship in `templates/`:

- **`claw-drive-policy.json`** — conservative starter. Default for `install.sh` and when no `--policy` is passed to `start_session`. Safe for unknown projects.
- **`claw-drive-policy-permissive.json`** — starter plus common dev-CLI auto-approves (`rg`, `sed`, `awk`, `jq`, `diff`, `mkdir -p`, `touch`, `cp` (non-recursive), `mv`, safe `git` ops like `fetch` and `pull --ff-only`, path/env introspection). Reduces escalation volume in dev-heavy dogfood sessions. Destructive commands (`rm -rf`, `git push`, `git reset --hard`, etc.) still auto-reject. Opt in via `--policy templates/claw-drive-policy-permissive.json` at install or by passing the inline policy to `start_session`.

## Testing

- `npm run test:unit` — 64 unit tests, no real claude invocation
- `npm run test:integration` — 5 integration tests spawning real claude (cost real tokens)
- `bash scripts/self-dogfood.sh` — end-to-end acceptance smoke

## License

MIT
