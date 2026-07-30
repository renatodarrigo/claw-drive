#!/usr/bin/env bash
# context-rotation step-0 probe: what does `claude -p` stream-json mode do when the
# context window fills? Silent auto-compact, a marked compact boundary, or an
# error_* result — and does the session survive the event?
#
# Run manually: bash scripts/probe-context-limit.sh
# COSTS REAL TOKENS (~1M cumulative input on the default model/turn settings).
# Requires: `claude` and `jq` on PATH.
#
# Knobs (env): CLAUDE, MODEL (default haiku), PAD_WORDS (per padded turn,
# default 30000 ≈ ~40k tokens), MAX_PAD_TURNS (default 8), TURN_TIMEOUT (s).

set -euo pipefail

CLAUDE="${CLAUDE:-claude}"
MODEL="${MODEL:-haiku}"
PAD_WORDS="${PAD_WORDS:-30000}"
MAX_PAD_TURNS="${MAX_PAD_TURNS:-8}"
TURN_TIMEOUT="${TURN_TIMEOUT:-300}"

repo="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$repo/tests/fixtures/stream-json"
mkdir -p "$out_dir"
raw="$out_dir/context-limit.jsonl"
: > "$raw"

work="$(mktemp -d)"
err="$work/stderr.log"
fifo="$work/stdin.fifo"
mkfifo "$fifo"

echo "probe: $("$CLAUDE" --version 2>/dev/null | head -1) model=$MODEL pad_words=$PAD_WORDS max_pad_turns=$MAX_PAD_TURNS"
echo "probe: raw capture -> $raw"

(
  cd "$work" && exec "$CLAUDE" -p \
    --output-format=stream-json \
    --input-format=stream-json \
    --permission-mode=bypassPermissions \
    --model "$MODEL" \
    --verbose \
    < "$fifo" > "$raw" 2> "$err"
) &
cpid=$!
exec 3> "$fifo"
trap 'exec 3>&- 2>/dev/null || true; kill "$cpid" 2>/dev/null || true' EXIT

# 15 words per repeat; no yes|head (SIGPIPE + pipefail footgun).
pad="$(printf 'the quick brown fox jumps over the lazy dog near the quiet river bank at dawn %.0s' $(seq 1 $((PAD_WORDS / 15))))"

send_turn() { # $1 = message text (may exceed the execve per-arg limit: pipe, don't --arg)
  printf '%s' "$1" | jq -Rsc '{type:"user",message:{role:"user",content:.}}' >&3
}

wait_result() { # $1 = which result line (1-based); prints it, or "" on death/timeout
  local want=$1 waited=0 have
  while true; do
    have=$(grep -c '"type":"result"' "$raw" || true)
    if [ "$have" -ge "$want" ]; then
      grep '"type":"result"' "$raw" | sed -n "${want}p"
      return 0
    fi
    if ! kill -0 "$cpid" 2>/dev/null; then echo ""; return 0; fi
    if [ "$waited" -ge "$TURN_TIMEOUT" ]; then echo ""; return 0; fi
    sleep 2; waited=$((waited + 2))
  done
}

ctx_of() {
  jq -r '(.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0)' <<<"$1"
}

results=0
prev_ctx=0
verdict="cap_reached"

send_turn "Session-fill probe. Reply with exactly: ok"
results=$((results + 1))
line="$(wait_result "$results")"
if [ -z "$line" ]; then
  echo "probe: no result for turn 1 (claude died or timed out); stderr tail:"
  tail -5 "$err" || true
  exit 1
fi
prev_ctx=$(ctx_of "$line")
echo "turn $results: ctx=$prev_ctx subtype=$(jq -r .subtype <<<"$line")"

i=0
while [ "$i" -lt "$MAX_PAD_TURNS" ]; do
  i=$((i + 1))
  send_turn "PAD $i. Ignore the filler text after the colon entirely; reply with exactly: ok. Filler: $pad"
  results=$((results + 1))
  line="$(wait_result "$results")"
  if [ -z "$line" ]; then
    if kill -0 "$cpid" 2>/dev/null; then verdict="timeout_turn_${results}"; else verdict="process_died_turn_${results}"; fi
    break
  fi
  ctx=$(ctx_of "$line")
  sub=$(jq -r '.subtype' <<<"$line")
  iserr=$(jq -r '.is_error' <<<"$line")
  echo "turn $results: ctx=$ctx subtype=$sub is_error=$iserr"
  if [ "$iserr" = "true" ] || [[ "$sub" == error_* ]]; then
    verdict="error_result_after_ctx_${prev_ctx}"
    break
  fi
  if [ "$prev_ctx" -gt 50000 ] && [ "$ctx" -lt $((prev_ctx * 6 / 10)) ]; then
    verdict="compaction_detected_at_ctx_${prev_ctx}"
    break
  fi
  prev_ctx=$ctx
done

# Post-event state check: does the session still answer?
if kill -0 "$cpid" 2>/dev/null; then
  send_turn "STATE CHECK. Reply with exactly: ok"
  results=$((results + 1))
  post="$(wait_result "$results")"
  if [ -n "$post" ]; then
    echo "post-check: ctx=$(ctx_of "$post") subtype=$(jq -r .subtype <<<"$post") is_error=$(jq -r .is_error <<<"$post")"
  else
    echo "post-check: no response"
  fi
fi

exec 3>&-
wait "$cpid" 2>/dev/null || true

echo ""
echo "=== verdict: $verdict ==="
echo "=== per-result usage: subtype is_error input cache_create cache_read ctx_total ==="
grep '"type":"result"' "$raw" | jq -r '[.subtype, (.is_error|tostring), (.usage.input_tokens // 0), (.usage.cache_creation_input_tokens // 0), (.usage.cache_read_input_tokens // 0), ((.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0))] | @tsv' | nl
echo "=== stream line types seen ==="
jq -r '.type + (if .subtype then ":" + .subtype else "" end)' "$raw" 2>/dev/null | sort | uniq -c | sort -rn
echo "=== stderr tail ==="
tail -5 "$err" || true
echo "probe: done. raw=$raw stderr=$err"
