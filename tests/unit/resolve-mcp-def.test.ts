import { describe, it, expect } from "vitest";
import { MCP_TOOL_DEFS } from "../../src/mcp/tool-defs.js";

describe("resolve_tool_call tool-def", () => {
  const def = MCP_TOOL_DEFS.find((t) => t.name === "resolve_tool_call")!;

  it("still exists with the frozen action enum (approve|reject only)", () => {
    expect(def).toBeDefined();
    expect((def.inputSchema.properties as any).action.enum).toEqual(["approve", "reject"]);
  });

  it("exposes the new optional preview_only + remembered_rule inputs", () => {
    const props = def.inputSchema.properties as Record<string, unknown>;
    expect(props.preview_only).toEqual({ type: "boolean" });
    expect(props.remembered_rule).toEqual({ type: "object" });
  });

  it("does not require the new inputs", () => {
    expect(def.inputSchema.required).toEqual(["call_id", "action", "reason"]);
  });
});
