#!/usr/bin/env bash
# claw-drive self-dogfood acceptance test.
#
# Runs a real claude-driven session end-to-end using the CLI, and asserts that
# B read a file in the cwd and reported its contents. Validates the whole
# stack (runner + Bash approver + claude CLI) with no MCP client in the loop.
#
# Requires: built dist/ (run `npm run build` first), `claude` on PATH,
# runtime deps `jq` + `nc`/`ncat`.
#
# Exit 0 on pass, non-zero on fail.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../bin/claw-drive"

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: $BIN is not executable. Run 'npm run build' first." >&2
  exit 2
fi

ROOT="$(mktemp -d "$HOME/tmp/claw-drive-acceptance-XXXXXX")"
export CLAW_DRIVE_HOME="$ROOT"
CWD="$ROOT/cwd"
mkdir -p "$CWD"
echo "hello from dogfood" > "$CWD/readme.txt"

echo '"bypass"' > "$ROOT/policy.json"

cleanup() {
  # Stop any live session first
  if [[ -n "${SESS:-}" ]]; then
    "$BIN" stop "$SESS" 2>/dev/null || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT

echo "→ starting session in $CWD"
SESS=$("$BIN" start --cwd "$CWD" --policy "$ROOT/policy.json")
echo "→ session: $SESS"

echo "→ sending a turn"
"$BIN" send "$SESS" "Read readme.txt from the current directory and report its contents verbatim." >/dev/null

echo "→ waiting for turn_completed (up to 60s)"
DEADLINE=$(( $(date +%s) + 60 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  if "$BIN" tail "$SESS" | grep -q '"kind":"turn_completed"'; then
    break
  fi
  sleep 1
done

echo "→ asserting B read the file"
if "$BIN" tail "$SESS" | grep -q "hello from dogfood"; then
  echo "PASS: B read the file"
else
  echo "FAIL: B did not report the file contents" >&2
  "$BIN" tail "$SESS" >&2
  exit 1
fi

echo "→ stopping session"
"$BIN" stop "$SESS"
echo "acceptance OK"
