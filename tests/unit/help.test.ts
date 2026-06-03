import { describe, it, expect } from "vitest";
import { renderHelp } from "../../src/cli/help-text.js";
import { COMMANDS } from "../../src/cli/registry.js";
import { MCP_TOOL_DEFS } from "../../src/mcp/tool-defs.js";

describe("renderHelp — capability map", () => {
  const help = renderHelp();

  it("renders every CLI command (name + summary + usage)", () => {
    for (const c of COMMANDS) {
      expect(help).toContain(c.name);
      expect(help).toContain(c.summary);
      expect(help).toContain(`usage: ${c.usage}`);
    }
  });

  it("renders every MCP tool (name + description)", () => {
    for (const t of MCP_TOOL_DEFS) {
      expect(help).toContain(t.name);
      expect(help).toContain(t.description);
    }
  });

  it("contains each concept section header", () => {
    // Must match the section headers in help-text.ts (CONCEPTS/POINTERS prose +
    // the renderCommands/renderTools headers) verbatim.
    const headers = [
      "WHAT CLAW-DRIVE IS",
      "MENTAL MODEL",
      "THE DRIVING LOOP",
      "POLICY & SAFETY",
      "FLEET",
      "CLI COMMANDS",
      "MCP TOOLS",
      "LEARN MORE",
    ];
    for (const h of headers) expect(help).toContain(h);
  });

  it("pins exactly the frozen 10-tool set (drift tripwire)", () => {
    expect(new Set(MCP_TOOL_DEFS.map((t) => t.name))).toEqual(
      new Set([
        "start_session", "stop_session", "send_turn", "poll_turn", "poll_session",
        "list_sessions", "resolve_tool_call", "provide_tool_output", "update_policy",
        "interrupt_turn",
      ])
    );
  });
});
