import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildCrashDigest, buildDistillerPrompt, runDistiller, parseDistillerEnvelope } from "../../src/lib/distill.js";
import type { Event } from "../../src/lib/events.js";

const ev = (partial: Record<string, unknown>, seq: number): Event =>
  ({ seq, at: `2026-07-29T00:00:${String(seq).padStart(2, "0")}.000Z`, ...partial }) as Event;

describe("buildCrashDigest", () => {
  const events: Event[] = [
    ev({ kind: "turn_started", turn_id: "turn_1", message: "do the thing" }, 1),
    ev({ kind: "assistant_text", turn_id: "turn_1", text: "working on it" }, 2),
    ev({ kind: "tool_call_requested", turn_id: "turn_1", call_id: "c1", tool: "Bash", args: { command: "ls" } }, 3),
    ev({ kind: "tool_call_result", turn_id: "turn_1", call_id: "c1", result: "file.txt", is_error: false }, 4),
    ev({ kind: "turn_completed", turn_id: "turn_1", stop_reason: "success" }, 5),
  ];

  it("renders the load-bearing kinds chronologically", () => {
    const d = buildCrashDigest(events);
    expect(d.indexOf("USER: do the thing")).toBeGreaterThanOrEqual(0);
    expect(d.indexOf("USER: do the thing")).toBeLessThan(d.indexOf("ASSISTANT: working on it"));
    expect(d).toContain("TOOL Bash:");
    expect(d).toContain("RESULT: file.txt");
    expect(d).toContain("turn turn_1 completed");
  });

  it("skips thinking events and marks tool errors", () => {
    const d = buildCrashDigest([
      ev({ kind: "thinking", turn_id: "turn_1", text: "private" }, 1),
      ev({ kind: "tool_call_result", turn_id: "turn_1", call_id: "c", result: "boom", is_error: true }, 2),
    ]);
    expect(d).not.toContain("private");
    expect(d).toContain("RESULT (ERROR): boom");
  });

  it("keeps the TAIL under a char cap (oldest lines dropped first)", () => {
    const many: Event[] = [];
    for (let i = 1; i <= 500; i++) {
      many.push(ev({ kind: "assistant_text", turn_id: "turn_1", text: `line-${i} ${"x".repeat(200)}` }, i));
    }
    const d = buildCrashDigest(many, 10_000);
    expect(d.length).toBeLessThanOrEqual(10_000);
    expect(d).toContain("line-500");
    expect(d).not.toContain("line-1 ");
    expect(d.indexOf("line-499")).toBeLessThan(d.indexOf("line-500"));
  });
});

describe("buildDistillerPrompt", () => {
  it("carries the brief, the digest, the section headings, and the marker mandate", () => {
    const p = buildDistillerPrompt({ digest: "THE-DIGEST", originalBrief: "THE-BRIEF" });
    expect(p).toContain("THE-DIGEST");
    expect(p).toContain("THE-BRIEF");
    expect(p).toContain("<handover>");
    expect(p).toContain("## Verify on arrival");
    expect(p).toContain("crashed");
  });
});

// Shared by "runDistiller stream-error hardening" and "runDistiller JSON
// envelope" below: both spawn a fake `claude` binary via installClaudeStub.
let savedPath: string | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  savedPath = undefined;
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** Prepend a fake executable `claude` (the given shell script) onto PATH for this test. */
async function installClaudeStub(script: string): Promise<void> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cd11-distill-stub-"));
  const stubPath = path.join(tmpDir, "claude");
  await fs.writeFile(stubPath, script, { mode: 0o755 });
  await fs.chmod(stubPath, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${savedPath ?? ""}`;
}

describe("runDistiller stream-error hardening", () => {
  it("resolves null (not an uncaught EPIPE) when the child exits without reading stdin", async () => {
    // Pre-fix, writing a large prompt to a stdin whose reader already exited
    // (old CLI rejecting --bare, auth failure, wrapper shim, ...) threw an
    // unhandled stream "error" and crashed the whole runner process.
    await installClaudeStub("#!/bin/sh\nexit 0\n");
    const result = await runDistiller({ model: null, prompt: "x".repeat(60_000) });
    expect(result).toBeNull();
  });

  it("resolves null on timeout when the child never exits", async () => {
    await installClaudeStub("#!/bin/sh\nsleep 5\n");
    const result = await runDistiller({ model: null, prompt: "hi", timeoutMs: 100 });
    expect(result).toBeNull();
  });
});

describe("parseDistillerEnvelope", () => {
  const envelope = (result: string, cost?: number) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...(cost !== undefined ? { total_cost_usd: cost } : {}) });

  it("extracts handover text and cost from a well-formed envelope", () => {
    const out = parseDistillerEnvelope(envelope("pre <handover>THE BODY</handover> post", 0.42));
    expect(out).toEqual({ text: "THE BODY", costUsd: 0.42 });
  });

  it("returns costUsd null when the envelope carries no finite total_cost_usd", () => {
    expect(parseDistillerEnvelope(envelope("<handover>H</handover>"))?.costUsd).toBeNull();
    expect(parseDistillerEnvelope(JSON.stringify({ result: "<handover>H</handover>", total_cost_usd: "NaNish" }))?.costUsd).toBeNull();
  });

  it("returns null on non-JSON stdout (with --output-format json that means the call is broken)", () => {
    expect(parseDistillerEnvelope("<handover>plain text, not an envelope</handover>")).toBeNull();
  });

  it("returns null when the envelope's result has no handover block", () => {
    expect(parseDistillerEnvelope(envelope("no markers here", 0.1))).toBeNull();
  });

  it("returns null on a non-object envelope", () => {
    expect(parseDistillerEnvelope("42")).toBeNull();
  });
});

describe("runDistiller JSON envelope", () => {
  it("resolves {text, costUsd} from a stub emitting a result envelope", async () => {
    await installClaudeStub(
      "#!/bin/sh\ncat > /dev/null\nprintf '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.07,\"result\":\"<handover>STUBBED</handover>\"}'\n"
    );
    const result = await runDistiller({ model: null, prompt: "hi" });
    expect(result).toEqual({ text: "STUBBED", costUsd: 0.07 });
  });
});
