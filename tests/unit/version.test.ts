import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getVersion } from "../../src/cli/cli.js";

describe("getVersion", () => {
  it("returns the contents of VERSION at repo root", () => {
    // Compute the same path getVersion uses, but from the test file:
    // tests/unit/version.test.ts → ../../VERSION
    const here = fileURLToPath(import.meta.url);
    const versionPath = resolve(dirname(here), "..", "..", "VERSION");
    const expected = readFileSync(versionPath, "utf8").trim();
    expect(getVersion()).toBe(expected);
  });

  it("matches semver-shaped X.Y.Z", () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  });
});
