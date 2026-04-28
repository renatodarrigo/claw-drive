import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "../../src/runner/runner-args.js";
import { WRAPPER_PROMPT } from "../../src/lib/tokens.js";

const BASE = {
  mcpConfigPath: "/tmp/x/mcp.json",
  settingsPath: "/tmp/x/settings.json",
  model: null as string | null,
  wrapper: undefined as boolean | undefined,
};

describe("buildClaudeArgs", () => {
  it("includes core flags in the right order", () => {
    const argv = buildClaudeArgs(BASE);
    expect(argv[0]).toBe("-p");
    expect(argv).toContain("--output-format=stream-json");
    expect(argv).toContain("--input-format=stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/tmp/x/mcp.json");
    expect(argv).toContain("--settings");
    expect(argv).toContain("/tmp/x/settings.json");
  });

  it("appends --append-system-prompt + WRAPPER_PROMPT by default (wrapper undefined)", () => {
    const argv = buildClaudeArgs(BASE);
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe(WRAPPER_PROMPT);
  });

  it("appends --append-system-prompt when wrapper === true", () => {
    const argv = buildClaudeArgs({ ...BASE, wrapper: true });
    expect(argv).toContain("--append-system-prompt");
  });

  it("does NOT append --append-system-prompt when wrapper === false", () => {
    const argv = buildClaudeArgs({ ...BASE, wrapper: false });
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv).not.toContain(WRAPPER_PROMPT);
  });

  it("includes --model when model is set", () => {
    const argv = buildClaudeArgs({ ...BASE, model: "claude-sonnet-4-6" });
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("claude-sonnet-4-6");
  });

  it("omits --model when model is null", () => {
    const argv = buildClaudeArgs(BASE);
    expect(argv).not.toContain("--model");
  });
});
