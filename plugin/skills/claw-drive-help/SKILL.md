---
name: claw-drive-help
description: Load claw-drive's full capability map — the mental model (Session A/B, gates, policy, budget, watch/fleet, sentinel vocabulary), every CLI command, and every MCP tool. Runs `claw-drive help`. Use at the start of a driving session, or whenever unsure what claw-drive can do. Usage — /claw-drive-help.
---

# Claw-drive — help

The user has invoked this skill to build (or refresh) a mental model of claw-drive before driving a session.

Run the CLI capability map and read all of it:

```bash
claw-drive help
```

The output is the single source of truth for what claw-drive can do: the Session A/B model, the driving loop, the policy/gate/budget model, the sentinel vocabulary, fleet/`watch --all`, every CLI command (with usage), and every MCP tool (with description). Internalize it, then use it to plan how you'll drive — which policy to start with, how you'll watch the session, and how you'll resolve the decisions it surfaces.

If `claw-drive` is not found, the CLI isn't installed on this machine — install it with `curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash`, or run `/claw-drive-init` to wire it into this project first.
