import { describe, it, expect } from "vitest";
import {
  rotationConfigOf,
  isOverThreshold,
  checkRotateGate,
  effectiveMaxGenerations,
  DEFAULT_MAX_GENERATIONS,
  shouldAttemptAutoRotation,
  autoOutcomeLatches,
  respawnConfigOf,
  effectiveMaxAttempts,
  DEFAULT_RESPAWN_MAX_ATTEMPTS,
  checkRespawnGate,
  type RespawnGateInput,
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
    firstTurnContextTokens: null as number | null,
  };
  // A3 (dogfood 2026-08-04): SIGINT + a rotate seconds later killed B — the
  // handover turn landed on a claude process that was about to exit. Rotation
  // must refuse inside a settle window after an interrupt.
  it("refuses INTERRUPT_GRACE within 15s of an interrupt", () => {
    const b = checkRotateGate({ ...base, msSinceInterrupt: 3_000 });
    expect(b?.code).toBe("INTERRUPT_GRACE");
    expect(b?.message).toContain("interrupt");
  });
  it("passes once the grace window has elapsed", () => {
    expect(checkRotateGate({ ...base, msSinceInterrupt: 15_000 })).toBeNull();
  });
  it("passes when no interrupt was recorded (null or omitted)", () => {
    expect(checkRotateGate({ ...base, msSinceInterrupt: null })).toBeNull();
    expect(checkRotateGate(base)).toBeNull();
  });
  it("TURN_IN_FLIGHT outranks the grace window", () => {
    const b = checkRotateGate({ ...base, turnInFlight: true, msSinceInterrupt: 1_000 });
    expect(b?.code).toBe("TURN_IN_FLIGHT");
  });
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
    expect(checkRotateGate({ ...base, firstTurnContextTokens: 100_000 })?.code).toBe(
      "BOOTSTRAP_EXCEEDS_THRESHOLD"
    );
  });
  it("gate order: config > in-flight > pending > cap > bootstrap", () => {
    const b = checkRotateGate({
      ...base,
      turnInFlight: true,
      pendingCallIds: ["x"],
      generation: 10,
      firstTurnContextTokens: 100_000,
    });
    expect(b?.code).toBe("TURN_IN_FLIGHT");
  });
  it("bootstrap gate recomputes against the CURRENT threshold: a live update_policy raise clears the refusal without a restart", () => {
    const input = { ...base, firstTurnContextTokens: 100_000 };
    expect(checkRotateGate(input)?.code).toBe("BOOTSTRAP_EXCEEDS_THRESHOLD");
    // Same firstTurnContextTokens reading; only cfg.threshold_tokens moves
    // (as a live update_policy would do) — now above the reading.
    const raised = { ...input, cfg: { ...CFG, threshold_tokens: 150_000 } };
    expect(checkRotateGate(raised)).toBeNull();
  });
});

describe("shouldAttemptAutoRotation", () => {
  const auto = { threshold_tokens: 1000, mode: "auto" as const };
  it("attempts only in auto mode: manual, absent mode, and missing config all refuse", () => {
    expect(shouldAttemptAutoRotation({ cfg: { threshold_tokens: 1000, mode: "manual" }, contextTokens: 5000, latched: false, rotating: false })).toBe(false);
    expect(shouldAttemptAutoRotation({ cfg: { threshold_tokens: 1000 }, contextTokens: 5000, latched: false, rotating: false })).toBe(false);
    expect(shouldAttemptAutoRotation({ cfg: null, contextTokens: 5000, latched: false, rotating: false })).toBe(false);
  });
  it("attempts at-or-over threshold, not under, never without a reading", () => {
    expect(shouldAttemptAutoRotation({ cfg: auto, contextTokens: 1000, latched: false, rotating: false })).toBe(true);
    expect(shouldAttemptAutoRotation({ cfg: auto, contextTokens: 999, latched: false, rotating: false })).toBe(false);
    expect(shouldAttemptAutoRotation({ cfg: auto, contextTokens: null, latched: false, rotating: false })).toBe(false);
  });
  it("the latch and an in-flight rotation each suppress the attempt", () => {
    expect(shouldAttemptAutoRotation({ cfg: auto, contextTokens: 5000, latched: true, rotating: false })).toBe(false);
    expect(shouldAttemptAutoRotation({ cfg: auto, contextTokens: 5000, latched: false, rotating: true })).toBe(false);
  });
});

describe("autoOutcomeLatches", () => {
  it("latches on the deterministic refusals and on failure", () => {
    expect(autoOutcomeLatches("MAX_GENERATIONS")).toBe(true);
    expect(autoOutcomeLatches("BOOTSTRAP_EXCEEDS_THRESHOLD")).toBe(true);
    expect(autoOutcomeLatches("ROTATION_FAILED")).toBe(true);
  });
  it("defers (no latch) on transient blockers and re-entry", () => {
    expect(autoOutcomeLatches("TURN_IN_FLIGHT")).toBe(false);
    expect(autoOutcomeLatches("DECISIONS_PENDING")).toBe(false);
    expect(autoOutcomeLatches("INTERRUPT_GRACE")).toBe(false);
    expect(autoOutcomeLatches("ROTATION_IN_PROGRESS")).toBe(false);
    expect(autoOutcomeLatches("NO_ROTATION_CONFIG")).toBe(false);
  });
});

describe("crash auto-respawn config helpers", () => {
  it("respawnConfigOf: bypass and absent block are null; present block returned", () => {
    expect(respawnConfigOf("bypass")).toBeNull();
    expect(respawnConfigOf({ escalate_default: true })).toBeNull();
    expect(respawnConfigOf({ respawn: { mode: "auto" } })).toEqual({ mode: "auto" });
  });
  it("effectiveMaxAttempts: default 2, explicit value, 0 preserved", () => {
    expect(effectiveMaxAttempts({})).toBe(DEFAULT_RESPAWN_MAX_ATTEMPTS);
    expect(effectiveMaxAttempts({ max_attempts: 5 })).toBe(5);
    expect(effectiveMaxAttempts({ max_attempts: 0 })).toBe(0);
  });
});

describe("checkRespawnGate", () => {
  const proceed: RespawnGateInput = {
    respawnCfg: { mode: "auto" },
    rotationCfg: null,
    rotatedTo: undefined,
    stopping: false,
    respawnStreak: 0,
    generation: 1,
    lineageCostUsd: undefined,
    maxCostUsd: undefined,
  };

  it("proceeds on the baseline input", () => {
    expect(checkRespawnGate(proceed)).toBeNull();
  });
  it("silent NOT_CONFIGURED: no block, manual mode, and modeless block alike", () => {
    for (const cfg of [null, { mode: "manual" as const }, {}]) {
      expect(checkRespawnGate({ ...proceed, respawnCfg: cfg })).toEqual({
        kind: "silent",
        code: "NOT_CONFIGURED",
      });
    }
  });
  it("silent ALREADY_HAS_SUCCESSOR wins over stopping (session_rotated already narrated)", () => {
    expect(
      checkRespawnGate({ ...proceed, rotatedTo: "sess_x", stopping: true })
    ).toEqual({ kind: "silent", code: "ALREADY_HAS_SUCCESSOR" });
  });
  it("narrates session_stopping when a stop engaged", () => {
    const b = checkRespawnGate({ ...proceed, stopping: true });
    expect(b?.kind).toBe("narrated");
    expect((b as { reason: string }).reason).toMatch(/^session_stopping: /);
  });
  it("narrates max_attempts_exhausted at the streak budget (default 2)", () => {
    const b = checkRespawnGate({ ...proceed, respawnStreak: 2 });
    expect((b as { reason: string }).reason).toMatch(/^max_attempts_exhausted: /);
  });
  it("streak below the budget proceeds; max_attempts 0 is unlimited", () => {
    expect(checkRespawnGate({ ...proceed, respawnStreak: 1 })).toBeNull();
    expect(
      checkRespawnGate({ ...proceed, respawnCfg: { mode: "auto", max_attempts: 0 }, respawnStreak: 99 })
    ).toBeNull();
  });
  it("narrates max_generations at the cap — default 10 without a rotation block", () => {
    const b = checkRespawnGate({ ...proceed, generation: 10 });
    expect((b as { reason: string }).reason).toMatch(/^max_generations: /);
  });
  it("rotation block's cap applies when present; 0 is unlimited", () => {
    expect(
      checkRespawnGate({
        ...proceed,
        rotationCfg: { threshold_tokens: 100_000, max_generations: 12 },
        generation: 10,
      })
    ).toBeNull();
    expect(
      checkRespawnGate({
        ...proceed,
        rotationCfg: { threshold_tokens: 100_000, max_generations: 0 },
        generation: 99,
      })
    ).toBeNull();
    const b = checkRespawnGate({
      ...proceed,
      rotationCfg: { threshold_tokens: 100_000, max_generations: 3 },
      generation: 3,
    });
    expect((b as { reason: string }).reason).toMatch(/^max_generations: /);
  });
  it("narrates budget_exceeded only when a cap exists and the lineage total exceeds it", () => {
    const b = checkRespawnGate({ ...proceed, lineageCostUsd: 6, maxCostUsd: 5 });
    expect((b as { reason: string }).reason).toMatch(/^budget_exceeded: /);
    expect(checkRespawnGate({ ...proceed, lineageCostUsd: 5, maxCostUsd: 5 })).toBeNull();
    expect(checkRespawnGate({ ...proceed, lineageCostUsd: 6, maxCostUsd: undefined })).toBeNull();
    expect(checkRespawnGate({ ...proceed, lineageCostUsd: undefined, maxCostUsd: 5 })).toBeNull();
  });
  it("check order: streak narrates before generation and budget", () => {
    const b = checkRespawnGate({
      ...proceed,
      respawnStreak: 2,
      generation: 10,
      lineageCostUsd: 6,
      maxCostUsd: 5,
    });
    expect((b as { reason: string }).reason).toMatch(/^max_attempts_exhausted: /);
  });
});
