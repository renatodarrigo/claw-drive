/**
 * context-rotation — pure rotation-eligibility logic, extracted (CD-4 budget.ts pattern)
 * so the gate is unit-testable without a runner or a real claude process.
 * Config is passed per call, never captured: update_policy can change the
 * rotation block live on a running session and the next check sees it.
 */
import type { Policy, PolicyObject } from "../lib/policy.js";

/** Derived from the policy schema so the two can never drift. */
export type RotationConfig = NonNullable<PolicyObject["rotation"]>;

export const DEFAULT_MAX_GENERATIONS = 10;

export function rotationConfigOf(policy: Policy): RotationConfig | null {
  if (policy === "bypass") return null;
  return policy.rotation ?? null;
}

/** Effective cap with the default applied; 0 = unlimited. */
export function effectiveMaxGenerations(cfg: RotationConfig): number {
  return cfg.max_generations ?? DEFAULT_MAX_GENERATIONS;
}

export function isOverThreshold(
  cfg: RotationConfig | null,
  contextTokens: number | null
): boolean {
  if (!cfg || contextTokens === null) return false;
  return contextTokens >= cfg.threshold_tokens;
}

export type RotateBlockerCode =
  | "NO_ROTATION_CONFIG"
  | "TURN_IN_FLIGHT"
  | "DECISIONS_PENDING"
  | "INTERRUPT_GRACE"
  | "MAX_GENERATIONS"
  | "BOOTSTRAP_EXCEEDS_THRESHOLD";

/** How long after an interrupt_turn SIGINT before B is trusted with a
 * handover turn. Dogfood 2026-08-04: a rotate issued seconds after an
 * interrupt landed on a claude process that exited instead of answering —
 * the interrupt had left it about to die. A completed turn is proof of life
 * and clears the window early (the runner nulls its interrupt stamp). */
export const INTERRUPT_GRACE_MS = 15_000;

export interface RotateBlocker {
  code: RotateBlockerCode;
  message: string;
}

export interface RotateGateInput {
  cfg: RotationConfig | null;
  turnInFlight: boolean;
  pendingCallIds: string[];
  generation: number;
  /** Context reading of the FIRST completed turn; null until then. Compared
   * against cfg.threshold_tokens AT CHECK TIME (not latched), so a live
   * update_policy raise of the threshold takes effect immediately. */
  firstTurnContextTokens: number | null;
  /** Milliseconds since the last interrupt_turn SIGINT; null (or absent) when
   * no interrupt happened or a later turn_completed proved B alive. */
  msSinceInterrupt?: number | null;
}

/**
 * The rotate preconditions, in a stable order. Transient blockers first
 * (in-flight turn, pending decisions — resolve and retry), then the two
 * policy-level refusals that also warrant a rotation_refused event
 * (MAX_GENERATIONS, BOOTSTRAP_EXCEEDS_THRESHOLD — the runner emits those).
 */
export function checkRotateGate(input: RotateGateInput): RotateBlocker | null {
  if (!input.cfg) {
    return {
      code: "NO_ROTATION_CONFIG",
      message: "session policy has no rotation block; add one (or update_policy) to enable rotation",
    };
  }
  if (input.turnInFlight) {
    return {
      code: "TURN_IN_FLIGHT",
      message: "a turn is in flight; rotation only runs at a turn boundary — wait for turn_completed and retry",
    };
  }
  if (input.pendingCallIds.length > 0) {
    return {
      code: "DECISIONS_PENDING",
      message: `pending tool decisions must be resolved first: ${input.pendingCallIds.join(", ")}`,
    };
  }
  if (
    input.msSinceInterrupt !== undefined &&
    input.msSinceInterrupt !== null &&
    input.msSinceInterrupt < INTERRUPT_GRACE_MS
  ) {
    return {
      code: "INTERRUPT_GRACE",
      message:
        `a turn was interrupted ${Math.round(input.msSinceInterrupt / 1000)}s ago — an interrupted claude process can exit on its next ` +
        `turn. Wait ${INTERRUPT_GRACE_MS / 1000}s after an interrupt (or complete a turn) and retry`,
    };
  }
  const maxG = effectiveMaxGenerations(input.cfg);
  if (maxG !== 0 && input.generation >= maxG) {
    return {
      code: "MAX_GENERATIONS",
      message:
        `generation ${input.generation} is at or past the cap (max_generations ${maxG}). ` +
        `Raise the cap via update_policy (0 = unlimited), or stop and re-brief a fresh lineage from the terminal handover.`,
    };
  }
  if (input.firstTurnContextTokens !== null && input.firstTurnContextTokens >= input.cfg.threshold_tokens) {
    return {
      code: "BOOTSTRAP_EXCEEDS_THRESHOLD",
      message:
        "the session's FIRST completed turn already exceeded threshold_tokens — a successor would insta-exceed it too " +
        "(infinite rotation loop). Raise the threshold or slim the brief/CLAUDE.md.",
    };
  }
  return null;
}

/** Auto-rotation advisory pre-check, run at a completed-turn boundary. The
 * rotate gate inside the rotation op is the single authority — this only
 * decides whether an attempt is worth dispatching at all. */
export interface AutoRotationCheckInput {
  cfg: RotationConfig | null;
  contextTokens: number | null;
  latched: boolean;
  rotating: boolean;
}

export function shouldAttemptAutoRotation(input: AutoRotationCheckInput): boolean {
  if (!input.cfg || input.cfg.mode !== "auto") return false;
  if (input.latched || input.rotating) return false;
  return isOverThreshold(input.cfg, input.contextTokens);
}

/**
 * Which failed rotation outcomes latch auto-rotation off. Policy refusals
 * are deterministic w.r.t. (config, session facts) — generation never
 * decreases and the first turn's reading is fixed — so retrying without a
 * config change is provably futile; failures each burn a full handover turn
 * per attempt, so unbounded retry is the churn the latch exists to prevent.
 * Transient blockers defer instead: the next boundary retries for free.
 */
export function autoOutcomeLatches(error: string): boolean {
  return (
    error === "MAX_GENERATIONS" ||
    error === "BOOTSTRAP_EXCEEDS_THRESHOLD" ||
    error === "ROTATION_FAILED"
  );
}

/** Derived from the policy schema so the two can never drift. */
export type RespawnConfig = NonNullable<PolicyObject["respawn"]>;

export const DEFAULT_RESPAWN_MAX_ATTEMPTS = 2;

export function respawnConfigOf(policy: Policy): RespawnConfig | null {
  if (policy === "bypass") return null;
  return policy.respawn ?? null;
}

export interface CheckpointConfig {
  interval_seconds: number;
  model?: string;
}

/** The policy's checkpoint block, or null ("bypass" and absent read null). */
export function checkpointConfigOf(policy: Policy): CheckpointConfig | null {
  if (policy === "bypass") return null;
  return policy.checkpoint ?? null;
}

/** Effective consecutive-respawn budget with the default applied; 0 = unlimited. */
export function effectiveMaxAttempts(cfg: RespawnConfig): number {
  return cfg.max_attempts ?? DEFAULT_RESPAWN_MAX_ATTEMPTS;
}

export interface RespawnGateInput {
  respawnCfg: RespawnConfig | null;
  /** For the lineage generation cap; null when the policy has no rotation block. */
  rotationCfg: RotationConfig | null;
  /** state.rotated_to — a successor already exists (rotation won mid-crash). */
  rotatedTo: string | undefined;
  /** ctx.stopping — a stop or breaker teardown engaged during the crash. */
  stopping: boolean;
  /** state.respawn_streak ?? 0. */
  respawnStreak: number;
  /** state.generation ?? 1. */
  generation: number;
  /** state.cost_usd ?? state.cost_usd_base — best-known lineage total. */
  lineageCostUsd: number | undefined;
  /** budget.max_cost_usd when configured. */
  maxCostUsd: number | undefined;
}

export type RespawnBlocker =
  | { kind: "silent"; code: "NOT_CONFIGURED" | "ALREADY_HAS_SUCCESSOR" }
  | { kind: "narrated"; reason: string };

/**
 * Crash auto-respawn pre-checks, in a stable order (checkRotateGate's
 * pattern: pure, config passed per call, unit-testable without a runner).
 * Silent blockers first — an unconfigured session has nothing to narrate,
 * and an already-successored crash was narrated by session_rotated, so it
 * outranks even a stop: a "successor not started" reason would contradict
 * the recorded rotation. Narrated blockers carry the recover_failed reason
 * with the normative `prefix:` grammar. Null ⇒ respawn proceeds. The
 * generation cap reads the rotation block when present and defaults to
 * DEFAULT_MAX_GENERATIONS otherwise — automation always has a lineage
 * bound; only manual recover may exceed it.
 */
export function checkRespawnGate(input: RespawnGateInput): RespawnBlocker | null {
  if (!input.respawnCfg || input.respawnCfg.mode !== "auto") {
    return { kind: "silent", code: "NOT_CONFIGURED" };
  }
  if (input.rotatedTo !== undefined) {
    return { kind: "silent", code: "ALREADY_HAS_SUCCESSOR" };
  }
  if (input.stopping) {
    return {
      kind: "narrated",
      reason:
        "session_stopping: stop or circuit breaker engaged during crash teardown; successor not started",
    };
  }
  const maxA = effectiveMaxAttempts(input.respawnCfg);
  if (maxA !== 0 && input.respawnStreak >= maxA) {
    return {
      kind: "narrated",
      reason:
        `max_attempts_exhausted: ${input.respawnStreak} consecutive respawns without a completed turn ` +
        `(max_attempts ${maxA}); successor not started — recover manually to restart the chain`,
    };
  }
  const maxG = input.rotationCfg
    ? effectiveMaxGenerations(input.rotationCfg)
    : DEFAULT_MAX_GENERATIONS;
  if (maxG !== 0 && input.generation >= maxG) {
    return {
      kind: "narrated",
      reason:
        `max_generations: generation ${input.generation} is at or past the cap (max_generations ${maxG}); ` +
        `successor not started — recover manually to exceed the cap`,
    };
  }
  if (
    input.maxCostUsd !== undefined &&
    input.lineageCostUsd !== undefined &&
    input.lineageCostUsd > input.maxCostUsd
  ) {
    return {
      kind: "narrated",
      reason:
        `budget_exceeded: lineage cost ${input.lineageCostUsd} exceeds max_cost_usd ${input.maxCostUsd}; ` +
        `successor not started`,
    };
  }
  return null;
}
