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
