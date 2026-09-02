/**
 * context-rotation crash distillation: turn a dead session's events.jsonl tail into a
 * crash-handover via a one-shot, minimal-mode `claude -p` call. Isolation is achieved
 * by loading no settings sources (`--setting-sources ""` — no hooks, no approver),
 * disabling all built-in tools (`--tools ""` — the distiller only summarizes; it never
 * needs to act), and running from a neutral cwd (no project CLAUDE.md auto-discovery)
 * — cheap, deterministic, and structurally incapable of recursing into claw-drive's
 * own approver hook or calling any tool at all (not merely ungated — absent).
 *
 * `--bare` was rejected for this call: per `claude --help`, `--bare`'s auth is
 * strictly `ANTHROPIC_API_KEY` or an `apiKeyHelper` — OAuth and keychain are never
 * read — so it cannot authenticate at all under subscription auth (empirically
 * confirmed 2026-07-30 on claude 2.1.220: `claude -p --bare ...` fails "Not logged
 * in" even from a fully-authenticated normal session with no `ANTHROPIC_API_KEY`
 * set). `--setting-sources ""` gives the same hook/plugin/CLAUDE.md isolation
 * without that auth restriction.
 *
 * Everything here is best-effort: runDistiller never throws, it returns null.
 */
import { spawn } from "node:child_process";
import type { Event } from "./events.js";
import { extractHandover } from "./handover.js";

const head = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");

/** A successful distillation: the extracted handover body plus the one-shot
 * call's own CLI-reported cost (null when the envelope carried none). */
export interface DistillResult {
  text: string;
  costUsd: number | null;
}

/**
 * Parse `claude -p --output-format json` stdout. Returns null on non-JSON
 * stdout (with json output requested, anything else means the call is
 * broken — no plain-text fallback), on a non-object envelope, or when the
 * envelope's result carries no <handover> block.
 */
export function parseDistillerEnvelope(raw: string): DistillResult | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Record<string, unknown>;
  const text = extractHandover(typeof env.result === "string" ? env.result : "");
  if (!text) return null;
  const cost = env.total_cost_usd;
  return { text, costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null };
}

/** The event kinds buildCrashDigest renders — every kind with a non-null
 * branch in its switch. The runner's checkpoint quiet guard consumes
 * membership as "this event would add digest material". */
export const DIGESTIBLE_KINDS: ReadonlySet<string> = new Set([
  "turn_started",
  "assistant_text",
  "tool_call_requested",
  "tool_call_result",
  "turn_completed",
  "turn_failed",
]);

/**
 * Tail-biased digest: walk events newest→oldest accumulating rendered lines
 * until maxChars, then emit oldest→newest. B's thinking is scrubbed from the
 * stream (empty), so it is skipped entirely.
 */
export function buildCrashDigest(events: Event[], maxChars = 50_000): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Event & Record<string, unknown>;
    let line: string | null = null;
    switch (e.kind) {
      case "turn_started":
        line = `> USER: ${head(String(e.message ?? ""), 400)}`;
        break;
      case "assistant_text":
        line = `ASSISTANT: ${head(String(e.text ?? ""), 1200)}`;
        break;
      case "tool_call_requested":
        line = `TOOL ${String(e.tool)}: ${head(JSON.stringify(e.args ?? {}), 300)}`;
        break;
      case "tool_call_result": {
        const body = typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? null);
        line = `RESULT${e.is_error ? " (ERROR)" : ""}: ${head(body, 300)}`;
        break;
      }
      case "turn_completed":
        line = `-- turn ${String(e.turn_id)} completed --`;
        break;
      case "turn_failed":
        line = `-- turn ${String(e.turn_id)} FAILED: ${head(String(e.error ?? ""), 200)} --`;
        break;
      default:
        line = null; // thinking (scrubbed anyway), decisions, lifecycle: skip
    }
    if (line === null) continue;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join("\n");
}

export function buildDistillerPrompt(input: {
  digest: string;
  originalBrief: string;
  /** "crash" (default): the session died after the digest's last line.
   * "checkpoint": periodic snapshot of a LIVE session — the framing must not
   * lie to the successor about staleness. Only the framing sentences differ;
   * the section skeleton and markers are shared. */
  mode?: "crash" | "checkpoint";
}): string {
  const checkpoint = input.mode === "checkpoint";
  const opening = checkpoint
    ? "You are writing a periodic checkpoint handover for a Claude Code session that is still running. Below are (1) the task's original mission brief and (2) a chronological digest of the session's event log as of this snapshot. The session has NOT ended: work may have continued after the last line, and this document will only be read if the session later dies without a fresher record — so where the record ends mid-action, say so; the successor will verify. From ONLY this record, write the best possible handover for a successor session that would continue the task."
    : "You are reconstructing a handover for a Claude Code session that crashed mid-task. Below are (1) the task's original mission brief and (2) a chronological digest of the session's event log up to the moment it died. From ONLY this record, write the best possible handover for a successor session that will continue the task.";
  const digestHeader = checkpoint
    ? "=== EVENT DIGEST (chronological; snapshot of a live session — work may have continued after the last line) ==="
    : "=== EVENT DIGEST (chronological; the session crashed after the last line) ===";
  return `${opening}

Respond with ONLY the handover document, wrapped exactly in <handover> and </handover> markers. Do not restate the original mission (it is delivered to the successor verbatim separately). Be complete but compact: target under ~2,500 tokens. Where the record is ambiguous, say so explicitly rather than guessing — the successor will verify.

Sections, in order (use these exact markdown headings):
## Current objective
## Progress ledger
## Decisions made
## Dead ends and discovered constraints
## Workspace state (believed)
## Verify on arrival
## Next steps
## Pending human threads

=== ORIGINAL MISSION ===
${input.originalBrief}
=== END ORIGINAL MISSION ===

${digestHeader}
${input.digest}
=== END EVENT DIGEST ===`;
}

/**
 * One-shot distiller. Returns the extracted <handover> body plus the call's
 * reported cost, or null on any failure/timeout. Runs `claude -p
 * --output-format json` (prompt on stdin), not stream-json.
 */
export function runDistiller(opts: {
  model: string | null;
  prompt: string;
  timeoutMs?: number;
  /**
   * Working directory for the one-shot claude process. Callers should pass a
   * neutral directory — one with no CLAUDE.md / .claude/ of its own — since
   * `--setting-sources ""` already suppresses settings-file hooks/plugins but
   * project-memory (CLAUDE.md) discovery is driven by cwd. A dead session's
   * own session dir is a good choice: it always exists and holds neither.
   * Absent: inherits the caller's own cwd.
   */
  cwd?: string;
}): Promise<DistillResult | null> {
  return new Promise((resolve) => {
    // needs no tools; disabling them removes the ungated surface and their schema cost
    const args = ["-p", "--no-session-persistence", "--output-format", "json", "--setting-sources", "", "--tools", ""];
    if (opts.model) args.push("--model", opts.model);
    let child;
    try {
      child = spawn("claude", args, { stdio: ["pipe", "pipe", "ignore"], cwd: opts.cwd });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (v: DistillResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(v);
    };
    const killer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* */ }
      finish(null);
    }, opts.timeoutMs ?? 180_000);
    child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf-8")));
    child.stdout!.on("error", () => finish(null));
    child.stdin!.on("error", () => finish(null));
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseDistillerEnvelope(out)));
    child.stdin!.write(opts.prompt);
    child.stdin!.end();
  });
}
