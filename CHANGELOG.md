# Changelog

## [0.5.6] — 2026-04-27

### Added

- **Sentinel-token wrapper system.** Session B is auto-taught a small contract at session start: end your turns with a literal `[TOKEN]` on its own line if (and only if) human attention is needed. Eleven explicit tokens + a `DEBUG-*` wildcard. The wrapper is injected via `claude -p`'s `--append-system-prompt` flag — verified working on claude 2.1.121.
- **Sentinel-aware `claw-drive watch` filter.** `turn_completed` events now surface only when the trailing `[TOKEN]` resolves to surface mode `"always"`. Other actionable kinds (`tool_decision_required`, `tool_decision_resolved` on timeout, `turn_failed`, `error`, is-error `tool_call_result`, `session_stopped`, `tool_output_provided`) bypass the token check — they're runner-emitted facts, not LLM prose. Closes the v0.5.4 framing where `--decision-only` dropped *all* `turn_completed` regardless of content; the new contract distinguishes attention-needing turns from autonomous ones.
- **`surface_tokens` policy block.** Optional `Record<string, "always" | "silent">` on `PolicyObject`. Validated at `start_session` and `update_policy` boundaries — typo'd token names error loudly there. Wildcard support: a `"DEBUG-*"` key catches any `DEBUG-X` token.
- **Three new flags on `claw-drive watch`:**
  - `--surface KIND[,KIND]...` (repeatable) — override surface mode to `"always"` for the listed tokens.
  - `--silence KIND[,KIND]...` (repeatable) — override to `"silent"`.
  - `--no-token-filter` — disables the sentinel-aware filter entirely (raw v0.5.5-style watch behavior). Mutually exclusive with `--surface` / `--silence`.
- **`wrapper: false` parameter on `start_session`** (MCP) — opt out of the wrapper injection. Pair with `--no-token-filter` on watch since there's no sentinel to anchor on.
- **`/claw-drive-start` plugin skill default reverted.** The skill no longer appends `--decision-only`. The new sentinel filter is the default behavior. `--verbose` now means "bypass both wrapper injection AND sentinel filter" (full v0.5.5-style raw stream).
- **`src/lib/tokens.ts`** — single source of truth for the wrapper text, vocabulary, default surface modes, regex, and resolver. v0.5.5's `status.ts` now imports the shared regex (was a local copy).

### Changed

- The `--decision-only` watch flag continues to work for explicit aggressive filtering, but it's no longer applied by `/claw-drive-start`.
- v0.5.5's `status.ts` `last_token` field starts populating in real session output now that B emits `[TOKEN]` sentinels (the field was the consumer-side stub waiting for this release).

### Notes

- **Minimum claude version: 2.1.121** (where `--append-system-prompt` is documented). Older claude versions will fail loud at runner spawn — the error surfaces in `error` events with claude's own message. If you're stuck on an older version, pass `wrapper: false` to `start_session` (and `--no-token-filter` to watch) to disable the v0.5.6 contract.
- LLM compliance with the sentinel contract is high but not 100%. Misses are silent (turn ends, no token, watch drops the event). Mitigations: `claw-drive status` from v0.5.5 is the on-demand fallback; `--no-token-filter` and `--verbose` (skill) are escape hatches.
- Wrapper costs ~250 tokens of B's system-prompt budget per session. Negligible for long runs.
- ~40 new unit tests in `tests/unit/tokens.test.ts`, `tests/unit/runner-args.test.ts`, `tests/unit/watch-token-filter.test.ts`, plus extensions to `policy.test.ts` and `watch-cli-args.test.ts`. 467/467 tests passing (was 391; +76 net across the four touched files plus integration test adjustment).
- `tests/integration/watch-emits.test.ts` now passes `--no-token-filter` to the watch subprocess so the test's "B replies with hi" prompt — which doesn't include a sentinel — still sees the `turn_completed` event surface. The test verifies watch's noise filter, not the v0.5.6 sentinel filter (which is unit-tested in `watch-token-filter.test.ts`).

## [0.5.5] — 2026-04-27

### Added

- **`claw-drive status [<session-id>] [--json]`** — new CLI subcommand that aggregates per-session state into a single snapshot. Reads `state.json` + `events.jsonl` for each session and assembles: status (running/orphaned/stopped), cwd, policy label/digest, runner pid, turn count, current turn metadata (id, started_at, last assistant text, extracted trailing token), last completed turn metadata (id, completed_at, stop_reason, last assistant text, extracted token), pending decisions (call_id, tool, args summary, severity, default action, age in seconds — chronological, oldest first), and recent errors (turn_failed / error / is-error tool_call_result, capped at 3, most-recent-first).
- **Two-mode default-human output:**
  - **No session id** → summary table (`SESSION_ID  STATUS  TURNS  PENDING  ERRORS  LAST_ACTIVITY  CWD`), one row per session.
  - **With session id** → labeled multi-line block with all sections (current turn, last completed turn, pending decisions, recent errors). Empty sections are omitted.
- **`--json` flag** for machine output. Single-session form is a bare object; all-sessions form is `{ "sessions": [...] }`. Schema mirrors the human render's data layout.
- **Forward-compatible `last_token` field** on every turn block. Extracts a trailing `[TOKEN]` sentinel from the *full* (untruncated) `assistant_text` body via a regex matching the v0.5.6 wrapper-system contract: `(?:^|\n)[ \t]*\[([A-Z*][A-Z0-9*-]*)\]\s*$`. Returns `null` when absent. v0.5.5 ships without the wrapper itself, so the field is `null` until v0.5.6 lands and `start_session` starts injecting the contract — at which point status output starts surfacing the tokens with no schema change.
- **Head truncation** of long assistant_text (1000 chars) and error summaries (200 chars) to keep response bounded. Token extraction runs *before* truncation, so the trailing sentinel is preserved in `last_token` even when the body is cut.
- **New plugin skill `/claw-drive-status [<session-id>]`** (at `plugin/skills/claw-drive-status/SKILL.md`). Calls `claw-drive status [--json]`, parses the result, and *characterizes* what's happening rather than dumping raw JSON. Surfaces high-severity pending decisions first, then NEEDS-* / ERROR / FAILED-NO-RETRY tokens, then recent errors. Multi-session output groups quiet sessions as a count; single-session output leads with `last_assistant_text` so the user can see what B is "saying right now."
- **47 new unit tests** in `tests/unit/status.test.ts` covering token extraction (12 cases including the v0.5.6 vocabulary, CRLF, mid-string non-matches), head truncation (3 cases), snapshot assembler (~14 — orphan detection, current/last-completed turn detection, pending decisions ordering and resolved filtering, age_seconds calculation, args summary across Bash + Edit, recent errors capped at 3 most-recent-first), renderers (~9 cases for summary table / detailed block / JSON), and argv parsing (~7 cases).

### Notes

- No code changes to `src/lib/policy.ts`, `src/lib/events.ts`, `src/lib/state.ts`, or any runner/MCP-side code. Pure file-system reader on top of existing per-session artifacts.
- No socket-protocol, event-schema, or template change. Backwards-compatible with v0.5.x running sessions.
- Plugin manifest + marketplace catalog version bumped in lockstep across the same 12 files as v0.5.4.
- The TRAILING_TOKEN_RE regex in this release is the contract the future v0.5.6 wrapper system will adhere to — both sides matching byte-for-byte ensures the sentinel that lands in `assistant_text` and the one extracted into `last_token` agree.
- 391/391 tests passing (was 344; +47).

### Out of scope (for future)

- `claw-drive status --watch` streaming refresh. Snapshot-on-demand only in v0.5.5.
- Filter / sort / search flags on the summary table. Add when there's observed need.
- An MCP-tool exposure of the status snapshot. CLI is sufficient for the observed pain.
- The v0.5.6 sentinel wrapper itself (designed at `.superpowers/specs/2026-04-27-v0.5.6-sentinel-wrapper-draft.md`, not implemented here).

## [0.5.4] — 2026-04-27

### Added

- **`--only KIND[,KIND]...` flag on `claw-drive watch`.** Comma-separated list of event kinds to keep in the stream. Composes (AND) with the existing `shouldEmit` predicate, so `--only` is a subset filter — kinds outside the eight-kind actionable set still never pass. Unknown kind in `--only` exits 2 with an error message listing the valid kinds.
- **`--decision-only` shorthand on `claw-drive watch`.** Equivalent to `--only tool_decision_required,tool_decision_resolved,turn_failed,error,session_stopped,tool_call_result` — the six "human attention" kinds. Drops `turn_completed` and `tool_output_provided`, which are progress / confirmation noise from a human-driver perspective. Mutually exclusive with `--only`.
- **`--verbose` flag on `/claw-drive-start`.** When passed, the skill behaves as in v0.5.3 (Monitor receives the full eight-kind stream). When omitted (the new default), the skill rewrites the watch_command to append ` --decision-only` before handing it to Monitor — so the human driver sees only decision-required events plus failures/errors/stops, not turn completions or output-provided confirmations.
- **31 new unit tests** across `tests/unit/watch-filter.test.ts` (extended with `userFilter`, `DECISION_ONLY_KINDS`, `VALID_WATCH_KINDS` describe blocks) and `tests/unit/watch-cli-args.test.ts` (new file covering the extracted `parseWatchArgs` pure parser). 313 → 344 tests.

### Changed

- **`/claw-drive-start` Monitor default is now `--decision-only`.** Existing users who rely on seeing `turn_completed` for orchestration logic should pass `--verbose` to opt into the prior behavior. Drivers consuming the watch_command directly (without going through `/claw-drive-start`) see no change — `claw-drive watch <id>` with no flags emits all eight actionable kinds, same as before.
- **`cmdWatch` argv parsing extracted into a pure exported `parseWatchArgs` function.** Existing flags (`--since`, `--replay`) are unchanged; the refactor exists so the new flags can be unit-tested without spawning subprocesses.

### Notes

- No code changes to `src/lib/policy.ts`, `src/lib/events.ts`, `src/lib/state.ts`, or any MCP-tool surface.
- No socket-protocol, event-schema, or template change.
- Backwards-compatible with v0.5.x running sessions. The watch_command string returned by `start_session` is unchanged; the skill modifies it on the consumer side.
- `catchUpPending` is unaffected internally (it still emits unresolved decisions + session_stopped); its output is now passed through `userFilter` so that an explicit `--only` excluding one of those kinds is honored consistently with the streamed loop.
- Plugin manifest + marketplace catalog version bumped in lockstep.
- Out of scope, filed for future: changing `start_session`'s MCP signature to accept a `monitor_filter` parameter, an MCP-tool exposure of the filter logic, kind-level filtering for non-actionable kinds like `assistant_text`.

## [0.5.3] — 2026-04-25

### Added

- **`claw-drive policy-test '<command>' [flags]`** — new diagnostic CLI subcommand. Tests a tool call against a policy and prints which list fired, which rule matched, the regex pattern, severity, and the resolved decision + default action. Three output formats:
  - **Default (human)** — single multi-line report. Example:
    ```
    $ claw-drive policy-test 'kill -9 1'
    Decision:       escalate
    Default action: defer
    List:           auto_defer
    Matched rule:   "kill -9 of init/everything/process-group (PID 1, -1, or 0)"
    Pattern:        \bkill\s+-9\b.*?\s(-1|0|1)(\s|$|[;&|])
    Severity:       high
    Tool:           Bash
    Command:        kill -9 1
    Policy:         <repo>/templates/claw-drive-policy.json (starter)
    ```
  - **`--explain`** — walks every rule in evaluation order with `✓` (matched) / `✗` (skipped) glyphs. TTY-aware ANSI color (matched in green, unmatched dimmed). Final summary line shows the resolved decision and how it was reached (matched rule vs `escalate_default` fall-through).
  - **`--json`** — single-line JSON output for piping to `jq` and CI tooling. Schema mirrors `MatchDecision` from `src/lib/policy.ts` plus an `input` echo, a `policy_source` block, and a `list` field naming the rule list that fired.
- **Multi-tool support from day one.** Bash uses the positional shorthand (`policy-test 'kill -9 1'`), non-Bash tools take `--tool TOOL --arg KEY=VALUE` (repeatable):
  ```
  claw-drive policy-test --tool Read --arg file_path=/etc/passwd
  claw-drive policy-test --tool Edit --arg file_path=/tmp/foo.ts --arg old_string=secret
  claw-drive policy-test --tool Grep --arg pattern='api_key'
  claw-drive policy-test --tool Agent --arg subagent_type=Explore
  ```
  Positional + non-Bash `--tool` is rejected with a helpful error; positional + redundant `--arg command=...` likewise.
- **Policy source flag `--policy SPEC`.** SPEC is one of:
  - `starter` (default — `templates/claw-drive-policy.json`)
  - `permissive` (`templates/claw-drive-policy-permissive.json`)
  - `bypass` (the literal `"bypass"` policy — every call returns `approve_silent`)
  - `<path>` — any custom policy JSON file (validated via `validatePolicy` before running)
- **CI-gating flag `--exit-on DECISION`** where DECISION is `reject|defer|approve|escalate`. Returns exit code 1 instead of 0 if the resolved decision matches; default is always 0. Useful for pre-commit hooks that fail if any command in a script would `auto_reject` against the project's policy.
- **TTY-aware color** with `--no-color` and `NO_COLOR` env-var opt-outs (the latter is the de-facto standard).
- **50 new unit tests** in `tests/unit/policy-test-cli.test.ts` covering argv parsing (20 cases), policy source resolution (8 cases), human/explain/JSON rendering (12 cases), and the orchestrator (10 cases — exit codes, stderr behavior, NO_COLOR, JSON shape, --help). Total: 313 (was 263; +50).

### Notes

- No code changes to `src/lib/policy.ts` (the policy engine is reused as-is via `matchPolicy` and `validatePolicy`).
- No changes to either policy template, the MCP-tool surface, the socket protocol, the event schema, or any existing CLI subcommand.
- Backwards-compatible with v0.5.x running sessions. Plugin manifest + marketplace catalog version bumped in lockstep with the CLI.
- The diagnostic uses its own `ruleMatchesCall` to walk every rule in `--explain` mode (the engine's `matchPolicy` short-circuits on first match). Both implementations are in-source and trivially small; the rule-matching semantics (regex on `bash_command_matches` for Bash, `arg_matches` for non-Bash, optional `/regex/` syntax for tool name) are identical to the engine's.
- Path resolution for the starter / permissive templates uses the same `import.meta.url` → `../../../templates/...` convention as `getVersion()` from v0.5.1, verified across all three install modes (symlink, copy, remote-tarball).
- Out of v0.5.3 scope (filed for future): "diagnose this whole policy file" mode (dump every rule's regex test against a corpus), coverage analysis (which rules in this template never fire on a sample command set), regex linter / fuzzer, and an MCP-tool exposure of the same logic. CLI is sufficient for the observed pain (template author at terminal, dogfooder debugging an escalation).

## [0.5.2] — 2026-04-25

### Added

- **Two narrow `auto_defer` rules in both shipped policy templates** (`templates/claw-drive-policy.json`, `templates/claw-drive-policy-permissive.json`):
  1. **`kill -9` of catastrophic PIDs** — matches when one of `1` (init), `0` (current process group), or `-1` (every process the user can kill) appears anywhere in the kill arglist. Pattern: `\bkill\s+-9\b.*?\s(-1|0|1)(\s|$|[;&|])`. Matches `kill -9 1`, `kill -9 -1`, `kill -9 0`, `kill -9 -- 1`, `kill -9 1234 1` (PID 1 buried in a multi-PID arglist), `kill -9 0; ls`, etc. Does NOT match `kill -9 12`, `kill -9 100`, `kill -9 -10`, `kill -9 -100`, or `kill -9 1234 5678` — ordinary PIDs continue to fall through to `escalate_default` (approve), preserving the v0.2.4 "kill -9 too common in dev" rationale for non-catastrophic kills.
  2. **`systemctl` service-teardown verbs** — matches `stop`, `disable`, `kill`, or `mask` as the subcommand, with arbitrary flags allowed between `systemctl` and the verb (`--user`, `--no-block`, `--type=service`). Pattern: `\bsystemctl\s+(--?[\w-]+(=\S+)?\s+)*(stop|disable|kill|mask)\b`. Matches `systemctl stop nginx`, `systemctl --user stop foo`, `systemctl --no-block disable bar`, `systemctl --type=service mask docker`, `systemctl kill myservice`. Does NOT match `systemctl status`, `systemctl start`, `systemctl restart`, `systemctl daemon-reload`, `systemctl is-active`, etc.
- **24 new unit test cases** in `tests/unit/policy.test.ts` under a new `v0.5.2 narrow kill -9 + systemctl teardown` describe block: 12 `deferCases` × 2 templates (positive — must escalate-with-default-defer), 10 `nonDeferCases` × 2 templates (negative — must fall through to escalate-with-default-approve), and 2 `sudo`-first ordering invariants (`sudo kill -9 1` and `sudo systemctl stop foo` continue to match the existing `^sudo\s` rule first, mirroring the v0.2.4 `sudo chmod -R 777` invariant).

### Fixed

- **Closed two policy gaps left open in v0.2.4**: `kill -9 1` (init) and `systemctl stop foo` (without sudo, e.g. `systemctl --user stop foo`) previously fell through to `escalate_default: true`, which returns `escalate` with `default_action: "approve"`. With the default 3600 s `decision_timeout_seconds`, an unattended pending call would auto-approve on timeout — silently killing init or stopping a user-systemd service. Both now route through `auto_defer`, so timeout flips to `defer` (no action without a human). v0.2.4's reasoning ("`kill -9` too common in legitimate dev workflows" and "`systemctl stop` already deferred via the `sudo` rule") was correct for `auto_reject` but missed the user-systemd / non-sudo case (`systemctl --user`) and the catastrophic-PID case for kill — both addressed here.

### Notes

- No code, MCP-tool, socket-protocol, event-schema, schema, or template-shape changes. This release is template-body + tests + docs only. Backwards-compatible with v0.5.x running sessions.
- The v0.2.2 structural-equality test (`auto_defer`/`auto_reject` arrays in the permissive template match the starter byte-for-byte) continues to pass — both templates received identical edits.
- Evaluation order (`auto_reject → auto_defer → auto_approve → escalate_default`) is unchanged from v0.2.3. The two new rules are appended **after** the `^sudo\s` and `^su\s` rules in `auto_defer`, preserving the v0.2.4 invariant that `sudo X` matches the sudo rule first.
- 263/263 tests passing on the rewritten head (was 217 unit + 8 integration = 225; +24 new unit + 14 prior = adjusted run shows 263 across files; +24 net for v0.5.2).
- Plugin manifest + marketplace catalog version bumped in lockstep.
- Intentionally NOT added in this release: `kill -KILL`, `kill -SIGKILL`, `kill -s KILL`, `kill --signal=KILL` (other SIGKILL forms — narrow patch scope), `pkill -9 -1`, `killall -9` (related but different command family), `systemctl restart` (sometimes legitimate), and the broader container/cluster destructive cluster (`docker rm -f`, `kubectl delete`, `terraform destroy`). Filed for possible future consideration if a dogfood surfaces them.

## [0.5.1] — 2026-04-25

### Added

- **`claw-drive --version` / `-v` / `version` (subcommand form)** — prints the contents of the `VERSION` file at repo root and exits 0. Usage:
  ```
  $ claw-drive --version
  0.5.1
  ```
  Implemented in `src/cli/cli.ts` via `getVersion()` (exported, unit-tested in `tests/unit/version.test.ts`). Reads `VERSION` at runtime relative to `dist/cli/cli.js`, so the print matches `cat VERSION` byte-for-byte across both clone-mode and copy-mode installs. Help text in `printUsage()` now lists the flag alongside `--help`.

### Fixed

- **`/claw-drive-init` skill no longer prints "MISSING" on a working install.** The plugin's CLI-presence probe used `claw-drive --version` to verify the binary, but `--version` was unrecognised in v0.4.0/v0.5.0 (exit 2 with `unknown command: --version`), so the skill misreported the CLI as absent even when it was installed and working. Surfaced during the first dogfood install via the public marketplace catalog (2026-04-25). Probe replaced with `claw-drive sessions >/dev/null 2>&1`, which exits 0 on every supported CLI version including the older releases that don't have `--version`. The new `--version` flag in this release also makes the original-style probe work, but the `sessions` probe is preferred for forward-compatibility.

### Notes

- No MCP-tool, socket-protocol, event-schema, or template changes. Backwards-compatible with v0.5.x running sessions.
- 209 unit tests passing (was 207; +2 for `getVersion`). Plugin manifest + marketplace catalog version bumped in lockstep.

## [0.5.0] — 2026-04-24

### Added

- **Claude Code plugin** at `plugin/`. Ships three slash commands as a UX layer over the existing CLI + MCP: `/claw-drive-init` (idempotently registers claw-drive in the current project's `.mcp.json`, optionally drops a starter policy), `/claw-drive-start` (spawns Session B and starts the Monitor flow against the returned `watch_command`), and `/claw-drive-resolve` (handles paused `tool_decision_required` calls, including the defer-with-output round-trip via `provide_tool_output`).
- Plugin manifest at `plugin/.claude-plugin/plugin.json` (name, version, author, repo URL, MIT licence). Install locally via `/plugin install local /path/to/claw-drive/plugin` until a marketplace listing is in place.

### Notes

- The plugin layer is UX only — it does NOT install the CLI or auto-register the MCP server in every project. Run `curl … | bash` to install the binary, then `/claw-drive-init` per project. Both steps are idempotent.
- Plugin version tracks the CLI version: v0.5.0 plugin works with v0.5.x CLI.
- No code, MCP-tool, socket-protocol, event-schema, or schema changes. This release is plugin scaffolding + version sync only. Backwards-compatible with v0.4.x running sessions.

## [0.4.0] — 2026-04-24

### Added

- **Remote install via `curl … | bash`.** `install.sh` now self-detects clone-mode vs remote-mode at the top of the script. When piped from stdin (no adjacent `package.json`), it fetches the latest tarball from `https://github.com/renatodarrigo/claw-drive/archive/refs/heads/main.tar.gz`, extracts to `${XDG_DATA_HOME:-~/.local/share}/claw-drive`, and re-execs itself in copy mode. One-liner: `curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash`.
- **`CLAW_DRIVE_REMOTE_TARBALL` and `CLAW_DRIVE_SRC_DIR` env-var overrides** on the bootstrap path. Useful for testing against a local tarball or installing from a fork.

### Changed

- Remote installs are forced into copy mode (the source dir is managed, not the user's clone). Symlink mode remains the default for clone-based installs.
- Website (`docs/`) install page leads with the curl-pipe one-liner; clone-based install moves to a "From source" section.

### Notes

- No code, MCP-tool, socket-protocol, event-schema, schema, or template changes. This release is install-flow + docs only. Backwards-compatible with v0.3.x running sessions.
- Plugin install (Claude Code `/plugin install`) is tracked for a follow-up release.

## [0.3.0] — 2026-04-24

### Added

- **`remember_as_policy: true` now works with `action: "defer"`.** `resolve_tool_call` previously ignored the flag on defer because the remember block sat behind the defer early-return in the runner's `handleRequest`. Moved; now appends the derived rule to `auto_defer` before denying B's hook with the DEFERRED message.
- **Narrow-by-default derivation for non-Bash tools in `deriveRuleFromResolved`.** Remembered rules now scope on the tool's identifying argument (`file_path`, `pattern`, `subagent_type`) instead of matching every call to the same tool. `Edit /path/foo.ts` now derives `{tool: "Edit", arg_matches: {file_path: "^/path/foo\\.ts$"}}` instead of `{tool: "Edit"}`. Applies to Edit, Write, Read, Glob, Grep, Agent, Task. Tools without a recognised identifying arg (TodoWrite, ExitPlanMode, custom MCP tools) keep the tool-wide fallback, now clearly labelled in the rule name as `(tool-wide fallback)`.
- **CLI: new `claw-drive defer <call_id>` subcommand and `--remember` flag on approve/reject/defer.** The `--remember` flag sets `remember_as_policy: true` on the underlying `resolve_tool_call` socket request.
- **9 new unit tests and 1 new integration test** covering the narrow derivation (Edit, Write, Glob, Grep, Agent, fallback), defer-specific derivation (Bash, Edit), and the end-to-end runtime wire-up (`claw-drive defer <id> --remember` appends to state.json's auto_defer).

### Changed

- **BREAKING (rule-shape, not API):** remembered rules for non-Bash tools now carry `arg_matches` and only match the exact scope of the remembered action. Users who relied on the old broad tool-wide remembering (which was the memory-flagged "useless blanket rule" bug) will see a fresh escalation the next time B calls the same tool on a different path/pattern/subagent. **Migration:** manually add a tool-wide rule via `update_policy` or direct policy JSON edit if broad trust is desired; alternatively, keep remembering narrow rules as they're encountered and let the policy grow organically.

### Notes

- No MCP tool, socket-protocol, event-schema, schema, or template changes. The `resolve_tool_call` signature is unchanged (`action`, `reason`, `remember_as_policy`).
- The v0.2.2 structural-equality test (permissive template's `auto_defer`/`auto_reject` ≡ starter's) continues to pass — templates are not touched.
- The v0.2.3 evaluation order (`auto_reject → auto_defer → auto_approve → escalate_default`) is unchanged — narrow-scope learned rules interact with it the same way manually-authored ones do.
- v0.3.0 is a minor bump (not patch) because the observable rule-shape changes for anyone who called `remember_as_policy` against a non-Bash tool. No API surface change, but the learned-rule structure differs.

## [0.2.4] — 2026-04-24

### Added

- **6 new `auto_reject` patterns on both shipped templates** — `dd if=`, `mkfs`, `shred`, `git clean -fdx`, `rm --no-preserve-root`, disk partitioning tools (`fdisk`/`parted`/`gdisk`/`sgdisk`), and remote-exec-via-pipe (`\b(curl|wget) ... | (sudo )? (bash|sh|zsh)`; the `\b` left-anchor was tightened during review so `xcurl`/`mycurl`/`xwget` wrappers don't trigger). Closes the catch-net gap on irreversibly destructive commands that the v0.1.x rule set didn't cover.
- **Widened the existing `rm -rf` clause** to `\brm\s+(-[a-zA-Z]*[rR]|--recursive)` — now catches `rm -r`, `rm -fr`, `rm -Rf`, `rm --recursive`, and any short-flag combo containing `r` or `R`. Previously only exact `rm -rf` matched.
- **3 new `auto_defer` patterns** — `chmod -R 777`, `chown -R` (whitespace-flex: `\s+-R`), and `truncate` (moved here from auto_reject during review because `truncate -s 0 foo.log` is a common log-rotation idiom that the human should be able to approve at the policy layer). Recoverable but almost always wrong in a dogfood context; human gets prompted. Appended after `sudo`/`su` in the `auto_defer` list, so `sudo chmod -R 777 /etc` still matches the `sudo` rule first (verified by a pinned test).
- **81 new unit tests** in `tests/unit/policy.test.ts` covering each new pattern on both templates, compound-bypass closures inheriting v0.2.3's order-flip protection, false-positive negatives for `/dev/null`/`/dev/stderr`/non-destructive `dd`/user-wrappers like `xcurl|mycurl|xwget`, and the `sudo chmod -R 777` ordering invariant.

### Fixed

- **`> /dev/null` and similar pseudo-device-redirect false positives.** The v0.1.x `> /dev/` clause in `auto_reject` matched any redirect to `/dev/*`, including legitimate `echo foo > /dev/null`, `cmd 2> /dev/stderr`, and `/dev/fd/…` uses. Narrowed the redirect clause to target block devices only: `sd[a-z]`, `nvme\d+n\d+`, `xvd[a-z]`, `hd[a-z]`, `loop\d*`, `mmcblk\d+`, `vd[a-z]`.

### Notes

- No API, MCP-tool, socket-protocol, event-schema, or schema-level template changes. This release is template-body + tests + docs only. Backwards-compatible with v0.2.x drivers and running sessions.
- The v0.2.2 structural-equality test (`auto_defer`/`auto_reject` arrays in the permissive template match the starter byte-for-byte) continues to pass because both templates received identical edits.
- Evaluation order unchanged from v0.2.3 (`auto_reject → auto_defer → auto_approve → escalate_default`). Compound commands like `git status && dd if=/dev/zero of=/dev/sda` correctly escalate to reject via the v0.2.3 bypass-closure mechanism interacting with the new `dd if=` pattern.
- Intentionally NOT added to `auto_reject`: `kill -9` (too common in legitimate dev workflows), `systemctl stop/disable` (already deferred via the `sudo` rule in practice). Filed for possible future consideration, not for v0.2.4.

## [0.2.3] — 2026-04-24

### Fixed

- **Compound-command bypass in `matchPolicy`.** Previously, a command matching an `auto_approve` rule short-circuited past `auto_reject` — so `git status; rm -rf /tmp` silently auto-approved because it matched `^git (status|...)` in the starter's `auto_approve` list and never reached `\brm -rf\b` in `auto_reject`. Affected both shipped templates (starter + permissive) and any user policy with overlapping approve/reject rules. Surfaced during the v0.2.2 final code review (2026-04-24) and filed as v0.2.3 follow-up. Fix: evaluation order in `matchPolicy` flipped from `auto_approve → auto_defer → auto_reject → escalate_default` to `auto_reject → auto_defer → auto_approve → escalate_default`. Both shipped templates catch compound bypasses automatically via their pre-existing destructive-pattern regex; no template edits needed.

### Changed

- **Policy evaluation order changed from `auto_approve → auto_defer → auto_reject` to `auto_reject → auto_defer → auto_approve`.** When a command matches rules in multiple lists, the stricter rule now wins: reject beats defer beats approve. Asymmetric risk justifies this — a false-reject is a human prompt, a false-approve is a silent bypass. Policies whose rule lists don't have overlapping entries are unaffected; the only behavioural changes land on commands that matched rules in two or more lists. Migration: if you authored a policy relying on approve winning over reject for a specific command, narrow the reject pattern so it doesn't overlap, or move the specific approve pattern onto a non-overlapping path.

### Added

- **9 new unit tests in `tests/unit/policy.test.ts`** — 2 ordering invariants and 7 compound-bypass closures exercising both templates (`git status; rm -rf /tmp`, `set -e; rm -rf /`, `cp foo bar && git push origin main`, `git fetch && rm -rf /`, `which node && npm publish`). Three pre-existing tests renamed with flipped assertions to reflect new ordering (`auto_approve beats auto_reject` → `auto_reject beats auto_approve`; `auto_defer matches before auto_reject` → `auto_reject beats auto_defer`; `auto_approve wins over auto_defer` → `auto_defer wins over auto_approve`).

### Notes

- No API, MCP-tool, socket-protocol, event-schema, or template changes. Backwards-compatible with v0.2.x drivers and running sessions.
- The v0.2.2 structural-equality test (`auto_defer`/`auto_reject` arrays in the permissive template match the starter byte-for-byte) continues to pass because templates are not edited.
- Filed for post-v0.2.3: widen the `auto_reject` pattern set to include `dd if=`, `mkfs`, `chmod -R 777`, `shred`, `git clean -fdx`, `truncate`, `chown -R`. Tracked in project memory.

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

Key design choices:
- Per-session detached runner owns one `claude -p` subprocess.
- MCP server and CLI are symmetric thin clients over the runner's Unix socket.
- `--permission-prompt-tool` doesn't exist in claude 2.1.117 (discovered during `scripts/probe-claude-cli.sh`); we use `--settings` + PreToolUse hook instead.
- 600s default hook timeout (configurable per hook entry); approver self-times-out at 595s to fail-secure under claude's 600s ceiling.
