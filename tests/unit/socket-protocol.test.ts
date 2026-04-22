import { describe, it, expect } from "vitest";
import {
  encodeMessage,
  decodeMessage,
  type ControlRequest,
  type ControlResponse,
} from "../../src/lib/socket-protocol.js";

describe("socket-protocol", () => {
  it("encodes/decodes send_turn round-trip", () => {
    const req: ControlRequest = { id: "r1", op: "send_turn", message: "hi there" };
    const wire = encodeMessage(req);
    expect(wire.endsWith("\n")).toBe(true);
    const decoded = decodeMessage(wire.trimEnd());
    expect(decoded).toEqual(req);
  });

  it("encodes/decodes approve_tool request (wraps raw PreToolUse payload)", () => {
    const req: ControlRequest = {
      id: "r2",
      op: "approve_tool",
      pretooluse: {
        session_id: "claude-session-123",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_use_id: "toolu_abc",
        cwd: "/tmp/x",
        permission_mode: "default",
      },
    };
    const decoded = decodeMessage(encodeMessage(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("encodes/decodes resolve_tool_call request", () => {
    const req: ControlRequest = {
      id: "r3",
      op: "resolve_tool_call",
      call_id: "toolu_abc",
      action: "approve",
      reason: "looks fine",
      remember_as_policy: true,
    };
    const decoded = decodeMessage(encodeMessage(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("encodes/decodes ok response", () => {
    const resp: ControlResponse = { id: "r1", ok: true, result: { turn_id: "turn_1" } };
    const decoded = decodeMessage(encodeMessage(resp).trimEnd());
    expect(decoded).toEqual(resp);
  });

  it("encodes/decodes error response", () => {
    const resp: ControlResponse = {
      id: "r1",
      ok: false,
      error: "SESSION_ORPHANED",
      message: "gone",
    };
    const decoded = decodeMessage(encodeMessage(resp).trimEnd());
    expect(decoded).toEqual(resp);
  });

  it("decodeMessage throws on invalid JSON", () => {
    expect(() => decodeMessage("not json")).toThrow();
  });

  it("decodeMessage throws on non-object top-level (e.g. array)", () => {
    expect(() => decodeMessage("[]")).toThrow();
    expect(() => decodeMessage("42")).toThrow();
    expect(() => decodeMessage("null")).toThrow();
  });

  it("encodes/decodes provide_tool_output request", () => {
    const req: ControlRequest = {
      id: "r4",
      op: "provide_tool_output",
      call_id: "toolu_abc",
      stdout: "Reading package lists... Done\n",
      stderr: "",
      exit_code: 0,
      extra: "human override: approved via chat",
    };
    const decoded = decodeMessage(encodeMessage(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("resolve_tool_call accepts 'defer' action", () => {
    const req: ControlRequest = {
      id: "r5",
      op: "resolve_tool_call",
      call_id: "toolu_def",
      action: "defer",
      reason: "human will run sudo",
    };
    const decoded = decodeMessage(encodeMessage(req).trimEnd());
    expect(decoded).toEqual(req);
  });
});
