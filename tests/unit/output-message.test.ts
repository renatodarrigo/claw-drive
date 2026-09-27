import { describe, it, expect } from "vitest";
import { composeOutputMessage } from "../../src/runner/output-message.js";

// The text B reads when a human ran a deferred call for it. Shared by both
// delivery paths of provide_tool_output (through the paused hook, or as a
// new turn), so the wording is pinned once here.
describe("composeOutputMessage", () => {
  it("renders every field in the order B has always read them", () => {
    const text = composeOutputMessage({
      tool: "Bash",
      call_id: "toolu_9",
      args: { command: "sudo apt update" },
      exit_code: 0,
      stdout: "Hit:1 http://archive",
      stderr: "",
      extra: "ran on the host",
    });
    expect(text).toBe(
      "[claw-drive] The deferred `Bash` call (call_id: toolu_9) was executed by the human.\n\n" +
        'Original args: {"command":"sudo apt update"}\n\n' +
        "Exit code: 0\n\n" +
        "Stdout:\nHit:1 http://archive\n\n" +
        "Stderr:\n(empty)\n\n" +
        "Notes: ran on the host\n\n" +
        "Please continue from where you left off, using this as the tool's output."
    );
  });

  it("marks a missing exit code and empty streams explicitly", () => {
    const text = composeOutputMessage({
      tool: "Bash", call_id: "toolu_1", args: {}, exit_code: null, stdout: "", stderr: "", extra: "",
    });
    expect(text).toContain("Exit code: (not provided)");
    expect(text).toContain("Stdout:\n(empty)");
    expect(text).toContain("Stderr:\n(empty)");
    expect(text).toContain("Notes: (none)");
  });
});
