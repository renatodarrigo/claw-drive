import { describe, it, expect } from "vitest";
import { parseSendArgs } from "../../src/cli/commands/send.js";

const EMPTY: NodeJS.ProcessEnv = {};

describe("parseSendArgs — single-session form (unchanged behavior)", () => {
  it("parses <ref> <message>", () => {
    expect(parseSendArgs(["reviewer", "do the thing"], EMPTY)).toEqual({
      ok: true, all: false, ref: "reviewer", message: "do the thing",
    });
  });

  it("a message that is not one of the reserved flags still passes as-is", () => {
    expect(parseSendArgs(["reviewer", "--verbose please"], EMPTY)).toEqual({
      ok: true, all: false, ref: "reviewer", message: "--verbose please",
    });
  });

  it("a bare -- ends flag parsing so a reserved word can be the message", () => {
    expect(parseSendArgs(["reviewer", "--", "--all"], EMPTY)).toEqual({
      ok: true, all: false, ref: "reviewer", message: "--all",
    });
  });

  it("missing ref or message, or an empty message, is a usage error", () => {
    expect(parseSendArgs([], EMPTY).ok).toBe(false);
    expect(parseSendArgs(["reviewer"], EMPTY).ok).toBe(false);
    expect(parseSendArgs(["reviewer", ""], EMPTY).ok).toBe(false);
  });

  it("rejects the fleet flags on the single-session form", () => {
    expect(parseSendArgs(["reviewer", "hi", "--all-fleets"], EMPTY)).toEqual({
      ok: false, error: "--fleet/--all-fleets apply only to the fleet view",
    });
  });
});

describe("parseSendArgs — --all", () => {
  it("parses --all <message> with the view from the env", () => {
    expect(parseSendArgs(["--all", "wrap up"], { CLAUDE_CODE_SESSION_ID: "abc" })).toEqual({
      ok: true, all: true, message: "wrap up", view: { acting: "abc", allFleets: false },
    });
  });

  it("takes --fleet / --all-fleets in any position", () => {
    expect(parseSendArgs(["--fleet", "team-b", "--all", "go"], EMPTY)).toEqual({
      ok: true, all: true, message: "go", view: { acting: "team-b", allFleets: false },
    });
    expect(parseSendArgs(["--all", "go", "--all-fleets"], EMPTY)).toEqual({
      ok: true, all: true, message: "go", view: { acting: undefined, allFleets: true },
    });
  });

  it("--all with a session positional, no message, an empty message, or an extra positional is a usage error", () => {
    expect(parseSendArgs(["--all", "reviewer", "go"], EMPTY).ok).toBe(false);
    expect(parseSendArgs(["--all"], EMPTY).ok).toBe(false);
    expect(parseSendArgs(["--all", ""], EMPTY).ok).toBe(false);
    const r = parseSendArgs(["--all", "reviewer", "go"], EMPTY);
    if (!r.ok) expect(r.error).toContain("usage: claw-drive send");
  });

  it("surfaces the shared fleet-flag errors", () => {
    expect(parseSendArgs(["--all", "go", "--fleet", "a", "--all-fleets"], EMPTY)).toEqual({
      ok: false, error: "--fleet and --all-fleets are mutually exclusive",
    });
    expect(parseSendArgs(["--all", "go", "--fleet"], EMPTY)).toEqual({ ok: false, error: "--fleet requires a tag" });
  });
});
