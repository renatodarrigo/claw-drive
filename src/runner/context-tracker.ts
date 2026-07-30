/**
 * context-rotation — pure rotation-eligibility logic, extracted (CD-4 budget.ts pattern)
 * so the gate is unit-testable without a runner or a real claude process.
 * Config is passed per call, never captured: update_policy can change the
 * rotation block live on a running session and the next check sees it.
 */
import type { Policy } from "../lib/policy.js";

export interface RotationConfig {
  threshold_tokens: number;
  max_generations?: number;
  mode?: "manual";
}

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
  | "MAX_GENERATIONS"
  | "BOOTSTRAP_EXCEEDS_THRESHOLD";

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
  const maxG = effectiveMaxGenerations(input.cfg);
  if (maxG !== 0 && input.generation >= maxG) {
    return {
      code: "MAX_GENERATIONS",
      message:
        `generation ${input.generation} is the last permitted (max_generations ${maxG}). ` +
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
