#!/usr/bin/env bash
# Shared helpers for claw-drive e2e tests.
# Source this from each scripts/e2e-*.sh.

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; DIM=""; RESET=""
fi

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG=()

pass()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()    { printf '  %s✗%s %s\n' "$RED"   "$RESET" "$*"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL_LOG+=("$*"); }
info()    { printf '%s→%s %s\n'   "$BLUE"  "$RESET" "$*"; }
section() { printf '\n%s━━ %s ━━%s\n' "$BLUE" "$*" "$RESET"; }

# expect_exit <description> <expected_code> <command...>
expect_exit() {
  local desc="$1"; local expected="$2"; shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  if [[ "$actual" -eq "$expected" ]]; then
    pass "$desc (exit $actual)"
  else
    fail "$desc (expected exit $expected, got $actual)"
  fi
}

# expect_stdout_contains <description> <substring> <command...>
expect_stdout_contains() {
  local desc="$1"; local needle="$2"; shift 2
  local out
  out=$("$@" 2>&1) || true
  if [[ "$out" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc (stdout did not contain '$needle')"
  fi
}

# expect_file_exists <description> <path>
expect_file_exists() {
  local desc="$1"; local path="$2"
  if [[ -f "$path" ]]; then
    pass "$desc"
  else
    fail "$desc (file missing: $path)"
  fi
}

# expect_file_contains <description> <path> <substring>
expect_file_contains() {
  local desc="$1"; local path="$2"; local needle="$3"
  if [[ ! -f "$path" ]]; then
    fail "$desc (file missing: $path)"
    return
  fi
  if grep -q -- "$needle" "$path"; then
    pass "$desc"
  else
    fail "$desc (file '$path' did not contain '$needle')"
  fi
}

# Print summary; exit non-zero if any failure.
summary() {
  printf '\n'
  if [[ "$FAIL_COUNT" -eq 0 ]]; then
    printf '%s✓ %d / %d checks passed.%s\n' "$GREEN" "$PASS_COUNT" "$PASS_COUNT" "$RESET"
    exit 0
  else
    printf '%s✗ %d / %d checks failed:%s\n' "$RED" "$FAIL_COUNT" "$((PASS_COUNT + FAIL_COUNT))" "$RESET"
    for failure in "${FAIL_LOG[@]}"; do
      printf '  - %s\n' "$failure"
    done
    exit 1
  fi
}
