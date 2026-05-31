# claw-drive

Drive-as-user MCP server + CLI for Claude Code. Lets one Claude Code session drive one or more fresh Claude Code sessions end-to-end — multi-turn conversation, async event polling, policy-gated permissions with human-in-the-loop escalation, restart-resilient across caller restarts.

**Website:** https://renatodarrigo.github.io/claw-drive/ — install, policies, driving patterns, reference.

<a href="https://ko-fi.com/renatodarrigo" target="_blank" rel="noopener noreferrer"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support on Ko-fi"></a>

> See `CHANGELOG.md` for release history.

## How it works

- Your **dev session** (Session A, running Claude Code where you're building something) asks claw-drive to spawn one or more fresh **driven sessions** — Session B, C, D, …, each in its own directory.
- Each driven session is a real `claude -p --input-format=stream-json --output-format=stream-json` subprocess. It runs like a user would — it even uses hooks. Sessions run in parallel; each has its own policy, scenario brief, and event log.
- Every tool call a driven session makes is gated through a PreToolUse hook that talks to claw-drive's runner. Policy rules auto-approve, auto-reject, or escalate to you.
- Events stream to `~/.claw-drive/sessions/<id>/events.jsonl` per session — MCP `poll_*` tools and `claw-drive tail` both read it. `claw-drive pending` (and the MCP tool listing) shows awaiting-approval calls across every running session in one view.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash
```

The bootstrap fetches the latest `main` tarball into `~/.local/share/claw-drive/`, builds, and copies `claw-drive` + `claw-drive-approver` into `~/.local/bin/`. Pass flags by separating them from `bash` with `-s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash -s -- \
  --project ~/code/your-project \
  --policy  ~/code/your-project/.claw-drive/policy.json
```

Runtime deps for the Bash approver: **`jq`** and a Unix-socket-capable **`nc`** (OpenBSD `nc` or nmap `ncat`). The installer warns if either is missing:

- Debian/Ubuntu: `sudo apt install jq netcat-openbsd`
- macOS: `brew install jq nmap`

### Claude Code plugin (UX layer)

If you live in Claude Code, install the companion plugin for slash commands (`/claw-drive-init`, `/claw-drive-start`, `/claw-drive-resolve`). The plugin is a UX layer — it does not replace the curl-pipe install, it sits on top of it.

```
# In any Claude Code session:
/plugin marketplace add renatodarrigo/claw-drive
/plugin install claw-drive@claw-drive
```

After install, run `/reload-plugins`, then `/claw-drive-init` in your project to wire claw-drive into `.mcp.json`.

### From source

```bash
git clone https://github.com/renatodarrigo/claw-drive
cd claw-drive
./install.sh
```

Clone-based installs default to **symlink mode** — changes in your working tree apply to the installed bins immediately. Pass `--copy` for a snapshot install instead.

### Install flags

```bash
./install.sh --copy                              # Copy binaries instead of symlinking
./install.sh --bin-dir /usr/local/bin            # Custom install location (may need sudo)
./install.sh --project ~/code/your-project       # Also register claw-drive in that project's .mcp.json
./install.sh --policy ~/code/your-project/.claw-drive/policy.json
                                                 # Also drop the starter policy template there
./install.sh --uninstall                         # Remove bins (and the .mcp.json entry with --project)
```

All flags work with both the curl-pipe (after `bash -s --`) and clone-based forms.

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
//   kind === "tool_decision_required"        → surface to human, resolve_tool_call or provide_tool_output
//   kind === "tool_decision_resolved"        → only when resolved_by === "timeout" — surface the consequence
//   kind === "tool_output_provided"          → confirm defer follow-through completed
//   kind === "turn_completed"                → decide whether to send next turn or wrap up
//   kind === "turn_failed"                   → surface the failure details
//   kind === "error"                         → runner-side error; decide whether to abort
//   kind === "tool_call_result" (is_error)   → a tool call B issued errored; surface
//   kind === "idle"                          → no surfaced event in N seconds; check on B
//   kind === "session_stopped"               → wrap up
```

`claw-drive watch` filters `events.jsonl` to those nine `kind` values — Session B's assistant prose, intermediate tool-call lifecycle events, and successful results stay out of A's stream. It exits cleanly on `session_stopped` or SIGINT.

### Sentinel tokens (the default)

Session B is auto-taught a tiny contract at session start: end your turns with a literal `[TOKEN]` on its own line if (and only if) human attention is needed. `claw-drive watch` parses each `turn_completed`'s last `assistant_text` for the trailing token and surfaces the event only when one is present. No token = silent / autonomous — Session A is not pulled in (with one narrow exception, the silent-miss backstop below).

The shipped vocabulary is two tokens:

| Token | Meaning |
|---|---|
| `[NEEDS-INPUT]` | The human's turn — covers asking, deciding, confirming, clarifying, or recovering from a failure. Anything that requires the human before B can proceed. |
| `[DONE]` | Task complete. Terminal. |

Both default to surface mode `always`; there is nothing to override.

`start_session` returns a `notification_contract` field describing the live vocabulary (token names, semantics, surface modes), the `watch_command` payload, the available watch flags, the idle-after default, and whether the wrapper was injected. Drivers that want to stay forward-compatible should read `notification_contract` at spawn time rather than hardcoding the token list.

### Silent-miss backstop

The sentinel protocol's worst failure is silent: if B *should* have ended a turn with `[NEEDS-INPUT]` but forgot, the turn has no token, `watch` drops it, and Session A assumes B is working autonomously — the session stalls until the idle event eventually fires. Token compliance is high but not perfect, and a miss is invisible.

To catch that, `watch` applies a conservative backstop: when a no-token `turn_completed`'s final non-empty line ends in `?`, the event is surfaced anyway, carrying an additive marker so the driver can tell it apart from a real token:

```json
{"kind":"turn_completed","turn_id":"…","suspected_needs_input":true,"suspected_needs_input_signal":"trailing-question-mark"}
```

A genuine `[NEEDS-INPUT]` turn surfaces *without* this marker; `suspected_needs_input` means "B emitted no token, but its last line looks like a question — likely a forgotten `[NEEDS-INPUT]`." The heuristic is deliberately narrow — a trailing `?` only, no phrase matching — to keep false positives low, so a no-token statement turn still drops exactly as before. The marker is an additive field on the existing `turn_completed` watch JSON; there is no new event kind.

On by default. Pass `--no-suspected-needs-input` to `watch` to disable it (no-token `?` turns drop as before).

### Idle events

If a session is quiet for a while, `claw-drive watch` synthesises an `idle` event so the driver knows nothing is in flight. Default threshold: **600s**. Override via `--idle-after SECONDS` (pass `0` to disable). The timer resets on every surfaced event and cancels on `session_stopped`.

### Narrowing further: `--only` / `--decision-only`

`--only KIND[,KIND]...` restricts the kind universe to a subset (mutually exclusive with `--decision-only`, which is shorthand for the human-attention kinds, including `idle`). These compose with the sentinel filter — they restrict *which kinds* watch even considers, while the sentinel filter restricts *which `turn_completed`s* surface among them.

To bypass the sentinel filter entirely (raw streaming behavior), pass `--no-token-filter`.

To bypass the wrapper injection on the runner side, pass `wrapper: false` to `start_session`. That way B never sees the contract; pair with `--no-token-filter` on watch since there's no sentinel to anchor on.

The `/claw-drive-start` plugin skill defaults to the sentinel-aware behavior. Pass `--verbose` to bypass both layers (no wrapper, no token filter — full raw stream).

## Policy

A policy is either `"bypass"` (no gating) or an object. Rules are evaluated `auto_reject` → `auto_defer` → `auto_approve`; the first match wins, so a reject beats an approve. Unmatched calls escalate by default.

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
  "decision_timeout_seconds": 3600
}
```

On timeout: the `default_action` for escalated calls is `approve` (when `escalate_default: true`) or `reject` (when `escalate_default: false`). The approver script self-times-out 5s before claude's 600s hook ceiling and fails secure (exit 2 / deny).

### Linting a policy

`claw-drive policy lint <file>` analyzes a whole policy for structural problems before you trust it — a complement to `policy-test`, which checks one command at a time. Default checks:

- **regex compile errors** — a `bash_command_matches` / `arg_matches` pattern that won't compile;
- **shadowed / unreachable rules** — a rule an earlier, stricter rule always wins over (per the evaluation order above);
- **overly-broad patterns** — a pattern that matches the empty string or leads with `.*` / `.+`;
- **known false-positive shapes** — a write-shaped reject rule that would catch a read-intent backup like `cp config.json /backup/`.

```bash
claw-drive policy lint ./my-policy.json                     # human-readable, grouped by severity
claw-drive policy lint --json ./my-policy.json              # { file, findings, summary } for jq / CI
claw-drive policy lint --max-severity warn ./my-policy.json # exit 1 on any warn-or-error (CI gate)
claw-drive policy lint --check-coverage ./my-policy.json    # also flag uncovered danger families
```

`--max-severity warn|error` sets the exit-code threshold (omit for report-only). `--check-coverage` is opt-in: it flags common destructive families (`rm -rf`, `git push`, `dd`, `mkfs`, interpreter escapes) the policy neither rejects nor defers. Both shipped templates lint clean — no findings — by default.

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
| `start_session` | Start a driven session; returns `{session_id, watch_command, notification_contract}`. `watch_command` is a ready-made Monitor payload; `notification_contract` describes the session's sentinel vocabulary, watch flags, and idle threshold so drivers can stay forward-compatible. Optional `wrapper: false` opts out of injecting the sentinel-token contract into B's system prompt. |
| `stop_session` | Reap B; keep session dir for inspection |
| `send_turn` | Non-blocking; returns `turn_id` |
| `poll_turn` | Fetch events + status for a turn (optional long-poll) |
| `poll_session` | Tail all events for a session |
| `list_sessions` | List live + orphaned sessions |
| `resolve_tool_call` | Approve/reject a paused tool call; optionally remember as policy |
| `update_policy` | Replace a session's policy |
| `interrupt_turn` | SIGINT B to cancel the current turn |
| `provide_tool_output` | Inject human-run command output back into B's conversation; auto-resolves pending defer if needed |

## CLI

| Command | Purpose |
|---|---|
| `sessions` | List sessions (live + orphaned) |
| `show <session>` | State + last 20 events |
| `tail <session> [--since N] [--follow]` | Stream events |
| `pending [<session>]` | List awaiting-approval calls |
| `approve <call_id> [--reason R] [--remember]` | Approve a paused call. `--remember` derives a rule and appends to `auto_approve`. |
| `reject <call_id> [--reason R] [--remember]` | Reject a paused call. `--remember` appends to `auto_reject`. |
| `defer <call_id> [--reason R] [--remember]` | Defer a paused call to the human. `--remember` appends to `auto_defer`. |
| `send <session> "<msg>"` | Send a user turn |
| `start --cwd PATH [--policy FILE] [--brief FILE]` | Start a session |
| `stop <session>` | Reap B |
| `interrupt <session> <turn>` | SIGINT B |
| `policy <session> [--set FILE] [--show]` | View/replace a session's policy |
| `policy-test '<command>' [flags]` | Diagnose a tool call against a policy. Three output formats (default human, `--explain`, `--json`); multi-tool via `--tool TOOL --arg KEY=VALUE`; `--policy starter\|permissive\|bypass\|<file>`; `--exit-on reject\|defer\|approve\|escalate` for CI gating. |
| `prune [--older-than 24h]` | Remove dead sessions older than cutoff |
| `watch <session> [--since N \| --replay] [--only KIND[,KIND]... \| --decision-only] [--idle-after SECONDS] [--no-token-filter] [--no-suspected-needs-input]` | Stream noteworthy events as JSONL. Used by Monitor flows. Sentinel filter is on by default (`turn_completed` surfaces only when the trailing `[TOKEN]` is present). `--no-token-filter` disables the sentinel filter entirely. `--decision-only` and `--only` are kind-level subset filters that compose with the sentinel filter. `--idle-after SECONDS` (default `600`, `0` disables) emits a synthetic `idle` event when no surfaced event has been seen for that long. The silent-miss backstop surfaces a no-token `turn_completed` whose final line ends in `?` with an additive `suspected_needs_input` marker; `--no-suspected-needs-input` disables it. |
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

The v0.1 default was 300 s. It was a footgun for long-running interactive sessions — if the driver's monitor had a transient gap, sensitive calls auto-approved silently. 1 h gives humans enough slack.

### `claw-drive watch` defaults to current seq

`watch` does **not** replay historical events by default — it starts from the current end of `events.jsonl` and streams new ones as they arrive. Pass `--replay` (or `--since 0`) for a full replay.

This was a deliberate change from `tail --follow`, which does replay from 0. `watch` is intended for `Monitor` flows where a mid-run subscription should not flood the driver.

### `poll_session` can hit the MCP token budget

Under heavy concurrency (e.g., B with many subagents), a single `poll_session` call can return hundreds of events. The MCP response has a token limit. Use `claw-drive watch` (filtered + streaming) for active driving; reserve `poll_session` for one-shot catch-up between clear checkpoints.

## Policy templates

Two policy templates ship in `templates/`:

- **`claw-drive-policy.json`** — conservative starter. Default for `install.sh` and when no `--policy` is passed to `start_session`. Safe for unknown projects. Auto-rejects `Edit`/`Write` and Bash write vectors against the policy file itself and `~/.claw-drive/` runtime state — see [docs/policies.html](https://renatodarrigo.github.io/claw-drive/policies.html#policy-file).
- **`claw-drive-policy-permissive.json`** — starter plus common dev-CLI auto-approves (`rg`, `sed`, `awk`, `jq`, `diff`, `mkdir -p`, `touch`, `cp` (non-recursive), `mv`, non-recursive `chmod`/`chown`, safe `git` ops including `git -C <path>` prefix forms, `bash <script>` (rejects `-c` inline form), `rm -f /tmp/...`, comment-prefixed Bash lines (`# rationale`), path/env introspection). Reduces escalation volume in dev-heavy sessions. Destructive commands (`rm -rf`, `git push`, `git reset --hard`, recursive `chmod -R 777`, etc.) still auto-reject — and the comment-prefix rule never beats them since `auto_reject` is evaluated first. Opt in via `--policy templates/claw-drive-policy-permissive.json` at install or by passing the inline policy to `start_session`.

## Testing

- `npm run test:unit` — 570 unit tests, no real claude invocation
- `npm run test:integration` — 8 integration tests spawning real claude (cost real tokens)
- `bash scripts/self-dogfood.sh` — end-to-end acceptance smoke

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
