# v0.1.0 acceptance walkthrough — cloverleaf dogfood

This is the v0.1.0 acceptance gate. Run these steps manually before tagging.

## Prerequisites

- `claude` on PATH (tested with claude 2.1.117)
- `jq` and `nc` (or `ncat`) available — `claw-drive-approver` runtime deps
- `~/Workspace/cloverleaf` on branch `main` with v0.4.0+ reference-impl installed
- `claw-drive` built: `cd ~/Workspace/claw-drive && npm run build`
- `claw-drive` on PATH (or alias): `export PATH=~/Workspace/claw-drive/bin:$PATH`

## Steps

1. Start a Session A (your dev session) in `~/Workspace/cloverleaf`:
   ```
   cd ~/Workspace/cloverleaf && claude
   ```

2. In `~/Workspace/cloverleaf/.mcp.json` (or user-level `~/.claude/mcp.json`), register the claw-drive MCP server:
   ```json
   {
     "mcpServers": {
       "claw-drive": { "command": "claw-drive", "args": ["mcp"] }
     }
   }
   ```

3. In Session A, ask:
   > Use claw-drive to start a session in `~/Workspace/cloverleaf` with a dogfood policy. Drive it through the CLV-007 scenario from `docs/superpowers/plans/2026-04-21-v0.4.0-dogfood-handoff.md`. Surface any escalated approvals to me.

4. Session A will:
   - Call `start_session` with cwd + policy.
   - Send the handoff doc content as the first user turn.
   - Poll and surface pending approvals.

5. Approve escalations as they appear. Should be < 10 for full CLV-007 with a reasonable policy.

6. Verify after the pipeline completes:
   ```bash
   ls ~/Workspace/cloverleaf/.cloverleaf/baselines/faq-*.png
   git log --oneline -1 ~/Workspace/cloverleaf
   ```
   Expected: 3 PNG baselines + merge commit for CLV-007.

## Pass criteria

- [ ] CLV-007 scenario completed with merge commit on main
- [ ] Cumulative `pending_approvals` < 10 across the run
- [ ] No `SESSION_ORPHANED` or `START_FAILED` errors
- [ ] Session A did not crash
- [ ] Approval review time for the human: < 5 min

## If it fails

Capture the session events: `claw-drive tail <session_id> > acceptance-failure.jsonl` and note which step broke. Attach to a follow-up issue.
