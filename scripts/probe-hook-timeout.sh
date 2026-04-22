#!/usr/bin/env bash
# probe-hook-timeout.sh
#
# Probes claude 2.1.117 PreToolUse hook behavior:
#   - Probe A: baseline (hook captures stdin, returns approve)
#   - Probe B: timeout binary search (sleep N before approving)
#   - Probe C: configurable timeout via settings.json timeout field
#   - Probe D: structured decision responses (approve vs block)
#
# Artifacts go under $HOME/tmp/claw-drive-hook-probe/ (inside $HOME for
# claude's isInsideHome check).
#
# Usage: bash scripts/probe-hook-timeout.sh [--skip-slow]
#   --skip-slow  Skip the long sleep probes (B-30, B-60, B-120, B-300)
#
# Idempotent: re-run safely, artifacts are timestamped or overwritten.

set -uo pipefail

CLAUDE="${CLAUDE:-~/.local/bin/claude}"
PROBE_DIR="$HOME/tmp/claw-drive-hook-probe"
SKIP_SLOW="${1:-}"

mkdir -p "$PROBE_DIR"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
divider() { echo ""; echo "═══════════════════════════════════════════════════════"; echo "$1"; echo "═══════════════════════════════════════════════════════"; echo ""; }

# ---------------------------------------------------------------------------
# Write the hook script that captures stdin and outputs a decision
# ---------------------------------------------------------------------------
write_hook() {
    local hook_path="$1"
    local sleep_secs="$2"        # 0 = no sleep
    local decision="$3"          # approve | block | block_exit2 | legacy_approve
    local log_path="$4"

    cat > "$hook_path" << HOOKEOF
#!/usr/bin/env bash
# Auto-generated probe hook — do not edit by hand
set -uo pipefail

HOOK_LOG="${log_path}"
STDIN_PAYLOAD="${PROBE_DIR}/stdin-payload.json"
START_TS=\$(date +%s.%3N)

# Capture stdin
INPUT=\$(cat)
echo "\$INPUT" > "\$STDIN_PAYLOAD"

# Log invocation
echo "HOOK_START ts=\$START_TS sleep=${sleep_secs} decision=${decision}" >> "\$HOOK_LOG"
echo "STDIN=\$INPUT" >> "\$HOOK_LOG"

# Sleep (simulates human-in-the-loop wait)
if [[ "${sleep_secs}" -gt 0 ]]; then
    sleep "${sleep_secs}"
fi

END_TS=\$(date +%s.%3N)
echo "HOOK_END ts=\$END_TS" >> "\$HOOK_LOG"

# Output decision
case "${decision}" in
    approve)
        # Structured approve via hookSpecificOutput (correct 2.1.x format)
        echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"probe approved"}}'
        exit 0
        ;;
    block)
        # Structured block via hookSpecificOutput (correct 2.1.x format)
        echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe block"}}'
        exit 2
        ;;
    block_exit2)
        # Block via exit 2 only (no JSON output) — simplest approach
        echo "BLOCKED by probe hook" >&2
        exit 2
        ;;
    legacy_approve)
        # Simple legacy format: just exit 0 with empty JSON
        echo '{}'
        exit 0
        ;;
    legacy_block)
        # Legacy block with systemMessage field
        echo '{"systemMessage":"probe blocked via legacy format","blocked":true}'
        exit 2
        ;;
    *)
        echo "Unknown decision: ${decision}" >&2
        exit 1
        ;;
esac
HOOKEOF
    chmod +x "$hook_path"
}

# ---------------------------------------------------------------------------
# Write a settings.json that registers the hook for PreToolUse
# ---------------------------------------------------------------------------
write_settings() {
    local settings_path="$1"
    local hook_path="$2"
    local timeout_secs="${3:-}"   # empty = omit (use default)

    if [[ -n "$timeout_secs" ]]; then
        cat > "$settings_path" << SETTINGSEOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${hook_path}",
            "timeout": ${timeout_secs}
          }
        ]
      }
    ]
  }
}
SETTINGSEOF
    else
        cat > "$settings_path" << SETTINGSEOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${hook_path}"
          }
        ]
      }
    ]
  }
}
SETTINGSEOF
    fi
}

# ---------------------------------------------------------------------------
# Run claude in stream-json mode with a hook, capture output and wall time
# ---------------------------------------------------------------------------
run_probe() {
    local label="$1"
    local settings_path="$2"
    local out_path="$3"
    local timeout_wall="${4:-400}"   # max seconds to wait (kill claude after this)

    log "Running $label (wall timeout: ${timeout_wall}s)..."
    local t0=$SECONDS

    # Use a tmp dir inside HOME so isInsideHome check passes
    local tmp_cwd="$PROBE_DIR/cwd"
    mkdir -p "$tmp_cwd"

    timeout "$timeout_wall" \
        bash -c "cd '$tmp_cwd' && echo '{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Run the bash command: echo hello-hook\"}}' \
        | '$CLAUDE' -p \
            --output-format=stream-json \
            --input-format=stream-json \
            --permission-mode=default \
            --max-turns=2 \
            --verbose \
            --settings '$settings_path' \
            --include-hook-events \
            2>&1" \
        > "$out_path" 2>&1 || true

    local wall=$(( SECONDS - t0 ))
    log "$label done in ${wall}s"
    echo "WALL_TIME_SECS=${wall}" >> "$out_path"
    echo "$wall"
}

# ---------------------------------------------------------------------------
# Parse key fields from a stream-json output file
# ---------------------------------------------------------------------------
summarize_output() {
    local path="$1"
    local label="$2"
    echo ""
    echo "--- $label ---"

    if [[ ! -f "$path" ]]; then
        echo "  (no output file)"
        return
    fi

    # Extract result event
    local result_line
    result_line=$(grep '"type":"result"' "$path" 2>/dev/null | tail -1 || echo "")
    if [[ -n "$result_line" ]]; then
        echo "  result.subtype: $(echo "$result_line" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("subtype","?"))' 2>/dev/null || echo "?")"
        echo "  result.stop_reason: $(echo "$result_line" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("stop_reason","?"))' 2>/dev/null || echo "?")"
        echo "  result.terminal_reason: $(echo "$result_line" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("terminal_reason","?"))' 2>/dev/null || echo "?")"
        echo "  result.permission_denials: $(echo "$result_line" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("permission_denials","?"))' 2>/dev/null || echo "?")"
        echo "  result.is_error: $(echo "$result_line" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("is_error","?"))' 2>/dev/null || echo "?")"
    else
        echo "  (no result event found)"
    fi

    # Check for hook_timeout or error events
    if grep -q '"hook_timeout"\|timeout\|killed\|SIGKILL' "$path" 2>/dev/null; then
        echo "  *** TIMEOUT/KILL signals found in output ***"
        grep '"hook_timeout"\|timeout\|killed\|SIGKILL' "$path" 2>/dev/null | head -3
    fi

    # Check for tool result (did the Bash tool actually run?)
    if grep -q '"tool_result"\|"stdout":"hello-hook"' "$path" 2>/dev/null; then
        echo "  tool_ran: YES (hello-hook found in output)"
    else
        echo "  tool_ran: NO (hello-hook not found)"
    fi

    # Check for permission_denied hook event
    if grep -q 'permission_denied\|permissionDecision.*deny' "$path" 2>/dev/null; then
        echo "  hook_blocked: YES"
    fi

    # Wall time
    local wall
    wall=$(grep 'WALL_TIME_SECS=' "$path" | tail -1 | cut -d= -f2 || echo "?")
    echo "  wall_time: ${wall}s"
}

# ============================================================================
# PROBE A — Baseline: capture stdin, structured approve, no sleep
# ============================================================================
divider "PROBE A — Baseline (approve, no sleep)"

PROBE_A_DIR="$PROBE_DIR/probe-a"
mkdir -p "$PROBE_A_DIR"
HOOK_A="$PROBE_A_DIR/hook.sh"
SETTINGS_A="$PROBE_A_DIR/settings.json"
LOG_A="$PROBE_A_DIR/hook.log"
OUT_A="$PROBE_A_DIR/output.jsonl"

write_hook "$HOOK_A" 0 "approve" "$LOG_A"
write_settings "$SETTINGS_A" "$HOOK_A"

run_probe "Probe A (approve, 0s)" "$SETTINGS_A" "$OUT_A" 60

# Show stdin payload
echo ""
echo "=== Hook stdin payload ==="
if [[ -f "$PROBE_DIR/stdin-payload.json" ]]; then
    python3 -m json.tool "$PROBE_DIR/stdin-payload.json" 2>/dev/null || cat "$PROBE_DIR/stdin-payload.json"
else
    echo "(not captured)"
fi

# Show hook log
echo ""
echo "=== Hook log ==="
cat "$LOG_A" 2>/dev/null || echo "(empty)"

summarize_output "$OUT_A" "Probe A result"

# ============================================================================
# PROBE A2 — Baseline with LEGACY format (exit 0 + empty JSON)
# ============================================================================
divider "PROBE A2 — Legacy approve format (exit 0 + {})"

PROBE_A2_DIR="$PROBE_DIR/probe-a2"
mkdir -p "$PROBE_A2_DIR"
HOOK_A2="$PROBE_A2_DIR/hook.sh"
SETTINGS_A2="$PROBE_A2_DIR/settings.json"
LOG_A2="$PROBE_A2_DIR/hook.log"
OUT_A2="$PROBE_A2_DIR/output.jsonl"

write_hook "$HOOK_A2" 0 "legacy_approve" "$LOG_A2"
write_settings "$SETTINGS_A2" "$HOOK_A2"

run_probe "Probe A2 (legacy_approve)" "$SETTINGS_A2" "$OUT_A2" 60
summarize_output "$OUT_A2" "Probe A2 result"

# ============================================================================
# PROBE D — Structured BLOCK decisions
# ============================================================================
divider "PROBE D1 — Structured block (hookSpecificOutput permissionDecision=deny)"

PROBE_D1_DIR="$PROBE_DIR/probe-d1"
mkdir -p "$PROBE_D1_DIR"
HOOK_D1="$PROBE_D1_DIR/hook.sh"
SETTINGS_D1="$PROBE_D1_DIR/settings.json"
LOG_D1="$PROBE_D1_DIR/hook.log"
OUT_D1="$PROBE_D1_DIR/output.jsonl"

write_hook "$HOOK_D1" 0 "block" "$LOG_D1"
write_settings "$SETTINGS_D1" "$HOOK_D1"

run_probe "Probe D1 (structured block)" "$SETTINGS_D1" "$OUT_D1" 60
summarize_output "$OUT_D1" "Probe D1 result"

divider "PROBE D2 — Exit-code-2 only block (no JSON)"

PROBE_D2_DIR="$PROBE_DIR/probe-d2"
mkdir -p "$PROBE_D2_DIR"
HOOK_D2="$PROBE_D2_DIR/hook.sh"
SETTINGS_D2="$PROBE_D2_DIR/settings.json"
LOG_D2="$PROBE_D2_DIR/hook.log"
OUT_D2="$PROBE_D2_DIR/output.jsonl"

write_hook "$HOOK_D2" 0 "block_exit2" "$LOG_D2"
write_settings "$SETTINGS_D2" "$HOOK_D2"

run_probe "Probe D2 (exit2 block)" "$SETTINGS_D2" "$OUT_D2" 60
summarize_output "$OUT_D2" "Probe D2 result"

# ============================================================================
# PROBE B — Timeout binary search
# Only sleep values that are short enough to be worth running automatically.
# For >60s probes we note what to expect but skip unless --full is passed.
# ============================================================================
divider "PROBE B — Timeout probes"

echo "Default command hook timeout per docs: 600s"
echo "We probe: 5s, 30s, and 65s (just over default user-level timeout=60 from settings.json)"
echo "(to verify the settings.json timeout field is honored)"
echo ""

# B-5: 5 second sleep (sanity check — should complete fine)
for sleep_secs in 5 30; do
    if [[ "$SKIP_SLOW" == "--skip-slow" && "$sleep_secs" -gt 5 ]]; then
        log "Skipping B-${sleep_secs} (--skip-slow)"
        continue
    fi

    PROBE_BN_DIR="$PROBE_DIR/probe-b${sleep_secs}"
    mkdir -p "$PROBE_BN_DIR"
    HOOK_BN="$PROBE_BN_DIR/hook.sh"
    SETTINGS_BN="$PROBE_BN_DIR/settings.json"
    LOG_BN="$PROBE_BN_DIR/hook.log"
    OUT_BN="$PROBE_BN_DIR/output.jsonl"

    write_hook "$HOOK_BN" "$sleep_secs" "approve" "$LOG_BN"
    # No timeout in settings — use default
    write_settings "$SETTINGS_BN" "$HOOK_BN"

    divider "PROBE B-${sleep_secs}s (no timeout in settings, sleep ${sleep_secs}s)"
    wall=$(run_probe "Probe B-${sleep_secs}" "$SETTINGS_BN" "$OUT_BN" $(( sleep_secs + 30 )) )
    summarize_output "$OUT_BN" "Probe B-${sleep_secs} result"
done

# ============================================================================
# PROBE C — settings.json timeout field: set timeout=15, sleep=30 → should timeout
# ============================================================================
divider "PROBE C — Configured timeout field (timeout=15, sleep=30)"

PROBE_C_DIR="$PROBE_DIR/probe-c"
mkdir -p "$PROBE_C_DIR"
HOOK_C="$PROBE_C_DIR/hook.sh"
SETTINGS_C="$PROBE_C_DIR/settings.json"
LOG_C="$PROBE_C_DIR/hook.log"
OUT_C="$PROBE_C_DIR/output.jsonl"

write_hook "$HOOK_C" 30 "approve" "$LOG_C"
# Settings with timeout=15 — hook sleeps 30, so should be killed at 15s
write_settings "$SETTINGS_C" "$HOOK_C" 15

if [[ "$SKIP_SLOW" != "--skip-slow" ]]; then
    wall=$(run_probe "Probe C (timeout=15, sleep=30)" "$SETTINGS_C" "$OUT_C" 60)
    summarize_output "$OUT_C" "Probe C result (timeout=15 honored?)"

    echo ""
    echo "=== Probe C hook log (did hook get killed before completing?) ==="
    cat "$LOG_C" 2>/dev/null || echo "(empty — hook may not have started)"
    echo ""
    echo "Key: if HOOK_END appears in log, hook completed BEFORE timeout (timeout not honored)"
    echo "Key: if only HOOK_START appears, hook was killed by timeout (timeout IS honored)"
else
    log "Skipping Probe C (--skip-slow)"
fi

# ============================================================================
# FINAL SUMMARY
# ============================================================================
divider "SUMMARY"

echo "Probe A  — approve (structured hookSpecificOutput format):"
echo "  See: $PROBE_DIR/probe-a/output.jsonl"
echo ""
echo "Probe A2 — approve (legacy {} format):"
echo "  See: $PROBE_DIR/probe-a2/output.jsonl"
echo ""
echo "Probe D1 — block (structured hookSpecificOutput permissionDecision=deny):"
echo "  See: $PROBE_DIR/probe-d1/output.jsonl"
echo ""
echo "Probe D2 — block (exit code 2 only):"
echo "  See: $PROBE_DIR/probe-d2/output.jsonl"
echo ""
echo "Probe B  — timeout binary search results:"
for d in "$PROBE_DIR"/probe-b*/; do
    [[ -d "$d" ]] || continue
    out="$d/output.jsonl"
    wall=$(grep 'WALL_TIME_SECS=' "$out" 2>/dev/null | tail -1 | cut -d= -f2 || echo "?")
    tool_ran=$(grep -c '"stdout":"hello-hook"\|hello-hook' "$out" 2>/dev/null || echo 0)
    echo "  $(basename "$d"): wall=${wall}s, tool_ran=$([[ "$tool_ran" -gt 0 ]] && echo YES || echo NO)"
done
echo ""
echo "Probe C  — configured timeout field:"
if [[ -f "$PROBE_DIR/probe-c/output.jsonl" ]]; then
    wall=$(grep 'WALL_TIME_SECS=' "$PROBE_DIR/probe-c/output.jsonl" 2>/dev/null | tail -1 | cut -d= -f2 || echo "?")
    echo "  probe-c: wall=${wall}s"
    echo "  Hook log: $(cat "$PROBE_DIR/probe-c/hook.log" 2>/dev/null || echo "(empty)")"
fi
echo ""
echo "stdin payload captured at: $PROBE_DIR/stdin-payload.json"
echo ""
echo "Done. Review all outputs under: $PROBE_DIR"
