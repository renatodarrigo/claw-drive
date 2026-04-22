#!/usr/bin/env bash
# claw-drive installer.
#
# Default behavior (no flags):
#   - Verify runtime deps (node >= 20, claude, jq, nc/ncat)
#   - Build if needed (npm install + npm run build)
#   - Symlink bin/claw-drive + bin/claw-drive-approver into ~/.local/bin/
#   - Sanity-run `claw-drive sessions`
#
# Usage:
#   ./install.sh                              Symlink install to ~/.local/bin
#   ./install.sh --copy                       Copy binaries instead of symlink
#   ./install.sh --bin-dir /custom/path       Override install location
#   ./install.sh --project <path>             Also register in <path>/.mcp.json
#   ./install.sh --policy <path>              Also drop templates/claw-drive-policy.json there
#   ./install.sh --uninstall                  Remove symlinks/copies (with --project, also unregisters)
#   ./install.sh --help                       Show this help
#
# Modes:
#   SYMLINK (default): changes in the repo apply to the installed bins immediately.
#   COPY (--copy):     installed bins are a snapshot; re-run install after repo updates.

set -euo pipefail

# ---- colors ----
if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; DIM=""; RESET=""
fi

ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
info() { printf '%s→%s %s\n' "$BLUE"  "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '%s✗%s %s\n' "$RED"   "$RESET" "$*" >&2; }

# ---- locate repo ----
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

# ---- defaults ----
BIN_DIR="$HOME/.local/bin"
MODE="symlink"     # or "copy"
PROJECT=""
POLICY_DEST=""
UNINSTALL=0

# ---- args ----
print_usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy)      MODE="copy"; shift ;;
    --bin-dir)   BIN_DIR="${2:?--bin-dir requires a path}"; shift 2 ;;
    --project)   PROJECT="${2:?--project requires a path}"; shift 2 ;;
    --policy)    POLICY_DEST="${2:?--policy requires a path}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   print_usage; exit 0 ;;
    *)           err "unknown arg: $1"; print_usage; exit 2 ;;
  esac
done

CLAW_DRIVE="$BIN_DIR/claw-drive"
CLAW_APPROVER="$BIN_DIR/claw-drive-approver"

# ---- uninstall path ----
do_uninstall() {
  info "uninstalling from $BIN_DIR"
  for f in "$CLAW_DRIVE" "$CLAW_APPROVER"; do
    if [[ -e "$f" || -L "$f" ]]; then
      rm -f "$f"
      ok "removed $f"
    else
      warn "not present: $f (skipped)"
    fi
  done

  if [[ -n "$PROJECT" ]]; then
    local mcp_json="$PROJECT/.mcp.json"
    if [[ -f "$mcp_json" ]]; then
      local tmpf
      tmpf="$(mktemp)"
      if jq 'if .mcpServers then .mcpServers |= del(.["claw-drive"]) else . end' "$mcp_json" > "$tmpf"; then
        mv "$tmpf" "$mcp_json"
        ok "unregistered claw-drive from $mcp_json"
      else
        rm -f "$tmpf"
        warn "failed to unregister from $mcp_json (manual edit required)"
      fi
    fi
  fi
  ok "uninstall complete"
  exit 0
}

# ---- dep checks ----
check_deps() {
  info "checking dependencies"
  local fail=0

  if ! command -v node >/dev/null 2>&1; then
    err "node not found on PATH"; fail=1
  else
    local nv
    nv="$(node --version | sed 's/^v//')"
    local major="${nv%%.*}"
    if [[ "$major" -lt 20 ]]; then
      err "node >= 20 required (found $nv)"; fail=1
    else
      ok "node $nv"
    fi
  fi

  if ! command -v npm >/dev/null 2>&1; then
    err "npm not found on PATH"; fail=1
  else
    ok "npm $(npm --version)"
  fi

  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not on PATH — claw-drive won't be useful without it"
  else
    ok "claude $(claude --version 2>&1 | head -1)"
  fi

  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not installed — Bash approver requires it at runtime"
    warn "  install: apt install jq / brew install jq"
  else
    ok "jq $(jq --version)"
  fi

  local nc_ok=0
  if command -v ncat >/dev/null 2>&1; then
    ok "ncat (nmap) available"; nc_ok=1
  fi
  if command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q -- '-U'; then
    ok "nc with -U (Unix sockets) available"; nc_ok=1
  fi
  if [[ "$nc_ok" -eq 0 ]]; then
    warn "no Unix-socket-capable nc/ncat found — Bash approver will fail at runtime"
    warn "  install: apt install netcat-openbsd  (or: apt install ncat)"
  fi

  if [[ "$fail" -eq 1 ]]; then
    err "hard deps missing, aborting"
    exit 1
  fi
}

# ---- build ----
build_if_needed() {
  if [[ -f "$REPO_ROOT/dist/index.js" ]] && [[ "$REPO_ROOT/dist/index.js" -nt "$REPO_ROOT/src/index.ts" ]]; then
    ok "dist/ is up-to-date"
    return
  fi
  info "building (npm install + npm run build)"
  ( cd "$REPO_ROOT" && npm install --silent && npm run build ) || {
    err "build failed"
    exit 1
  }
  ok "built dist/"
}

# ---- install modes ----
ensure_bin_dir() {
  mkdir -p "$BIN_DIR"
}

install_symlink() {
  info "installing (symlink mode) → $BIN_DIR"
  ensure_bin_dir
  # rm first so a prior copy-mode file (not a symlink) is replaced cleanly
  rm -f "$CLAW_DRIVE" "$CLAW_APPROVER"
  ln -s "$REPO_ROOT/bin/claw-drive"           "$CLAW_DRIVE"
  ln -s "$REPO_ROOT/bin/claw-drive-approver"  "$CLAW_APPROVER"
  ok "symlinked $CLAW_DRIVE -> $REPO_ROOT/bin/claw-drive"
  ok "symlinked $CLAW_APPROVER -> $REPO_ROOT/bin/claw-drive-approver"
}

install_copy() {
  info "installing (copy mode) → $BIN_DIR"
  ensure_bin_dir

  # rm first so a prior symlink pointing at the source doesn't alias dest==src
  rm -f "$CLAW_DRIVE" "$CLAW_APPROVER"

  # Copy the approver verbatim — it's a self-contained Bash script.
  cp "$REPO_ROOT/bin/claw-drive-approver" "$CLAW_APPROVER"
  chmod +x "$CLAW_APPROVER"
  ok "copied approver to $CLAW_APPROVER"

  # Generate a bin shim with absolute paths. The shim sets
  # CLAW_DRIVE_APPROVER_BIN so the MCP server writes settings.json pointing at
  # this copy, not at the repo's approver.
  cat > "$CLAW_DRIVE" <<EOF
#!/usr/bin/env node
// Generated by claw-drive install.sh (copy mode) on $(date -u +%Y-%m-%dT%H:%M:%SZ).
// Regenerate by re-running install.sh --copy.
process.env.CLAW_DRIVE_APPROVER_BIN = process.env.CLAW_DRIVE_APPROVER_BIN || "$CLAW_APPROVER";
import("$REPO_ROOT/dist/index.js");
EOF
  chmod +x "$CLAW_DRIVE"
  ok "generated shim at $CLAW_DRIVE"
}

# ---- PATH check ----
check_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
    *)
      warn "$BIN_DIR is NOT on your PATH"
      warn "  add this to your shell rc (e.g. ~/.zshrc or ~/.bashrc):"
      warn "    export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

# ---- verify ----
verify_install() {
  info "verifying install"
  if ! "$CLAW_DRIVE" --help >/dev/null 2>&1; then
    err "claw-drive --help failed; check $CLAW_DRIVE manually"
    exit 1
  fi
  ok "claw-drive --help works"

  if ! "$CLAW_DRIVE" sessions >/dev/null 2>&1; then
    err "claw-drive sessions failed; check logs"
    exit 1
  fi
  ok "claw-drive sessions works"
}

# ---- optional: register in project ----
register_project() {
  [[ -z "$PROJECT" ]] && return
  if [[ ! -d "$PROJECT" ]]; then
    err "--project: $PROJECT is not a directory"
    exit 2
  fi
  local mcp_json="$PROJECT/.mcp.json"
  local tmpf
  tmpf="$(mktemp)"

  if [[ -f "$mcp_json" ]]; then
    jq '.mcpServers = (.mcpServers // {}) | .mcpServers["claw-drive"] = {"command":"claw-drive","args":["mcp"]}' "$mcp_json" > "$tmpf"
    mv "$tmpf" "$mcp_json"
    ok "updated $mcp_json (preserved existing mcpServers)"
  else
    cat > "$mcp_json" <<'EOF'
{
  "mcpServers": {
    "claw-drive": {
      "command": "claw-drive",
      "args": ["mcp"]
    }
  }
}
EOF
    ok "created $mcp_json"
  fi
}

# ---- optional: drop policy template ----
install_policy() {
  [[ -z "$POLICY_DEST" ]] && return
  local src="$REPO_ROOT/templates/claw-drive-policy.json"
  [[ -f "$src" ]] || { err "template missing: $src"; exit 1; }

  local dest_dir
  dest_dir="$(dirname "$POLICY_DEST")"
  mkdir -p "$dest_dir"

  if [[ -f "$POLICY_DEST" ]]; then
    warn "$POLICY_DEST already exists; leaving as-is (remove manually to re-install template)"
  else
    cp "$src" "$POLICY_DEST"
    ok "installed policy template at $POLICY_DEST"
  fi
}

# ---- main ----
main() {
  echo
  info "claw-drive installer"
  info "  repo:     $REPO_ROOT"
  info "  bin dir:  $BIN_DIR"
  info "  mode:     $MODE"
  [[ -n "$PROJECT" ]] && info "  project:  $PROJECT"
  [[ -n "$POLICY_DEST" ]] && info "  policy:   $POLICY_DEST"
  echo

  if [[ "$UNINSTALL" -eq 1 ]]; then
    do_uninstall
  fi

  check_deps
  echo
  build_if_needed
  echo

  case "$MODE" in
    symlink) install_symlink ;;
    copy)    install_copy ;;
  esac
  echo

  check_path
  echo
  verify_install
  echo

  register_project
  install_policy

  echo
  ok "install complete"
  echo
  echo "${DIM}Next steps:${RESET}"
  if [[ -n "$PROJECT" ]]; then
    echo "  cd $PROJECT"
    echo "  claude       # start a dev session; /mcp should list claw-drive"
  else
    echo "  cd <your project>"
    echo "  # add claw-drive to that project's .mcp.json, or re-run:"
    echo "  #   $0 --project <path> --policy <path>/claw-drive-policy.json"
  fi
  echo
}

main