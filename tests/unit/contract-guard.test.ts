/**
 * CD-13 — Contract-guard test (part of the CD-1 1.0 contract freeze).
 *
 * Mechanically pins the frozen public surfaces enumerated in COMPATIBILITY.md so
 * that removing or renaming any pinned MCP tool, event kind, CLI subcommand/flag,
 * or sentinel token fails CI — and ADDING one fails until the expected set here is
 * updated in the same commit (additive-with-intent).
 *
 * Where a surface is exported as a runtime value (VOCAB, VALID_WATCH_KINDS,
 * MCP_TOOL_DEFS) we import and compare it directly. Where it is not a runtime value
 * (the full event-kind union lives in events.ts as a type, CLI subcommands are a
 * dispatch switch in cli.ts) we parse the source file and assert
 * the extracted set equals the expected set. Source parsing is deliberately strict:
 * a rename changes the extracted string; a removal drops it; an addition adds an
 * unexpected member — all three diverge from the frozen set below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VOCAB } from "../../src/lib/tokens.js";
import { VALID_WATCH_KINDS } from "../../src/cli/commands/watch.js";
import { MCP_TOOL_DEFS } from "../../src/mcp/tool-defs.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf-8");

describe("CD-13 contract guard — MCP tools (src/mcp/tool-defs.ts)", () => {
  // The 10 frozen MCP tools (COMPATIBILITY.md §2).
  const EXPECTED_MCP_TOOLS = new Set([
    "start_session",
    "stop_session",
    "send_turn",
    "poll_turn",
    "poll_session",
    "list_sessions",
    "resolve_tool_call",
    "provide_tool_output",
    "update_policy",
    "interrupt_turn",
  ]);

  it("the server registers exactly the frozen tool set", () => {
    const found = new Set(MCP_TOOL_DEFS.map((t) => t.name));
    expect(found).toEqual(EXPECTED_MCP_TOOLS);
  });
});

describe("CD-13 contract guard — event kinds (src/lib/events.ts)", () => {
  // The 14 frozen event kinds written to events.jsonl (COMPATIBILITY.md §3).
  const EXPECTED_EVENT_KINDS = new Set([
    "session_started",
    "session_stopped",
    "turn_started",
    "turn_completed",
    "turn_failed",
    "assistant_text",
    "thinking",
    "tool_call_requested",
    "tool_decision_required",
    "tool_decision_resolved",
    "tool_call_started",
    "tool_call_result",
    "tool_output_provided",
    "error",
  ]);

  it("the EventKind union pins exactly the frozen kinds", () => {
    const src = read("src/lib/events.ts");
    // The union is the first block of `| "kind"` string-literal members at the
    // top of the file (the EventKind type). Take members before the first
    // `export` of the discriminated Event union's object forms by scanning the
    // leading `| "..."` lines.
    const kinds = new Set(
      [...src.matchAll(/^\s*\|\s*"([a-z_]+)"/gm)].map((m) => m[1])
    );
    expect(kinds).toEqual(EXPECTED_EVENT_KINDS);
  });
});

describe("CD-13 contract guard — watch-surfaced kinds (VALID_WATCH_KINDS)", () => {
  // The 9 watch-surfaced kinds (COMPATIBILITY.md §3). Runtime-exported Set.
  const EXPECTED_WATCH_KINDS = new Set([
    "tool_decision_required",
    "tool_decision_resolved",
    "tool_output_provided",
    "turn_completed",
    "turn_failed",
    "error",
    "session_stopped",
    "tool_call_result",
    "idle",
  ]);

  it("VALID_WATCH_KINDS equals the frozen watch set", () => {
    expect(new Set(VALID_WATCH_KINDS)).toEqual(EXPECTED_WATCH_KINDS);
  });
});

describe("CD-13 contract guard — CLI subcommands (src/cli/cli.ts)", () => {
  // The 17 frozen CLI subcommands (COMPATIBILITY.md §4).
  const EXPECTED_CLI_SUBCOMMANDS = new Set([
    "sessions",
    "show",
    "tail",
    "watch",
    "pending",
    "approve",
    "reject",
    "defer",
    "send",
    "start",
    "stop",
    "interrupt",
    "policy",
    "policy-test",
    "status",
    "prune",
    "provide-output",
  ]);

  it("the commands dispatch table holds exactly the frozen subcommands", () => {
    const src = read("src/cli/cli.ts");
    // Subcommands are the keys of the `const commands` record (each value is a
    // `cmd*` handler). Scope to that object literal and extract each key — bare
    // (`sessions:`) or quoted (`"policy-test":`) — that maps to a cmd* function.
    // A rename/removal/addition of a handler diverges from the frozen set.
    const start = src.indexOf("const commands");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("};", start);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    const found = new Set(
      [...region.matchAll(/["']?([a-z][a-z-]*)["']?\s*:\s*cmd[A-Z]/g)].map((m) => m[1])
    );
    expect(found).toEqual(EXPECTED_CLI_SUBCOMMANDS);
  });
});

describe("CD-13 contract guard — sentinel vocabulary (VOCAB)", () => {
  // The 2 frozen sentinel tokens (COMPATIBILITY.md §5). Runtime-exported Set.
  const EXPECTED_VOCAB = new Set(["NEEDS-INPUT", "DONE"]);

  it("VOCAB equals the frozen two-token set", () => {
    expect(new Set(VOCAB)).toEqual(EXPECTED_VOCAB);
  });
});
