import { describe, it, expect } from "vitest";
import {
  buildNotificationContract,
  DEFAULT_IDLE_AFTER_SECONDS,
  VOCAB,
} from "../../src/lib/tokens.js";

describe("buildNotificationContract", () => {
  const baseArgs = {
    watchCommand: "claw-drive watch sess_xxx",
    wrapperEnabled: true,
  };

  it("returns version 1", () => {
    const c = buildNotificationContract(baseArgs);
    expect(c.version).toBe(1);
  });

  it("returns wrapper_enabled = true when set", () => {
    const c = buildNotificationContract({ ...baseArgs, wrapperEnabled: true });
    expect(c.wrapper_enabled).toBe(true);
  });

  it("returns wrapper_enabled = false when set", () => {
    const c = buildNotificationContract({ ...baseArgs, wrapperEnabled: false });
    expect(c.wrapper_enabled).toBe(false);
  });

  it("includes both vocab tokens with surface=always", () => {
    const c = buildNotificationContract(baseArgs);
    expect(c.vocabulary).toHaveLength(2);
    const tokens = c.vocabulary.map((v) => v.token).sort();
    expect(tokens).toEqual(["DONE", "NEEDS-INPUT"]);
    for (const v of c.vocabulary) {
      expect(v.surface).toBe("always");
      expect(v.semantic.length).toBeGreaterThan(20);
    }
  });

  it("vocabulary contents match VOCAB exactly", () => {
    const c = buildNotificationContract(baseArgs);
    const contractTokens = new Set(c.vocabulary.map((v) => v.token));
    expect(contractTokens).toEqual(VOCAB);
  });

  it("vocabulary order matches VOCAB insertion order (NEEDS-INPUT, then DONE)", () => {
    const c = buildNotificationContract(baseArgs);
    expect(c.vocabulary.map((v) => v.token)).toEqual(["NEEDS-INPUT", "DONE"]);
  });

  it("returns the watch_command verbatim", () => {
    const c = buildNotificationContract({ ...baseArgs, watchCommand: "claw-drive watch sess_abc" });
    expect(c.watch_command).toBe("claw-drive watch sess_abc");
  });

  it("includes the four documented watch_flags keys", () => {
    const c = buildNotificationContract(baseArgs);
    expect(Object.keys(c.watch_flags).sort()).toEqual([
      "--decision-only",
      "--idle-after SECONDS",
      "--no-token-filter",
      "--only KIND[,KIND]...",
    ]);
    for (const desc of Object.values(c.watch_flags)) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(10);
    }
  });

  it("returns DEFAULT_IDLE_AFTER_SECONDS when idleAfterSeconds is omitted", () => {
    const c = buildNotificationContract(baseArgs);
    expect(c.idle_after_seconds).toBe(DEFAULT_IDLE_AFTER_SECONDS);
  });

  it("respects an explicit idleAfterSeconds override", () => {
    const c = buildNotificationContract({ ...baseArgs, idleAfterSeconds: 120 });
    expect(c.idle_after_seconds).toBe(120);
  });
});
