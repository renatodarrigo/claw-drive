---
name: claw-drive-status
description: Fetch a snapshot of one or all driven claw-drive sessions and characterize what's happening. Usage — /claw-drive-status [<session-id>]. Calls `claw-drive status [--json]` under the hood, parses the result, and surfaces what's noteworthy (sessions waiting on input, pending tool decisions, recent failures) — does NOT dump raw JSON to the user. Use this when the user asks "what's going on?" or you need a cold-start snapshot of in-flight driven sessions.
---

# Claw-drive — status

The user has invoked this skill to ask "what's happening across the driven sessions?" Your job is to fetch a structured snapshot and characterize it for the user — *not* to dump raw JSON into the chat.

## Steps

1. **Validate the optional session id.** If the user passed an argument, check it looks like a valid session id (`sess_…`). If invalid, report and stop.

2. **Verify the `claw-drive` CLI is on `PATH`.** If running `claw-drive` exits non-zero with "command not found" (or similar), tell the user:
   > claw-drive isn't installed or isn't on your PATH. Install via `curl -fsSL https://raw.githubusercontent.com/renatodarrigo/claw-drive/main/install.sh | bash`, or run `/claw-drive-init` if you've installed but haven't wired it into this project.

   Stop.

3. **Run the CLI.** Use the JSON form so you get structured data:
   - With session id: `claw-drive status <session-id> --json`
   - Without: `claw-drive status --json`

   Capture stdout + exit code. If exit code is `1`, the session id was unknown — surface "session `<id>` not found." If exit code is `2` or `3`, surface the stderr message verbatim.

4. **Parse the JSON.** Single-session form is a bare object `{ session_id, status, ... }`. All-sessions form is `{ "sessions": [ ... ] }`.

5. **Characterize, don't dump.** Apply this priority chain when summarizing the result back to the user:

   - **Pending decisions with `severity: "high"`** → flag first. Quote the `tool` + a snippet of `args_summary`, and note how long they've been waiting (`age_seconds`). These are the most urgent items.
   - **`current_turn.last_token` ∈ `{NEEDS-INPUT, NEEDS-DECISION, NEEDS-CONFIRMATION, NEEDS-CLARIFICATION}`** → surface the session's `last_assistant_text` and frame as "Session B is waiting on you." This is the v0.5.6-forward signal — B has explicitly indicated human input is needed.
   - **`current_turn.last_token` ∈ `{ERROR, FAILED-NO-RETRY}`** OR **`last_completed_turn.last_token` in same set** → surface as a failure that needs human action.
   - **`current_turn.last_token === "INFO-FINISHED"`** with no current activity → "Session B reports the task is complete."
   - **Lower-severity pending decisions** (`medium` / `low`) → mention briefly with the same tool + args + age structure.
   - **`recent_errors` non-empty** → mention the count + the most recent error's `summary`. Don't enumerate all three unless the user asks.
   - **All quiet** (no pending, no errors, no needs-* tokens) → "N session(s) running, nothing pending. Session B finished its last turn at <timestamp> saying: '<short snippet of last_assistant_text>'."

6. **Multi-session output** (no session id was passed):
   - Lead with the count and rough breakdown (`X running, Y stopped, Z orphaned`).
   - Call out the noteworthy sessions by id (only those with pending decisions, errors, or NEEDS-* tokens). Use a short id form (first ~20 chars + `…`) so the chat doesn't get unwieldy.
   - Don't enumerate quiet sessions individually — group as a count at the bottom.

7. **Single-session output** (session id was passed):
   - The user wants depth. Lead with `current_turn.last_assistant_text` (or `last_completed_turn.last_assistant_text` if no current turn) so they know what B is "saying right now."
   - Then surface pending decisions and recent errors as above.

## Format guidance

- Keep responses tight. The point is *signal*, not exhaustive listing.
- Use the user's actual question to focus your answer. "What's blocked?" → lead with pending decisions. "What did B finish?" → lead with `last_completed_turn`. "Anything broken?" → lead with `recent_errors`.
- Quote `last_assistant_text` snippets in italics or block-quotes so the user can distinguish B's words from your characterization.
- Times in the JSON are ISO-8601 UTC. Convert to relative ("2 minutes ago") or local time only when it improves readability.

## What this skill does NOT do

- Dump raw JSON. Always characterize.
- Resolve pending decisions. That's `/claw-drive-resolve`.
- Stream live updates. This is on-demand snapshot only — re-run when the user asks again.
- Run if `claw-drive` isn't installed. Tell the user how to install.
