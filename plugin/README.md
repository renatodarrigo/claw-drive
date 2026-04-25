# claw-drive — Claude Code plugin

Slash commands that wrap the claw-drive workflow.

This plugin assumes the `claw-drive` CLI is on your `PATH`. Install it first:

```bash
curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash
```

## Skills

| Slash command | Purpose |
|---|---|
| `/claw-drive-init` | Wire claw-drive into the current project's `.mcp.json` (idempotent) |
| `/claw-drive-start` | Spawn a driven session and start the Monitor flow |
| `/claw-drive-resolve` | Resolve a paused tool call (approve / reject / defer) |

## Install

```
# In any Claude Code session:
/plugin marketplace add renatodarrigo/claw-drive
/plugin install claw-drive@claw-drive
```

The first line registers the marketplace catalog (the `.claude-plugin/marketplace.json` at the repo root); the second installs the plugin. Run `/reload-plugins` after install to activate without restarting.

After install, run `/claw-drive-init` in the project you want to wire claw-drive into.

## What it does NOT do

- Install the binary. The plugin layer is UX only — the CLI must already be installed via the curl-pipe or clone path.
- Auto-register the MCP server in every project. Run `/claw-drive-init` per project (it's idempotent and quick).

## Versioning

Plugin version tracks the CLI version. v0.5.0 plugin works with v0.5.x CLI.
