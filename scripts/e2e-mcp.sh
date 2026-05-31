#!/usr/bin/env bash
# claw-drive e2e: MCP server lifecycle.
#
# Spawns one real claude-driven session via the CLI (which goes through the
# same Unix-socket protocol the MCP server uses). Exercises the full
# user-facing lifecycle: start → send_turn → tail → defer round-trip →
# stop. Verifies events land in events.jsonl with the expected kinds.
#
# Costs real claude tokens. Run before each release.
#
# Complements scripts/self-dogfood.sh, which is the smaller smoke; this
# script's coverage is broader (multi-turn, defer flow, event-log assertions).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/e2e-lib.sh"

BIN="$HERE/../bin/claw-drive"

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: $BIN not executable. Run 'npm run build' first." >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude CLI not on PATH; e2e-mcp.sh requires real claude." >&2
  exit 2
fi

ROOT="$(mktemp -d "$HOME/tmp/claw-drive-e2e-mcp-XXXXXX")"
export CLAW_DRIVE_HOME="$ROOT"
CWD="$ROOT/cwd"
mkdir -p "$CWD"
echo "hello from e2e" > "$CWD/readme.txt"

# Bypass policy for the lifecycle test — the defer round-trip is exercised
# in a second session below with an explicit auto_defer rule.
echo '"bypass"' > "$ROOT/policy-bypass.json"

# Defer-test policy: defers any Bash command starting with `echo CLAW-GATE:`.
cat > "$ROOT/policy-defer.json" <<'EOF'
{
  "auto_approve": [{ "tool": "Read" }, { "tool": "Bash", "bash_command_matches": "^cat " }],
  "auto_defer":  [{ "tool": "Bash", "bash_command_matches": "^echo CLAW-GATE:", "name": "review gate" }],
  "escalate_default": true,
  "decision_timeout_seconds": 60
}
EOF

SESS=""
SESS_DEFER=""
SESS_CTX=""
cleanup() {
  [[ -n "$SESS"       ]] && "$BIN" stop "$SESS"       2>/dev/null || true
  [[ -n "$SESS_DEFER" ]] && "$BIN" stop "$SESS_DEFER" 2>/dev/null || true
  [[ -n "$SESS_CTX"   ]] && "$BIN" stop "$SESS_CTX"   2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

info "claw-drive e2e: MCP lifecycle"
info "  bin:  $BIN"
info "  home: $ROOT"
info "  cwd:  $CWD"

section "lifecycle: start → send → tail → stop"

info "starting session (bypass policy)"
SESS=$("$BIN" start --cwd "$CWD" --policy "$ROOT/policy-bypass.json")
info "session: $SESS"
expect_file_exists  "events.jsonl created"  "$ROOT/sessions/$SESS/events.jsonl"
expect_file_exists  "state.json created"    "$ROOT/sessions/$SESS/state.json"

info "sending turn"
"$BIN" send "$SESS" "Read readme.txt and report its contents verbatim." >/dev/null

info "waiting for turn_completed (up to 60s)"
DEADLINE=$(( $(date +%s) + 60 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  if "$BIN" tail "$SESS" 2>/dev/null | grep -q '"kind":"turn_completed"'; then
    break
  fi
  sleep 1
done

expect_file_contains "B reported file contents"   "$ROOT/sessions/$SESS/events.jsonl" "hello from e2e"
expect_file_contains "session_started event"      "$ROOT/sessions/$SESS/events.jsonl" '"kind":"session_started"'
expect_file_contains "turn_completed event"       "$ROOT/sessions/$SESS/events.jsonl" '"kind":"turn_completed"'

info "stopping session"
"$BIN" stop "$SESS"
SESS=""

section "defer round-trip"

info "starting session (defer policy)"
SESS_DEFER=$("$BIN" start --cwd "$CWD" --policy "$ROOT/policy-defer.json")
info "session: $SESS_DEFER"

info "sending turn that should trigger CLAW-GATE defer"
"$BIN" send "$SESS_DEFER" "Run the bash command: echo CLAW-GATE: should I proceed?" >/dev/null

info "waiting for tool_decision_required (up to 60s)"
DEADLINE=$(( $(date +%s) + 60 ))
CALL_ID=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  CALL_ID=$("$BIN" pending "$SESS_DEFER" 2>/dev/null | grep -oE '"call_id":"[^"]+"' | head -1 | sed 's/"call_id":"//; s/"//' || true)
  [[ -n "$CALL_ID" ]] && break
  sleep 1
done

if [[ -n "$CALL_ID" ]]; then
  pass "defer fired (call_id=$CALL_ID)"
  info "providing tool output"
  "$BIN" provide-output "$CALL_ID" --stdout "yes proceed" --exit 0 >/dev/null

  info "waiting for tool_output_provided (up to 30s)"
  DEADLINE=$(( $(date +%s) + 30 ))
  while [[ $(date +%s) -lt $DEADLINE ]]; do
    if "$BIN" tail "$SESS_DEFER" 2>/dev/null | grep -q '"kind":"tool_output_provided"'; then
      break
    fi
    sleep 1
  done

  expect_file_contains "tool_output_provided event" "$ROOT/sessions/$SESS_DEFER/events.jsonl" '"kind":"tool_output_provided"'
else
  fail "defer never fired (no pending call within 60s)"
fi

info "stopping session"
"$BIN" stop "$SESS_DEFER"
SESS_DEFER=""

section "CD-8 decision context (rationale + diff on the poll/pending path)"

# Escalate Edit + Bash so the runner enriches the tool_decision_required event.
cat > "$ROOT/policy-ctx.json" <<'POLICY'
{
  "auto_approve": [{ "tool": "Read" }],
  "escalate": [{ "tool": "Edit" }, { "tool": "Write" }, { "tool": "Bash" }],
  "escalate_default": true,
  "decision_timeout_seconds": 60
}
POLICY

info "starting session (context policy)"
SESS_CTX=$("$BIN" start --cwd "$CWD" --policy "$ROOT/policy-ctx.json")
info "session: $SESS_CTX"

# --- Edit: expect a capped diff + rationale on the decision event ---
info "sending an Edit turn that should escalate"
"$BIN" send "$SESS_CTX" "Use the Edit tool to change the word 'hello' to 'goodbye' in readme.txt." >/dev/null

info "waiting for an Edit tool_decision_required (up to 75s)"
DEADLINE=$(( $(date +%s) + 75 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  "$BIN" pending "$SESS_CTX" 2>/dev/null | grep -q '"tool":"Edit"' && break
  sleep 2
done

EDIT_LINE=$("$BIN" pending "$SESS_CTX" 2>/dev/null | grep '"tool":"Edit"' | head -1 || true)
if [[ -n "$EDIT_LINE" ]]; then
  echo "$EDIT_LINE" | grep -q '"diff":'      && pass "Edit decision carries a diff"      || fail "Edit decision missing diff"
  echo "$EDIT_LINE" | grep -q '"rationale":' && pass "Edit decision carries a rationale" || fail "Edit decision missing rationale"
  CALL_ID=$(echo "$EDIT_LINE" | grep -oE '"call_id":"[^"]+"' | head -1 | sed 's/"call_id":"//; s/"//')
  [[ -n "$CALL_ID" ]] && "$BIN" reject "$CALL_ID" --reason "e2e" >/dev/null 2>&1 || true
else
  fail "Edit decision never fired (no pending Edit within 75s)"
fi

# --- Bash: expect a rationale but NO diff (non-file tool) ---
info "sending a Bash turn that should escalate"
"$BIN" send "$SESS_CTX" "Run the bash command: echo context-check" >/dev/null

info "waiting for a Bash tool_decision_required (up to 75s)"
DEADLINE=$(( $(date +%s) + 75 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  "$BIN" pending "$SESS_CTX" 2>/dev/null | grep -q '"tool":"Bash"' && break
  sleep 2
done

BASH_LINE=$("$BIN" pending "$SESS_CTX" 2>/dev/null | grep '"tool":"Bash"' | head -1 || true)
if [[ -n "$BASH_LINE" ]]; then
  echo "$BASH_LINE" | grep -q '"diff":' && fail "Bash decision unexpectedly carries a diff" || pass "Bash decision has no diff (non-file tool)"
else
  fail "Bash decision never fired (no pending Bash within 75s)"
fi

info "stopping session"
"$BIN" stop "$SESS_CTX"
SESS_CTX=""

summary
