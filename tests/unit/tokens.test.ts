import { describe, it, expect } from "vitest";
import {
  WRAPPER_PROMPT,
  VOCAB,
  DEFAULT_SURFACE_MODES,
  TRAILING_TOKEN_RE,
  extractTrailingToken,
  resolveSurfaceMode,
} from "../../src/lib/tokens.js";

describe("WRAPPER_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof WRAPPER_PROMPT).toBe("string");
    expect(WRAPPER_PROMPT.length).toBeGreaterThan(100);
  });

  it("contains both tokens with their semantic descriptions", () => {
    expect(WRAPPER_PROMPT).toContain("[NEEDS-INPUT]");
    expect(WRAPPER_PROMPT).toContain("[DONE]");
    expect(WRAPPER_PROMPT).toMatch(/human's turn/i);
    expect(WRAPPER_PROMPT).toMatch(/task complete/i);
  });

  it("contains no retired tokens", () => {
    for (const retired of [
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
      "[DEBUG-",
    ]) {
      expect(WRAPPER_PROMPT).not.toContain(retired);
    }
  });

  it("contains the format-rules section", () => {
    expect(WRAPPER_PROMPT).toMatch(/Format rules:/i);
    expect(WRAPPER_PROMPT).toMatch(/own line/i);
    expect(WRAPPER_PROMPT).toMatch(/literal bracketed text/i);
  });

  it("ends without leading/trailing whitespace clutter", () => {
    expect(WRAPPER_PROMPT.trim()).toBe(WRAPPER_PROMPT.trimEnd());
  });
});

describe("VOCAB", () => {
  it("contains exactly the 2 entries", () => {
    expect(VOCAB.size).toBe(2);
  });

  it("contains NEEDS-INPUT and DONE", () => {
    expect(VOCAB.has("NEEDS-INPUT")).toBe(true);
    expect(VOCAB.has("DONE")).toBe(true);
  });

  it("does not contain retired or unbracketed tokens", () => {
    for (const t of [
      "INFO-FINISHED",
      "INFO-CHECKPOINT",
      "ERROR",
      "FAILED-NO-RETRY",
      "DEBUG-*",
      "DEBUG-SQL",
      "FOO",
      "",
    ]) {
      expect(VOCAB.has(t)).toBe(false);
    }
  });
});

describe("DEFAULT_SURFACE_MODES", () => {
  it("has both tokens at 'always'", () => {
    expect(DEFAULT_SURFACE_MODES["NEEDS-INPUT"]).toBe("always");
    expect(DEFAULT_SURFACE_MODES["DONE"]).toBe("always");
  });

  it("has no other entries", () => {
    expect(Object.keys(DEFAULT_SURFACE_MODES).sort()).toEqual(["DONE", "NEEDS-INPUT"]);
  });
});

describe("TRAILING_TOKEN_RE", () => {
  it("matches token at end after blank line", () => {
    const m = "I'm done\n\n[DONE]".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("DONE");
  });

  it("matches token followed by trailing newline", () => {
    const m = "ok\n[NEEDS-INPUT]\n".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("NEEDS-INPUT");
  });

  it("matches only-token message", () => {
    const m = "[DONE]".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("DONE");
  });

  it("does not match mid-message tokens", () => {
    const m = "I said [NEEDS-INPUT] earlier but then continued".match(TRAILING_TOKEN_RE);
    expect(m).toBe(null);
  });

  it("matches CRLF line endings", () => {
    const m = "done.\r\n[DONE]\r\n".match(TRAILING_TOKEN_RE);
    expect(m?.[1]).toBe("DONE");
  });
});

describe("extractTrailingToken", () => {
  it("extracts DONE from end-of-message", () => {
    expect(extractTrailingToken("done\n[DONE]")).toBe("DONE");
  });

  it("extracts NEEDS-INPUT from end-of-message", () => {
    expect(extractTrailingToken("question?\n[NEEDS-INPUT]")).toBe("NEEDS-INPUT");
  });

  it("returns null when no trailing token", () => {
    expect(extractTrailingToken("just plain text")).toBe(null);
  });

  it("matches every token in VOCAB", () => {
    for (const t of [...VOCAB]) {
      expect(extractTrailingToken(`done\n[${t}]`)).toBe(t);
    }
  });
});

describe("resolveSurfaceMode", () => {
  it("returns 'always' for NEEDS-INPUT", () => {
    expect(resolveSurfaceMode("NEEDS-INPUT")).toBe("always");
  });

  it("returns 'always' for DONE", () => {
    expect(resolveSurfaceMode("DONE")).toBe("always");
  });

  it("returns 'silent' for unknown tokens (conservative default)", () => {
    expect(resolveSurfaceMode("UNKNOWN")).toBe("silent");
    expect(resolveSurfaceMode("INFO-FINISHED")).toBe("silent"); // retired token
    expect(resolveSurfaceMode("DEBUG-SQL")).toBe("silent"); // retired wildcard family
    expect(resolveSurfaceMode("")).toBe("silent");
  });
});
