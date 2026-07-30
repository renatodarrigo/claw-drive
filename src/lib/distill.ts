/**
 * context-rotation crash distillation: turn a dead session's events.jsonl tail into a
 * crash-handover via a one-shot `claude -p --bare` call. --bare skips hooks,
 * plugins and CLAUDE.md — cheap, deterministic, and structurally incapable of
 * recursing into claw-drive's own approver hook. Everything here is
 * best-effort: runDistiller never throws, it returns null.
 */
import { spawn } from "node:child_process";
import type { Event } from "./events.js";
import { extractHandover } from "./handover.js";

const head = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");

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

export function buildDistillerPrompt(input: { digest: string; originalBrief: string }): string {
  return `You are reconstructing a handover for a Claude Code session that crashed mid-task. Below are (1) the task's original mission brief and (2) a chronological digest of the session's event log up to the moment it died. From ONLY this record, write the best possible handover for a successor session that will continue the task.

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

=== EVENT DIGEST (chronological; the session crashed after the last line) ===
${input.digest}
=== END EVENT DIGEST ===`;
}

/**
 * One-shot distiller. Plain-text -p output (no stream-json), prompt on stdin.
 * Returns the extracted <handover> body, or null on any failure/timeout.
 */
export function runDistiller(opts: {
  model: string | null;
  prompt: string;
  timeoutMs?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["-p", "--bare", "--no-session-persistence"];
    if (opts.model) args.push("--model", opts.model);
    let child;
    try {
      child = spawn("claude", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (v: string | null) => {
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
    child.on("close", () => finish(extractHandover(out)));
    child.stdin!.write(opts.prompt);
    child.stdin!.end();
  });
}
