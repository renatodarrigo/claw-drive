import { describe, it, expect } from "vitest";
import { parseClaudeLine, type ParserOutput } from "../../src/runner/stream-parser.js";

describe("stream-parser", () => {
  it("ignores system init line but returns claude_session_id", () => {
    const out = parseClaudeLine(
      { type: "system", subtype: "init", session_id: "abc" },
      "turn_1"
    );
    expect(out.events).toEqual([]);
    expect(out.claude_session_id).toBe("abc");
  });

  it("extracts assistant text block as one assistant_text event", () => {
    const out = parseClaudeLine(
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
      },
      "turn_1"
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      kind: "assistant_text",
      turn_id: "turn_1",
      text: "hello world",
    });
  });

  it("extracts tool_use block as tool_call_requested event", () => {
    const out = parseClaudeLine(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } },
          ],
        },
      },
      "turn_1"
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      kind: "tool_call_requested",
      turn_id: "turn_1",
      call_id: "toolu_1",
      tool: "Bash",
      args: { command: "echo hi" },
    });
  });

  it("extracts tool_result (on user message) as tool_call_result", () => {
    const out = parseClaudeLine(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "hi\n", is_error: false },
          ],
        },
      },
      "turn_1"
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      kind: "tool_call_result",
      turn_id: "turn_1",
      call_id: "toolu_1",
      is_error: false,
    });
  });

  it("result event maps to turn_completed", () => {
    const out = parseClaudeLine(
      { type: "result", subtype: "success", session_id: "abc", num_turns: 1, duration_ms: 10 },
      "turn_1"
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ kind: "turn_completed", turn_id: "turn_1" });
  });

  it("result with error subtype maps to turn_failed", () => {
    const out = parseClaudeLine(
      { type: "result", subtype: "error_max_turns", is_error: true, session_id: "abc" },
      "turn_1"
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ kind: "turn_failed", turn_id: "turn_1" });
  });

  it("multiple content blocks in one assistant message become multiple events", () => {
    const out = parseClaudeLine(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "reading..." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } },
          ],
        },
      },
      "turn_1"
    );
    expect(out.events).toHaveLength(2);
    expect(out.events[0].kind).toBe("assistant_text");
    expect(out.events[1].kind).toBe("tool_call_requested");
  });

  it("unknown top-level types produce zero events", () => {
    expect(parseClaudeLine({ type: "__unknown__" }, "turn_1").events).toEqual([]);
  });

  it("rate_limit_event produces zero events (probe 2 finding)", () => {
    const out = parseClaudeLine(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1776826800 },
      },
      "turn_1"
    );
    expect(out.events).toEqual([]);
  });

  it("system/hook_started and hook_response produce zero events", () => {
    expect(
      parseClaudeLine({ type: "system", subtype: "hook_started", hook_id: "x" }, "turn_1").events
    ).toEqual([]);
    expect(
      parseClaudeLine({ type: "system", subtype: "hook_response", body: {} }, "turn_1").events
    ).toEqual([]);
  });

  it("thinking content block produces thinking event", () => {
    const out = parseClaudeLine(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "some reasoning", signature: "xyz" }],
        },
      },
      "turn_1"
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      kind: "thinking",
      turn_id: "turn_1",
      text: "some reasoning",
    });
  });

  it("null / non-object input produces zero events without throwing", () => {
    expect(parseClaudeLine(null, "turn_1").events).toEqual([]);
    expect(parseClaudeLine(42, "turn_1").events).toEqual([]);
    expect(parseClaudeLine("string", "turn_1").events).toEqual([]);
  });
});
