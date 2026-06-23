import { describe, it, expect } from "vitest";
import { parseResolveArgs, renderPreviewHuman } from "../../src/cli/commands/_shared-resolve.js";

describe("parseResolveArgs", () => {
  it("requires a call_id", () => {
    expect(parseResolveArgs("approve", []).ok).toBe(false);
  });

  it("parses a bare call_id with defaults", () => {
    const r = parseResolveArgs("approve", ["c1"]);
    expect(r).toEqual({
      ok: true, callId: "c1", reason: "approved via CLI",
      preview: false, json: false, remember: false, rememberedRule: null,
    });
  });

  it("parses --preview and --json", () => {
    const r = parseResolveArgs("reject", ["c1", "--preview", "--json"]);
    expect(r.ok && r.preview && r.json).toBe(true);
  });

  it("parses --remember-as into a validated Rule", () => {
    const r = parseResolveArgs("approve", ["c1", "--remember-as", '{"tool":"Bash","bash_command_matches":"^git push "}']);
    expect(r.ok && r.rememberedRule).toEqual({ tool: "Bash", bash_command_matches: "^git push " });
  });

  it("rejects malformed --remember-as JSON (exit-2 path)", () => {
    expect(parseResolveArgs("approve", ["c1", "--remember-as", "{bad"]).ok).toBe(false);
  });

  it("rejects an invalid --remember-as rule", () => {
    expect(parseResolveArgs("approve", ["c1", "--remember-as", '{"tool":""}']).ok).toBe(false);
  });

  it("rejects --remember together with --remember-as", () => {
    const r = parseResolveArgs("approve", ["c1", "--remember", "--remember-as", '{"tool":"Bash"}']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/one of --remember or --remember-as/);
  });

  it("rejects an unknown flag", () => {
    expect(parseResolveArgs("approve", ["c1", "--nope"]).ok).toBe(false);
  });

  it("rejects a first arg that is a flag, not a call_id", () => {
    expect(parseResolveArgs("approve", ["--nope"]).ok).toBe(false);
  });

  it("parses --remember alone", () => {
    const r = parseResolveArgs("approve", ["c1", "--remember"]);
    expect(r).toEqual({
      ok: true, callId: "c1", reason: "approved via CLI",
      preview: false, json: false, remember: true, rememberedRule: null,
    });
  });
});

describe("renderPreviewHuman", () => {
  it("renders a Bash rule with source marker", () => {
    const out = renderPreviewHuman({
      would_remember: { tool: "Bash", bash_command_matches: "^git " }, list: "auto_approve", source: "derived",
    });
    expect(out).toContain("would remember → auto_approve   [derived]");
    expect(out).toContain("Bash where command matches  ^git ");
  });

  it("renders an arg_matches rule and a bypass note", () => {
    const out = renderPreviewHuman({
      would_remember: { tool: "Read", arg_matches: { file_path: "^/etc/passwd$" } },
      list: "auto_reject", source: "provided", bypass: true,
    });
    expect(out).toContain("Read where file_path matches ^/etc/passwd$");
    expect(out).toContain('policy is "bypass"');
  });

  it("renders a tool-wide fallback rule", () => {
    const out = renderPreviewHuman({
      would_remember: { tool: "Edit" }, list: "auto_approve", source: "derived",
    });
    expect(out).toContain("Edit (tool-wide)");
  });
});
