#!/usr/bin/env bash
# claw-drive e2e: plugin skill smoke.
#
# Exercises the slash commands shipped in plugin/skills/ end-to-end:
# /claw-drive-init, and (TODO) /claw-drive-start, /claw-drive-resolve.
#
# Strategy: spawn `claude --print --plugin-dir <repo>/plugin` against a
# scripted prompt that invokes the slash command, then assert on the
# observed post-conditions (e.g., /claw-drive-init creates .mcp.json).
#
# Notes on design choices (verified by running each variant):
#   - $HOME is NOT isolated. Overriding $HOME breaks claude auth — claude
#     stops with "Not logged in · Please run /login". We let it use the
#     real auth + skip-state instead.
#   - The plugin is loaded via `--plugin-dir <path>` (per claude --help:
#     "Load plugins from a directory for this session only"). No need to
#     install into ~/.claude/plugins/cache/.
#   - `--permission-mode bypassPermissions` (per claude --help) so the
#     slash command can run jq + write files non-interactively.
#   - The locally-built claw-drive bin is prepended to PATH so the skill
#     finds it even if the user has not installed claw-drive globally.
#
# Costs real claude tokens. Run before each plugin release.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/e2e-lib.sh"

REPO_ROOT="$(cd "$HERE/.." && pwd)"
BIN="$REPO_ROOT/bin/claw-drive"
PLUGIN_SRC="$REPO_ROOT/plugin"

if [[ ! -x "$BIN" ]]; then
  echo "ERROR: $BIN not executable. Run 'npm run build' first." >&2
  exit 2
fi

if [[ ! -d "$PLUGIN_SRC/.claude-plugin" ]]; then
  echo "ERROR: $PLUGIN_SRC/.claude-plugin missing." >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude CLI not on PATH; e2e-plugin.sh requires real claude." >&2
  exit 2
fi

TMPROOT="$(mktemp -d "$HOME/tmp/claw-drive-e2e-plugin-XXXXXX")"
PROJECT="$TMPROOT/project"
mkdir -p "$PROJECT"
echo '{}' > "$PROJECT/package.json"   # so /claw-drive-init recognises a project root

# Prepend the locally-built bin so the plugin skill finds claw-drive on PATH
# regardless of whether the user has installed it globally.
export PATH="$REPO_ROOT/bin:$PATH"

# Isolate claw-drive runtime state to the temp dir.
export CLAW_DRIVE_HOME="$TMPROOT/.claw-drive"

trap 'rm -rf "$TMPROOT"' EXIT

info "claw-drive e2e: plugin"
info "  repo:        $REPO_ROOT"
info "  plugin src:  $PLUGIN_SRC"
info "  project:     $PROJECT"
info "  TMPROOT:     $TMPROOT"
info "  CLAW_DRIVE_HOME: $CLAW_DRIVE_HOME"

section "scaffold sanity"

expect_file_exists "plugin manifest"                   "$PLUGIN_SRC/.claude-plugin/plugin.json"
expect_file_exists "claw-drive-init SKILL.md"          "$PLUGIN_SRC/skills/claw-drive-init/SKILL.md"
expect_file_exists "claw-drive-start SKILL.md"         "$PLUGIN_SRC/skills/claw-drive-start/SKILL.md"
expect_file_exists "claw-drive-resolve SKILL.md"       "$PLUGIN_SRC/skills/claw-drive-resolve/SKILL.md"
expect_stdout_contains "claw-drive resolves on PATH" "claw-drive" command -v claw-drive

section "/claw-drive-init outcome"

info "running /claw-drive-init via claude --print --plugin-dir"
(
  cd "$PROJECT"
  claude --print \
    --plugin-dir "$PLUGIN_SRC" \
    --permission-mode bypassPermissions \
    "Run the /claw-drive-init slash command in this directory. After it completes, report the absolute path of the file it wrote." \
    >"$TMPROOT/init-output.txt" 2>&1 || true
)

expect_file_exists  "project .mcp.json created"            "$PROJECT/.mcp.json"
expect_file_contains "mcp.json registers claw-drive"       "$PROJECT/.mcp.json" '"claw-drive"'
expect_file_contains "mcp.json command is claw-drive"      "$PROJECT/.mcp.json" '"command":'
expect_file_contains "mcp.json args include mcp"           "$PROJECT/.mcp.json" '"mcp"'

# /claw-drive-start and /claw-drive-resolve require a live driven session
# (which itself spawns a recursive claude). That doubles the token cost and
# adds significant flakiness. Left as a TODO for the next pass — the
# lifecycle these skills wrap is already exercised end-to-end in e2e-mcp.sh.
info "TODO: cover /claw-drive-start and /claw-drive-resolve once the recursive flow is hardened"

summary
