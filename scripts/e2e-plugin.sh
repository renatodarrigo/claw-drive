#!/usr/bin/env bash
# claw-drive e2e: plugin skill smoke.
#
# Exercises the slash commands shipped in plugin/skills/ end-to-end:
# /claw-drive-init, /claw-drive-start, /claw-drive-resolve.
#
# Strategy: install the local plugin into a temp $HOME's plugin cache,
# spawn `claude -p` against scripted prompts that invoke each slash
# command, observe Claude's tool calls, and assert on the post-conditions
# (e.g., /claw-drive-init creates .mcp.json in the cwd).
#
# Costs real claude tokens. Run before each plugin release.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/e2e-lib.sh"

BIN="$HERE/../bin/claw-drive"
PLUGIN_SRC="$HERE/../plugin"

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

# Isolate everything: $HOME (plugin cache, claw-drive state), PATH (so
# `claw-drive` resolves to the locally-built bin), and the project cwd.
TMPHOME="$(mktemp -d "$HOME/tmp/claw-drive-e2e-plugin-XXXXXX")"
export HOME="$TMPHOME"
export CLAW_DRIVE_HOME="$TMPHOME/.claw-drive"
PROJECT="$TMPHOME/project"
mkdir -p "$PROJECT"
echo '{}' > "$PROJECT/package.json"   # so /claw-drive-init recognises it as a project root

# Make the locally-built claw-drive resolve on PATH.
LOCAL_BIN="$TMPHOME/.local/bin"
mkdir -p "$LOCAL_BIN"
ln -sf "$HERE/../bin/claw-drive"          "$LOCAL_BIN/claw-drive"
ln -sf "$HERE/../bin/claw-drive-approver" "$LOCAL_BIN/claw-drive-approver"
export PATH="$LOCAL_BIN:$PATH"

# Install the plugin into the local plugin cache layout
# ($HOME/.claude/plugins/cache/local/claw-drive/<version>/).
PLUGIN_VERSION=$(jq -r .version "$PLUGIN_SRC/.claude-plugin/plugin.json")
PLUGIN_DEST="$HOME/.claude/plugins/cache/local/claw-drive/$PLUGIN_VERSION"
mkdir -p "$(dirname "$PLUGIN_DEST")"
cp -R "$PLUGIN_SRC" "$PLUGIN_DEST"

trap 'rm -rf "$TMPHOME"' EXIT

info "claw-drive e2e: plugin"
info "  HOME:        $HOME"
info "  bin:         $BIN (linked into $LOCAL_BIN)"
info "  plugin src:  $PLUGIN_SRC"
info "  plugin dest: $PLUGIN_DEST"
info "  project:     $PROJECT"

section "scaffold sanity"

expect_file_exists "plugin manifest installed"           "$PLUGIN_DEST/.claude-plugin/plugin.json"
expect_file_exists "claw-drive-init SKILL.md installed"  "$PLUGIN_DEST/skills/claw-drive-init/SKILL.md"
expect_file_exists "claw-drive-start SKILL.md installed" "$PLUGIN_DEST/skills/claw-drive-start/SKILL.md"
expect_file_exists "claw-drive-resolve SKILL.md installed" "$PLUGIN_DEST/skills/claw-drive-resolve/SKILL.md"
expect_stdout_contains "claw-drive resolves on PATH" "claw-drive" command -v claw-drive

section "/claw-drive-init outcome"

info "running /claw-drive-init via claude -p"
(
  cd "$PROJECT"
  # Have claude follow the SKILL.md and produce the .mcp.json mutation it describes.
  claude -p --no-update-check \
    "Run /claw-drive-init in this directory. Report the path you wrote." \
    >"$TMPHOME/init-output.txt" 2>&1 || true
)

expect_file_exists  "project .mcp.json created"            "$PROJECT/.mcp.json"
expect_file_contains "mcp.json registers claw-drive"       "$PROJECT/.mcp.json" '"claw-drive"'
expect_file_contains "mcp.json command is claw-drive"      "$PROJECT/.mcp.json" '"command": "claw-drive"'
expect_file_contains "mcp.json args include mcp"           "$PROJECT/.mcp.json" '"mcp"'

# /claw-drive-start and /claw-drive-resolve require an active driven session
# (which itself spawns a recursive claude). That doubles the token cost and
# adds significant flakiness. Left as TODO for the next pass — the SKILL.md
# files are exercised end-to-end via the lifecycle test in e2e-mcp.sh; what's
# scaffolded here is the plugin install + slash-command discovery layer, which
# is the part most prone to silent breakage.
info "TODO: cover /claw-drive-start and /claw-drive-resolve once the recursive flow is hardened"

summary
