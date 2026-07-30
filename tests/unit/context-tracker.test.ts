import { describe, it, expect } from "vitest";
import {
  rotationConfigOf,
  isOverThreshold,
  checkRotateGate,
  effectiveMaxGenerations,
  DEFAULT_MAX_GENERATIONS,
} from "../../src/runner/context-tracker.js";

const CFG = { threshold_tokens: 100_000 };

describe("rotationConfigOf", () => {
  it("returns the block from an object policy, null for bypass / absent", () => {
    expect(rotationConfigOf({ rotation: CFG })).toEqual(CFG);
    expect(rotationConfigOf("bypass")).toBeNull();
    expect(rotationConfigOf({})).toBeNull();
  });
});

describe("isOverThreshold", () => {
  it("true only with a config AND a reading at/above the threshold", () => {
    expect(isOverThreshold(CFG, 100_000)).toBe(true);
    expect(isOverThreshold(CFG, 99_999)).toBe(false);
    expect(isOverThreshold(CFG, null)).toBe(false);
    expect(isOverThreshold(null, 200_000)).toBe(false);
  });
});

describe("effectiveMaxGenerations", () => {
  it("defaults to 10, passes 0 (unlimited) and explicit values through", () => {
    expect(DEFAULT_MAX_GENERATIONS).toBe(10);
    expect(effectiveMaxGenerations(CFG)).toBe(10);
    expect(effectiveMaxGenerations({ ...CFG, max_generations: 0 })).toBe(0);
    expect(effectiveMaxGenerations({ ...CFG, max_generations: 3 })).toBe(3);
  });
});

describe("checkRotateGate", () => {
  const base = {
    cfg: CFG,
    turnInFlight: false,
    pendingCallIds: [] as string[],
    generation: 1,
    bootstrapExceeded: false,
  };
  it("passes a clean gate", () => {
    expect(checkRotateGate(base)).toBeNull();
  });
  it("blocks without a rotation config", () => {
    expect(checkRotateGate({ ...base, cfg: null })?.code).toBe("NO_ROTATION_CONFIG");
  });
  it("blocks while a turn is in flight", () => {
    expect(checkRotateGate({ ...base, turnInFlight: true })?.code).toBe("TURN_IN_FLIGHT");
  });
  it("blocks with pending decisions and names the call_ids", () => {
    const b = checkRotateGate({ ...base, pendingCallIds: ["toolu_1", "toolu_2"] });
    expect(b?.code).toBe("DECISIONS_PENDING");
    expect(b?.message).toContain("toolu_1");
  });
  it("blocks at the generation cap (default 10) but not under it, and never when 0", () => {
    expect(checkRotateGate({ ...base, generation: 10 })?.code).toBe("MAX_GENERATIONS");
    expect(checkRotateGate({ ...base, generation: 9 })).toBeNull();
    expect(
      checkRotateGate({ ...base, generation: 500, cfg: { ...CFG, max_generations: 0 } })
    ).toBeNull();
  });
  it("blocks when bootstrap already exceeded the threshold", () => {
    expect(checkRotateGate({ ...base, bootstrapExceeded: true })?.code).toBe(
      "BOOTSTRAP_EXCEEDS_THRESHOLD"
    );
  });
  it("gate order: config > in-flight > pending > cap > bootstrap", () => {
    const b = checkRotateGate({
      ...base,
      turnInFlight: true,
      pendingCallIds: ["x"],
      generation: 10,
      bootstrapExceeded: true,
    });
    expect(b?.code).toBe("TURN_IN_FLIGHT");
  });
});
