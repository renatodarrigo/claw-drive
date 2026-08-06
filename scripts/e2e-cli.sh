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
expect_stdout_contains "--help mentions report"   "report"    "$BIN" --help
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
expect_stdout_contains "--help mentions rotate"   "rotate"    "$BIN" --help
expect_stdout_contains "--help mentions recover"  "recover"   "$BIN" --help

section "help (capability map)"
expect_exit            "help verb exits 0"                  0 "$BIN" help
expect_exit            "no-arg exits 0"                     0 "$BIN"
expect_stdout_contains "help lists MCP tool start_session"  "start_session" "$BIN" help
expect_stdout_contains "help lists MCP tool rotate_session"   "rotate_session"   "$BIN" help
expect_stdout_contains "help lists MCP tool recover_session"  "recover_session"  "$BIN" help
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
expect_exit "report <bogus> fails (exit 2)"    2 "$BIN" report nonexistent-session-id
expect_exit "tail <bogus> fails (exit 2)"      2 "$BIN" tail nonexistent-session-id
expect_exit "stop <bogus> fails (exit 2)"      2 "$BIN" stop nonexistent-session-id
expect_exit "policy <bogus> fails (exit 2)"    2 "$BIN" policy nonexistent-session-id
expect_exit "approve <bogus> fails (exit 1)"   1 "$BIN" approve nonexistent-call-id
expect_exit "reject <bogus> fails (exit 1)"    1 "$BIN" reject nonexistent-call-id
expect_exit "rotate <bogus> fails (exit 2)"    2 "$BIN" rotate nonexistent-session-id
expect_exit "recover <bogus> fails (exit 2)"   2 "$BIN" recover nonexistent-session-id

section "crash-during-rotate teardown (stub session process)"
# A stub `claude` that reads ONE stdin line then exits 0 — it stands in for a
# session process that dies right as the rotation's handover turn arrives.
# Asserts the full crash choreography at the process level: the rotate client
# settles promptly, rotation_failed precedes session_stopped, and the runner
# process itself exits (no undead runner holding the control socket).
STUB_DIR="$(mktemp -d)"
# start enforces cwd-inside-$HOME, so the stub session's cwd cannot be in /tmp.
mkdir -p "$HOME/.cache"
CRASH_CWD="$(mktemp -d "$HOME/.cache/claw-e2e-cwd.XXXXXX")"
cat > "$STUB_DIR/claude" <<'EOF'
#!/bin/sh
read -r _line
exit 0
EOF
chmod +x "$STUB_DIR/claude"
ROTPOLICY="$TMPHOME/rotation-policy.json"
printf '{"rotation":{"threshold_tokens":120000}}\n' > "$ROTPOLICY"

SID_CRASH="$(PATH="$STUB_DIR:$PATH" "$BIN" start --cwd "$CRASH_CWD" --policy "$ROTPOLICY")"
if [[ "$SID_CRASH" == sess_* ]]; then
  pass "stub session starts (id: $SID_CRASH)"
else
  fail "stub session starts (got: $SID_CRASH)"
fi

ROT_OUT="$TMPHOME/rotate-out.txt"
( "$BIN" rotate "$SID_CRASH" >"$ROT_OUT" 2>&1; echo "EXIT=$?" >>"$ROT_OUT" ) &
ROT_PID=$!
for _ in $(seq 1 50); do
  kill -0 "$ROT_PID" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$ROT_PID" 2>/dev/null; then
  fail "rotate client settles promptly after B crash (still blocked after 10s)"
  kill -9 "$ROT_PID" 2>/dev/null || true
else
  pass "rotate client settles promptly after B crash"
fi
expect_file_contains "rotate reports ROTATION_FAILED"  "$ROT_OUT" "ROTATION_FAILED"
expect_file_contains "rotate names the process exit"   "$ROT_OUT" "exited"

EVJ="$TMPHOME/sessions/$SID_CRASH/events.jsonl"
FIRST_TERMINAL="$(grep -oE '"kind":"(rotation_failed|session_stopped)"' "$EVJ" 2>/dev/null | head -1 || true)"
if [[ "$FIRST_TERMINAL" == *rotation_failed* ]]; then
  pass "rotation_failed precedes session_stopped in events.jsonl"
else
  fail "rotation_failed precedes session_stopped in events.jsonl (first terminal kind: ${FIRST_TERMINAL:-none})"
fi
expect_file_contains "state records crashed:0" "$TMPHOME/sessions/$SID_CRASH/state.json" "crashed:0"

RPID="$(cat "$TMPHOME/sessions/$SID_CRASH/runner.pid" 2>/dev/null || true)"
if [[ -n "$RPID" ]]; then
  for _ in $(seq 1 25); do
    kill -0 "$RPID" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$RPID" 2>/dev/null; then
    fail "runner process exits after the crash (undead runner, pid $RPID)"
    kill -9 "$RPID" 2>/dev/null || true
  else
    pass "runner process exits after the crash (no undead runner)"
  fi
else
  fail "runner process exits after the crash (no runner.pid recorded)"
fi
rm -rf "$STUB_DIR" "$CRASH_CWD"

section "runner SIGTERM teardown (stub session process)"
# A stub that idles on stdin (exits on EOF) — a live session. One SIGTERM to
# the runner must end B's stdin, write the terminal record with reason
# runner_sigterm, and exit the runner within seconds. Pre-hardening, orphaned
# runners absorbed every SIGTERM and needed SIGKILL.
STUB2_DIR="$(mktemp -d)"
SIG_CWD="$(mktemp -d "$HOME/.cache/claw-e2e-cwd.XXXXXX")"
cat > "$STUB2_DIR/claude" <<'EOF'
#!/bin/sh
while read -r _l; do :; done
exit 0
EOF
chmod +x "$STUB2_DIR/claude"

SID_SIG="$(PATH="$STUB2_DIR:$PATH" "$BIN" start --cwd "$SIG_CWD" --policy "$ROTPOLICY")"
if [[ "$SID_SIG" == sess_* ]]; then
  pass "stub session starts (id: $SID_SIG)"
else
  fail "stub session starts (got: $SID_SIG)"
fi
RPID2="$(cat "$TMPHOME/sessions/$SID_SIG/runner.pid" 2>/dev/null || true)"
STUB2_PID="$(pgrep -f "$STUB2_DIR/claude" | head -1 || true)"
kill -TERM "$RPID2" 2>/dev/null || true
for _ in $(seq 1 25); do
  kill -0 "$RPID2" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$RPID2" 2>/dev/null; then
  fail "runner exits on one SIGTERM (wedged, pid $RPID2)"
  kill -9 "$RPID2" 2>/dev/null || true
else
  pass "runner exits on one SIGTERM"
fi
expect_file_contains "state records runner_sigterm"           "$TMPHOME/sessions/$SID_SIG/state.json"    "runner_sigterm"
expect_file_contains "session_stopped carries runner_sigterm" "$TMPHOME/sessions/$SID_SIG/events.jsonl"  "runner_sigterm"
if [[ -n "$STUB2_PID" ]] && kill -0 "$STUB2_PID" 2>/dev/null; then
  fail "B process reaped with the runner (stub still alive, pid $STUB2_PID)"
  kill -9 "$STUB2_PID" 2>/dev/null || true
else
  pass "B process reaped with the runner"
fi
rm -rf "$STUB2_DIR" "$SIG_CWD"

section "interrupt grace gates rotate (stub session process)"
# Dogfood 2026-08-04: SIGINT + a rotate seconds later killed B. The gate must
# refuse INTERRUPT_GRACE inside the settle window. The stub traps INT so the
# interrupt itself leaves it alive (a real claude survives the SIGINT too —
# the hazard is the NEXT turn).
STUB3_DIR="$(mktemp -d)"
INT_CWD="$(mktemp -d "$HOME/.cache/claw-e2e-cwd.XXXXXX")"
cat > "$STUB3_DIR/claude" <<'EOF'
#!/bin/sh
trap '' INT
while read -r _l; do :; done
exit 0
EOF
chmod +x "$STUB3_DIR/claude"

SID_INT="$(PATH="$STUB3_DIR:$PATH" "$BIN" start --cwd "$INT_CWD" --policy "$ROTPOLICY")"
if [[ "$SID_INT" == sess_* ]]; then
  pass "stub session starts (id: $SID_INT)"
else
  fail "stub session starts (got: $SID_INT)"
fi
expect_exit "interrupt succeeds" 0 "$BIN" interrupt "$SID_INT" turn_1
INT_OUT="$TMPHOME/interrupt-rotate-out.txt"
"$BIN" rotate "$SID_INT" >"$INT_OUT" 2>&1 || true
expect_file_contains "rotate refuses INTERRUPT_GRACE right after an interrupt" "$INT_OUT" "INTERRUPT_GRACE"
expect_exit "stop cleans up" 0 "$BIN" stop "$SID_INT"
rm -rf "$STUB3_DIR" "$INT_CWD"

summary
