#!/usr/bin/env bash
# claw-drive e2e: CLI surface tests.
#
# No real claude invocation. Tests argument parsing, help output, empty-state
# listings, and error handling for non-existent sessions.
#
# Fast — runs in seconds. Run before every release to catch CLI surface
# regressions documented on the website's reference page.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/e2e-lib.sh"

BIN="$HERE/../bin/claw-drive"

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: $BIN not executable. Run 'npm run build' first." >&2
  exit 2
fi

# Isolate state from real ~/.claw-drive.
TMPHOME="$(mktemp -d)"
export CLAW_DRIVE_HOME="$TMPHOME"
trap 'rm -rf "$TMPHOME"' EXIT

info "claw-drive e2e: CLI surface"
info "  bin:  $BIN"
info "  home: $TMPHOME"

section "help"
expect_stdout_contains "--help mentions sessions" "sessions"  "$BIN" --help
expect_stdout_contains "--help mentions show"     "show"      "$BIN" --help
expect_stdout_contains "--help mentions tail"     "tail"      "$BIN" --help
expect_stdout_contains "--help mentions pending"  "pending"   "$BIN" --help
expect_stdout_contains "--help mentions approve"  "approve"   "$BIN" --help
expect_stdout_contains "--help mentions reject"   "reject"    "$BIN" --help
expect_stdout_contains "--help mentions defer"    "defer"     "$BIN" --help
expect_stdout_contains "--help mentions send"     "send"      "$BIN" --help
expect_stdout_contains "--help mentions start"    "start"     "$BIN" --help
expect_stdout_contains "--help mentions stop"     "stop"      "$BIN" --help
expect_stdout_contains "--help mentions interrupt" "interrupt" "$BIN" --help
expect_stdout_contains "--help mentions policy"   "policy"    "$BIN" --help
expect_stdout_contains "--help mentions prune"    "prune"     "$BIN" --help
expect_stdout_contains "--help mentions watch"    "watch"     "$BIN" --help
expect_stdout_contains "--help mentions provide-output" "provide-output" "$BIN" --help

section "help (capability map)"
expect_exit            "help verb exits 0"                  0 "$BIN" help
expect_exit            "no-arg exits 0"                     0 "$BIN"
expect_stdout_contains "help lists MCP tool start_session"  "start_session" "$BIN" help
expect_stdout_contains "help has MCP TOOLS section"         "MCP TOOLS"     "$BIN" help
expect_stdout_contains "help has MENTAL MODEL section"      "MENTAL MODEL"  "$BIN" help
expect_exit            "unknown command exits 2"            2 "$BIN" not-a-real-command
expect_stdout_contains "unknown command points to help"     "claw-drive help" "$BIN" not-a-real-command

section "empty-state listings"
expect_exit "sessions on empty home"  0 "$BIN" sessions
expect_exit "pending on empty home"   0 "$BIN" pending
expect_exit "prune on empty home"     0 "$BIN" prune

section "error handling (exit codes are observed, not assumed)"
# Observed via running each command against an empty CLAW_DRIVE_HOME:
# - missing session → exit 2 (show / tail / stop / policy)
# - missing call    → exit 1 (approve / reject)
expect_exit "show <bogus> fails (exit 2)"      2 "$BIN" show nonexistent-session-id
expect_exit "tail <bogus> fails (exit 2)"      2 "$BIN" tail nonexistent-session-id
expect_exit "stop <bogus> fails (exit 2)"      2 "$BIN" stop nonexistent-session-id
expect_exit "policy <bogus> fails (exit 2)"    2 "$BIN" policy nonexistent-session-id
expect_exit "approve <bogus> fails (exit 1)"   1 "$BIN" approve nonexistent-call-id
expect_exit "reject <bogus> fails (exit 1)"    1 "$BIN" reject nonexistent-call-id

summary
