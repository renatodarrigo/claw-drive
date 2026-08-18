import { describe, it, expect } from "vitest";
import { MCP_TOOL_DEFS } from "../../src/mcp/tool-defs.js";

describe("resolve_tool_call tool-def", () => {
  const def = MCP_TOOL_DEFS.find((t) => t.name === "resolve_tool_call")!;
  const schema = def.inputSchema as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };

  it("still exists with the frozen action enum (approve|reject only)", () => {
    expect(def).toBeDefined();
    expect(schema.properties.action.enum).toEqual(["approve", "reject"]);
  });

  it("exposes the new optional preview_only + remembered_rule inputs", () => {
    expect(schema.properties.preview_only).toEqual({ type: "boolean" });
    expect(schema.properties.remembered_rule).toEqual({ type: "object" });
  });

  it("does not require the new inputs", () => {
    expect(schema.required).toEqual(["call_id", "action", "reason"]);
  });
});
