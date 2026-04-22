#!/usr/bin/env bash
# Probes the claude CLI to confirm the shape of its headless streaming I/O.
# Run manually: bash scripts/probe-claude-cli.sh
# Requires: `claude` on PATH.

set -euo pipefail

CLAUDE="${CLAUDE:-claude}"
out_dir="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/stream-json"
docs_dir="$(cd "$(dirname "$0")/.." && pwd)/docs"
mkdir -p "$out_dir" "$docs_dir"

echo "=== Probe 1: simple one-turn, no tools ==="
echo '{"type":"user","message":{"role":"user","content":"Say hello in 3 words only."}}' \
  | "$CLAUDE" -p \
      --output-format=stream-json \
      --input-format=stream-json \
      --permission-mode=bypassPermissions \
      --max-turns=1 \
      --verbose \
  | tee "$out_dir/simple-turn.jsonl"

echo ""
echo "=== Probe 2: a turn that triggers a tool call (Bash) ==="
tmp_dir="$(mktemp -d)"
cd "$tmp_dir"
echo '{"type":"user","message":{"role":"user","content":"Run `echo hi from probe` with the Bash tool, no other tools."}}' \
  | "$CLAUDE" -p \
      --output-format=stream-json \
      --input-format=stream-json \
      --permission-mode=bypassPermissions \
      --max-turns=2 \
      --verbose \
  | tee "$out_dir/tool-call-turn.jsonl"
cd - >/dev/null
rm -rf "$tmp_dir"

echo ""
echo "=== Probe 3: claude --help (capture flag surface) ==="
"$CLAUDE" --help 2>&1 | head -200 > "$docs_dir/claude-help-output.txt" || true

echo ""
echo "=== Probe 4: what does --permission-prompt-tool expect? ==="
"$CLAUDE" -p --help 2>&1 | grep -A2 -i "permission" > "$docs_dir/claude-permission-help.txt" || true

echo ""
echo "Done. Review files in tests/fixtures/stream-json/ and docs/"
