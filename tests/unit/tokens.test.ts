import { describe, it, expect } from "vitest";
import {
  WRAPPER_PROMPT,
  VOCAB,
  DEFAULT_SURFACE_MODES,
  TRAILING_TOKEN_RE,
  extractTrailingToken,
  isDebugToken,
  resolveSurfaceMode,
} from "../../src/lib/tokens.js";

describe("WRAPPER_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof WRAPPER_PROMPT).toBe("string");
    expect(WRAPPER_PROMPT.length).toBeGreaterThan(100);
  });

  it("contains all 11 explicit tokens", () => {
    const explicit = [
      "[NEEDS-INPUT]",
      "[NEEDS-DECISION]",
      "[NEEDS-CONFIRMATION]",
      "[NEEDS-CLARIFICATION]",
      "[ERROR]",
      "[FAILED-NO-RETRY]",
      "[FAILED-WILL-RETRY]",
      "[PARTIAL-FAILURE]",
      "[INFO-FINISHED]",
      "[INFO-CHECKPOINT]",
      "[INFO-PROGRESS]",
      "[INFO-WAITING]",
    ];
    for (const t of explicit) {
      expect(WRAPPER_PROMPT).toContain(t);
    }
  });

  it("contains the format-rules section", () => {
    expect(WRAPPER_PROMPT).toMatch(/Format rules:/i);
    expect(WRAPPER_PROMPT).toMatch(/own line/i);
    expect(WRAPPER_PROMPT).toMatch(/literal bracketed text/i);
    expect(WRAPPER_PROMPT).toMatch(/Priority/i);
  });

  it("ends without leading/trailing whitespace clutter", () => {
    expect(WRAPPER_PROMPT.trim()).toBe(WRAPPER_PROMPT.trimEnd());
  });
});

describe("VOCAB", () => {
  it("contains exactly the 13 entries (12 explicit tokens + DEBUG-* wildcard)", () => {
    expect(VOCAB.size).toBe(13);
  });

  it("includes the four NEEDS-* tokens", () => {
    expect(VOCAB.has("NEEDS-INPUT")).toBe(true);
    expect(VOCAB.has("NEEDS-DECISION")).toBe(true);
    expect(VOCAB.has("NEEDS-CONFIRMATION")).toBe(true);
    expect(VOCAB.has("NEEDS-CLARIFICATION")).toBe(true);
  });

  it("includes the four trouble tokens", () => {
    expect(VOCAB.has("ERROR")).toBe(true);
    expect(VOCAB.has("FAILED-NO-RETRY")).toBe(true);
    expect(VOCAB.has("FAILED-WILL-RETRY")).toBe(true);
    expect(VOCAB.has("PARTIAL-FAILURE")).toBe(true);
  });

  it("includes the lifecycle and quiet tokens", () => {
    expect(VOCAB.has("INFO-FINISHED")).toBe(true);
    expect(VOCAB.has("INFO-CHECKPOINT")).toBe(true);
    expect(VOCAB.has("INFO-PROGRESS")).toBe(true);
    expect(VOCAB.has("INFO-WAITING")).toBe(true);
  });

  it("includes the DEBUG-* wildcard marker", () => {
    expect(VOCAB.has("DEBUG-*")).toBe(true);
  });

  it("does not contain unbracketed garbage", () => {
    expect(VOCAB.has("FOO")).toBe(false);
    expect(VOCAB.has("")).toBe(false);
  });
});

describe("DEFAULT_SURFACE_MODES", () => {
  it("9 tokens default to 'always' (the loud ones)", () => {
    const always = [
      "NEEDS-INPUT",
      "NEEDS-DECISION",
      "NEEDS-CONFIRMATION",
      "NEEDS-CLARIFICATION",
      "ERROR",
      "FAILED-NO-RETRY",
      "PARTIAL-FAILURE",
      "INFO-FINISHED",
      "INFO-CHECKPOINT",
    ];
    for (const t of always) {
      expect(DEFAULT_SURFACE_MODES[t]).toBe("always");
    }
  });

  it("3 tokens default to 'silent'", () => {
    expect(DEFAULT_SURFACE_MODES["FAILED-WILL-RETRY"]).toBe("silent");
    expect(DEFAULT_SURFACE_MODES["INFO-PROGRESS"]).toBe("silent");
    expect(DEFAULT_SURFACE_MODES["INFO-WAITING"]).toBe("silent");
  });

  it("DEBUG-* defaults to silent (wildcard)", () => {
    expect(DEFAULT_SURFACE_MODES["DEBUG-*"]).toBe("silent");
  });
});

describe("TRAILING_TOKEN_RE", () => {
  it("matches token at end after blank line", () => {
    const m = "I'm done\n\n[INFO-FINISHED]".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("INFO-FINISHED");
  });

  it("matches token followed by trailing newline", () => {
    const m = "ok\n[NEEDS-INPUT]\n".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("NEEDS-INPUT");
  });

  it("matches only-token message", () => {
    const m = "[INFO-FINISHED]".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("INFO-FINISHED");
  });

  it("does not match mid-message tokens", () => {
    const m = "I said [NEEDS-INPUT] earlier but then continued".match(TRAILING_TOKEN_RE);
    expect(m).toBe(null);
  });

  it("matches CRLF line endings", () => {
    const m = "done.\r\n[ERROR]\r\n".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("ERROR");
  });
});

describe("extractTrailingToken", () => {
  it("extracts the token from end-of-message", () => {
    expect(extractTrailingToken("done\n[INFO-FINISHED]")).toBe("INFO-FINISHED");
  });

  it("returns null when no trailing token", () => {
    expect(extractTrailingToken("just plain text")).toBe(null);
  });

  it("matches every token in VOCAB except the wildcard", () => {
    for (const t of [...VOCAB]) {
      if (t === "DEBUG-*") continue; // wildcard isn't itself a token
      expect(extractTrailingToken(`done\n[${t}]`)).toBe(t);
    }
  });
});

describe("isDebugToken", () => {
  it("returns true for DEBUG-* shapes", () => {
    expect(isDebugToken("DEBUG-SQL")).toBe(true);
    expect(isDebugToken("DEBUG-AUTH")).toBe(true);
    expect(isDebugToken("DEBUG-RETRY-ATTEMPT")).toBe(true);
  });

  it("returns false for non-DEBUG tokens", () => {
    expect(isDebugToken("NEEDS-INPUT")).toBe(false);
    expect(isDebugToken("ERROR")).toBe(false);
    expect(isDebugToken("INFO-PROGRESS")).toBe(false);
  });

  it("returns false for the bare DEBUG (no suffix) — vocabulary requires DEBUG-X form", () => {
    expect(isDebugToken("DEBUG")).toBe(false);
  });
});

describe("resolveSurfaceMode", () => {
  it("CLI override > policy > default — CLI wins all", () => {
    const mode = resolveSurfaceMode("INFO-FINISHED", { surface: ["INFO-FINISHED"], silence: [] }, { "INFO-FINISHED": "silent" });
    expect(mode).toBe("always");
  });

  it("CLI silence overrides policy always", () => {
    const mode = resolveSurfaceMode("ERROR", { surface: [], silence: ["ERROR"] }, { "ERROR": "always" });
    expect(mode).toBe("silent");
  });

  it("policy overrides default when CLI is silent on the token", () => {
    const mode = resolveSurfaceMode("INFO-PROGRESS", { surface: [], silence: [] }, { "INFO-PROGRESS": "always" });
    expect(mode).toBe("always");
  });

  it("falls back to default when neither CLI nor policy specifies", () => {
    expect(resolveSurfaceMode("NEEDS-INPUT", { surface: [], silence: [] }, {})).toBe("always");
    expect(resolveSurfaceMode("INFO-PROGRESS", { surface: [], silence: [] }, {})).toBe("silent");
    expect(resolveSurfaceMode("FAILED-WILL-RETRY", { surface: [], silence: [] }, {})).toBe("silent");
  });

  it("DEBUG-* tokens fall back to the wildcard default (silent)", () => {
    expect(resolveSurfaceMode("DEBUG-SQL", { surface: [], silence: [] }, {})).toBe("silent");
    expect(resolveSurfaceMode("DEBUG-AUTH-TRACE", { surface: [], silence: [] }, {})).toBe("silent");
  });

  it("policy can override DEBUG-* via the wildcard key", () => {
    expect(resolveSurfaceMode("DEBUG-SQL", { surface: [], silence: [] }, { "DEBUG-*": "always" })).toBe("always");
  });

  it("unknown token falls back to silent (conservative default)", () => {
    expect(resolveSurfaceMode("MYSTERY-TOKEN", { surface: [], silence: [] }, {})).toBe("silent");
  });
});
