---
name: claw-drive-init
description: Wire claw-drive into the current project's `.mcp.json` so it appears in Claude Code's MCP list. Idempotent — re-run safely. Optionally drops a starter policy at the path you pass via `--policy <path>`. Usage — /claw-drive-init [--policy <path>].
---

# Claw-drive — init

The user has invoked this skill to register claw-drive in the current project. This is a one-time-per-project setup step. After running this skill, the next time Claude Code is launched in this project, `claw-drive` will appear in the MCP list.

## Steps

1. **Verify the CLI is installed.** Run:
   ```bash
   command -v claw-drive >/dev/null 2>&1 && claw-drive sessions >/dev/null 2>&1 && echo OK || echo MISSING
   ```
   The `sessions` subcommand is used as the aliveness probe (it exits 0 on every supported CLI version, including pre-`--version` builds). If output is `MISSING` or the command fails, stop and tell the user:
   > claw-drive CLI not found on PATH. Install it first:
   >
   > ```
   > curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash
   > ```
   >
   > Then re-run `/claw-drive-init`.

   Do not proceed.

2. **Capture the project root.** Use the current working directory (the user invoked the skill from inside their project). Confirm with the user before continuing if it doesn't look like a project root (no `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.).

3. **Verify `jq` is available.** Run `command -v jq >/dev/null 2>&1`. If missing, ask the user to install it (`apt install jq` / `brew install jq`) and stop.

4. **Register in `.mcp.json`.** Use jq to add (or replace) the claw-drive entry under `mcpServers`. If the file doesn't exist, create it.

   If `.mcp.json` already exists:
   ```bash
   jq '.mcpServers = (.mcpServers // {}) | .mcpServers["claw-drive"] = {"command":"claw-drive","args":["mcp"]}' .mcp.json > .mcp.json.tmp && mv .mcp.json.tmp .mcp.json
   ```

   Otherwise:
   ```bash
   cat > .mcp.json <<'EOF'
   {
     "mcpServers": {
       "claw-drive": {
         "command": "claw-drive",
         "args": ["mcp"]
       }
     }
   }
   EOF
   ```

5. **Drop the starter policy** if `--policy <path>` was passed. Find the template inside the source dir reported by `claw-drive` itself, or fetch from the repo as a fallback:
   ```bash
   src_dir="${XDG_DATA_HOME:-$HOME/.local/share}/claw-drive"
   src="$src_dir/templates/claw-drive-policy.json"
   if [[ -f "$src" ]]; then
     cp "$src" "<policy-path>"
   else
     curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/templates/claw-drive-policy.json -o "<policy-path>"
   fi
   ```
   Skip if the destination already exists (warn the user; don't overwrite).

6. **Confirm and explain next steps.** Report:
   - `.mcp.json` updated at `<project>/.mcp.json`
   - Restart Claude Code (or run `/mcp` in this session) to see `claw-drive` in the MCP list
   - Next: `/claw-drive-start` to spawn a driven session

## What this skill does NOT do

- Install the CLI binary. That's `curl … | bash`.
- Start a driven session. Use `/claw-drive-start`.
- Modify any other field in `.mcp.json`. Existing `mcpServers` entries are preserved.
