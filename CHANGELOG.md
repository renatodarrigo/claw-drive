# Changelog

## [Unreleased]

### Added

- `install.sh` — idempotent installer. Default mode symlinks `claw-drive` + `claw-drive-approver` into `~/.local/bin`; `--copy` mode writes an absolute-path shim + a self-contained approver copy; `--project <path>` merges claw-drive into that project's `.mcp.json` (preserving other entries); `--policy <path>` drops the starter `templates/claw-drive-policy.json` template; `--uninstall` removes bins and the `.mcp.json` entry cleanly.
- `templates/claw-drive-policy.json` — starter dogfood policy (auto-approves Read/Glob/Grep + common safe Bash; auto-rejects destructive Bash; escalates the rest).
- `CLAW_DRIVE_APPROVER_BIN` environment variable — overrides the default package-relative approver resolution in `paths.approverBinPath()`. Set by the copy-mode shim so the MCP server's `settings.json` points at the installed copy instead of the repo's original.

### Fixed

- `approverBinPath()` now honors `CLAW_DRIVE_APPROVER_BIN` before falling back to the package-relative default. Required for copy-mode installs.

### Tests

- 2 new unit tests: `approverBinPath honors CLAW_DRIVE_APPROVER_BIN when set`, `approverBinPath ignores empty CLAW_DRIVE_APPROVER_BIN`. Existing test hardened to clear the env var before running.

## [0.1.0] — 2026-04-22

Initial release.

### Features

- **MCP server** exposing 9 tools for driving a fresh Claude Code session: `start_session`, `stop_session`, `send_turn`, `poll_turn`, `poll_session`, `list_sessions`, `resolve_tool_call`, `update_policy`, `interrupt_turn`.
- **CLI** with 12 subcommands as a peer of the MCP server over the same on-disk state and Unix-socket protocol.
- **Policy-gated permissions** via a `PreToolUse` hook: `auto_approve` / `auto_reject` / `escalate_default` / `decision_timeout_seconds`. The approver script is Bash (5–15 ms cold start) and fails secure on runner-unreachable or self-timeout.
- **Restart resilience:** runners are detached per-session processes. Session A can crash, `/clear`, or restart; the runner keeps going and state on disk is recoverable.
- **Event log** at `~/.claw-drive/sessions/<id>/events.jsonl` with monotonic `seq` numbering; polling is `since_event`-based.

### Tech

- Node 20+, TypeScript strict (ES2022, Node16 modules), `@modelcontextprotocol/sdk` ^1.12.
- Runtime system deps (for the Bash approver): `jq`, `nc` (OpenBSD) or `ncat` (nmap).
- Tests: 64 unit (Vitest) + 5 integration (real `claude -p`) all passing.

### Architecture

See `docs/superpowers/specs/2026-04-21-claw-drive-design.md`.

Key design choices:
- Per-session detached runner owns one `claude -p` subprocess.
- MCP server and CLI are symmetric thin clients over the runner's Unix socket.
- `--permission-prompt-tool` doesn't exist in claude 2.1.117 (discovered during `scripts/probe-claude-cli.sh`); we use `--settings` + PreToolUse hook instead.
- 600s default hook timeout (configurable per hook entry); approver self-times-out at 595s to fail-secure under claude's 600s ceiling.
