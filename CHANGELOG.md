# Changelog

## [0.2.2] — 2026-04-24

### Fixed

- **`state.json` rename-race: spurious `is_error: true` cancellations in multi-turn runs.** `writeState` used `.tmp-<process.pid>` as the intermediate filename — but the pid is shared across every writer in the runner, so two concurrent `writeState` calls collided on the same tmp. Whichever renamed second hit `ENOENT` because the first had already renamed the tmp away. The error bubbled up to the approver as `HANDLER_ERROR: ENOENT: no such file or directory, rename '~/.claw-drive/sessions/<sid>/state.json.tmp-<pid>' -> '~/.claw-drive/sessions/<sid>/state.json'`, surfaced as a `tool_call_result` with `is_error: true`, and Claude cancelled the sibling parallel tool calls. Surfaced during the CLV-16 and CLV-17 Delivery dogfoods (2026-04-22). Fix: per-path Promise-chain mutex inside `writeState` — all in-process writes against a given path are queued in submission order, so the final state.json reflects the last submitted payload (causal ordering). Memory-bounded to one entry per path; aligned with the single-writer-per-session invariant.

### Added

- **4 new unit tests in `tests/unit/state-concurrency.test.ts`** — 100 concurrent writes without error, last-submission-wins semantics, 10-burst stress, and two-path independence. Red/green verified: the suite fails against pre-fix code with the exact ENOENT the bug produced.
- **`templates/claw-drive-policy-permissive.json`** — opt-in policy template that extends the conservative starter with common dev-CLI auto-approves (`rg`, `sed -n`, `awk`, `jq`, `diff`, `cmp`, `column`, `mkdir -p`, `touch`, `cp` (non-recursive), `mv`, safe `git` ops like `fetch`, `pull --ff-only`, `rebase --abort` and friends, path/env introspection `which`/`printenv`/`realpath`/etc.). Destructive rules, `sudo`/`su` auto-defer, and CLAW-GATE convention preserved verbatim from the starter (enforced by a structural-equality test). Selected via `--policy` at install time or by passing inline to `start_session`. The conservative starter remains the default.
- **8 new unit tests covering positive matches across four categories** (read/inspect CLIs, non-destructive file ops, safe git ops, path/env introspection) plus preserved safety posture (`cp -r`, `rm -rf`, `git push`, `sudo` all still escalate or defer). Plus **4 drift-guard tests** added during code-review hardening that lock in three non-obvious regex semantics (`env` is not approved, `cp` recursive forms `-R`/`-a`/`-pR`/`--recursive`/`--archive` still escalate, bogus prefix-matched subcommands like `git fetchx`/`whichever`/`typeset` still escalate) and one structural invariant (`auto_defer`/`auto_reject` arrays in the permissive template equal the starter's, deep-equal).
- **Regression test `tests/unit/pending-jq.test.ts`** — pipes `claw-drive pending` output through `jq -c '.'` for six tricky byte-range samples (control chars 0x01–0x1f, tab/CR/LF, quotes/backslashes, multibyte UTF-8, embedded newlines, DEL). Round-trips cleanly in every case, closing a memory note from the v0.5 Discovery dogfood that claimed the output broke jq — the claim was a misdiagnosis. Test stays as durable regression protection.

### Known limitations

- **Compound-command bypass (pre-existing, not v0.2.2-specific).** Both policy templates evaluate `auto_approve` before `auto_reject` in `matchPolicy`. A command whose prefix matches an approve rule short-circuits regardless of what follows a `&&`, `;`, `|`, or `$(...)`. E.g. `cp src dst && rm -rf /` auto-approves via `cp`. This is an architectural property, not a regex gap. Mitigation paths for v0.2.3: template preamble documenting the caveat, or early-exit auto_defer rules on compound operators, or flipping evaluation order (breaking change). Filed for follow-up.

### Notes

- No API, MCP-tool, socket-protocol, or event-schema changes. Backwards-compatible with v0.2.x drivers and running sessions.
- README updated with a policy-templates section explaining when to pick which template.

## [0.2.1] — 2026-04-22

### Fixed

- **`claw-drive watch` subscribe-race: driver missed pending gates that landed before it subscribed.** When the driver's flow is `start_session → Monitor(watch_command)`, the ~100 ms between the two is enough for the runner to emit `session_started`, `turn_started` (scenario_brief auto-send), and often the first `tool_decision_required`. v0.2's watch default "from current seq" skipped them, and the driver sat silent on a pending it never saw. Surfaced during the CLV-16 Delivery dogfood (2026-04-22). Fix: on subscribe, watch now emits a one-shot "catch-up" of events the new subscriber needs to know about — `tool_decision_required` without a matching `tool_decision_resolved` (unresolved gates) and `session_stopped` if present (so watch exits a dead session immediately). Anti-flood design intent preserved: history like `session_started`, `turn_started`, `assistant_text`, completed turns are still skipped. `--replay` behavior unchanged.

### Added

- **`catchUpPending(events)`** — pure helper in `src/cli/commands/watch.ts`, exported for unit testing. Given the full event history, returns the subset a new subscriber needs: unresolved `tool_decision_required` + `session_stopped`.
- 7 new unit tests covering `catchUpPending` edge cases (empty, unresolved-only, mixed, skipped-resolved, session_stopped propagation, noise rejection, order preservation).

## [0.2.0] — 2026-04-22

### Added

- **Defer-to-human flow.** Policies now support `auto_defer` (alongside `auto_approve`/`auto_reject`). When a rule matches, the approver denies B's hook with a `DEFERRED:` message so the call surfaces to A/human rather than running. The human runs the command locally and pipes the output back via the new `provide_tool_output` MCP tool (or `claw-drive provide-output` CLI). The runner formats the output as a user turn to B, which continues from where it left off. Review gates (B pauses for human sign-off mid-task, no real command executed) ride on the same mechanism via a `CLAW-GATE:` echo-sentinel convention baked into the default policy template.
- **Monitor-driven driving.** `start_session`'s response now includes a `watch_command` payload (`{command, args, description, timeout_ms, persistent}`) that A passes directly to the Claude Code `Monitor` tool. `Monitor(watch_command)` spawns the new `claw-drive watch <session_id>` CLI subcommand, which tails `events.jsonl` and emits only human-actionable events as JSONL (one per line). A reacts to notifications instead of polling. Watch exits cleanly on `session_stopped`.
- **New MCP tool `provide_tool_output`** — see §4.7 of the spec.
- **New CLI commands `watch` and `provide-output`** — see the README.
- **New event kind `tool_output_provided`** — emitted when `provide_tool_output` injects output back to B; records `{call_id, stdout_len, stderr_len, exit_code}` for compact auditability. Full content is in the user-turn message, not the event log.
- **New `resolved_by` value `user_mcp_auto`** — set when `provide_tool_output` auto-resolves a still-pending approval as defer.
- `DecisionAction` extended to include `"defer"` (in events, socket protocol, policy rules).
- **`install.sh` installer.** Idempotent. Default mode symlinks `claw-drive` + `claw-drive-approver` into `~/.local/bin`; `--copy` mode writes an absolute-path shim + a self-contained approver copy; `--project <path>` merges claw-drive into that project's `.mcp.json` (preserving other entries); `--policy <path>` drops the starter `templates/claw-drive-policy.json` template; `--uninstall` removes bins and the `.mcp.json` entry cleanly.
- **`templates/claw-drive-policy.json`** — starter dogfood policy. v0.2 expands it with `auto_defer` (sudo, su, CLAW-GATE convention), shell-prefix `auto_approve` rules (`set -e`, `cd `, `REPO=`, etc.), cloverleaf-cli anywhere-in-compound, and raises `decision_timeout_seconds` to 3600. `_comment` key removed (validator strictness).
- **`CLAW_DRIVE_APPROVER_BIN`** env var — overrides the default package-relative approver resolution in `paths.approverBinPath()`. Set by `install.sh`'s copy-mode shim so the MCP server's `settings.json` points at the installed copy instead of the repo's original.

### Changed

- **`start_session` return shape.** Previously returned `{session_id}`; now returns `{session_id, watch_command}`. Backwards-compatible — callers that ignore `watch_command` work unchanged.
- **Default `decision_timeout_seconds` raised 300 → 3600 (1h).** v0.1's 300 s was a footgun for interactive dogfoods — if the driver's monitor had a transient gap, sensitive calls auto-approved silently. 1 h gives humans enough slack. Applied in both `src/mcp/server.ts` (handleStartSession) and `src/cli/commands/start.ts` (CLI start path).
- **Default policy template** overhauled per the cloverleaf v0.5 Discovery dogfood lessons: `sudo`/`su` moved from `auto_reject` to `auto_defer`, `CLAW-GATE:` convention rules added, shell-prefix auto_approve rules added to cut escalation volume ~80%.
- **Policy matching order:** `auto_approve` > `auto_defer` > `auto_reject` > `escalate_default` (was `auto_approve` > `auto_reject` > `escalate_default`).
- **`claw-drive watch` default behavior:** starts from current seq, not replay-from-0. Pass `--replay` (or `--since 0`) for full replay. Avoids flooding a mid-run Monitor subscription.

### Fixed

- **Runner `session_stopped` race.** In v0.1, `stop_session` deferred teardown via `setImmediate` + `b.once("exit")`, but the main loop's `b.on("exit")` also existed from the v0.1 scaffold and fired first, resolving the main Promise and draining the event loop before the deferred `emitEvent("session_stopped")` could finish. Result: `session_stopped` was never written to `events.jsonl`. Fix: `ctx.stopping` flag set immediately in `stop_session`; main-loop exit handler early-returns when `stopping === true`, ceding teardown to the deferred path. Caught by the watch-emits integration test.
- **`approverBinPath()`** now honors `CLAW_DRIVE_APPROVER_BIN` before falling back to the package-relative default. Required for copy-mode installs.

### Tests

- +2 new unit tests (approverBinPath env-var override in v0.1-post; 5 new policy `auto_defer` / 1 events `tool_output_provided` / 2 socket-protocol `provide_tool_output`+defer / 5 watch-filter in v0.2). Total: 79 unit tests.
- +2 new integration tests (`defer-flow`: auto_defer → provide-output → B continues; `watch-emits`: filter correctness + clean exit on session_stopped). Total: 7 integration tests.

### Scope notes

- `remember_as_policy: true` for `action: "defer"` resolutions is NOT implemented in v0.2. `deriveRuleFromResolved` only handles approve/reject. Adding defer support would require selecting between `auto_defer` list vs. `auto_reject` list based on the resolved action — deferred to v0.3.

---

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
