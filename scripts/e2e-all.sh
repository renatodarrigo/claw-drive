#!/usr/bin/env bash
# Run all three e2e suites in order: cli → mcp → plugin.
# First failure stops the run; later suites are skipped.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; BLUE=""; RESET=""
fi

run() {
  local script="$1"
  printf '\n%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$BLUE" "$RESET"
  printf '%s== %s ==%s\n' "$BLUE" "$script" "$RESET"
  if bash "$HERE/$script"; then
    printf '%s== %s passed ==%s\n' "$GREEN" "$script" "$RESET"
  else
    printf '%s== %s FAILED ==%s\n' "$RED" "$script" "$RESET"
    exit 1
  fi
}

run e2e-cli.sh
run e2e-mcp.sh
run e2e-plugin.sh

printf '\n%s✓ all suites passed%s\n' "$GREEN" "$RESET"
