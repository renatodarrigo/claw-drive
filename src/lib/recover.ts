/**
 * context-rotation `recover` — continue a DEAD session from the freshest handover:
 * the runner's best-effort crash-handover.md if present, else distill one now
 * from events.jsonl. Shared by the CLI subcommand and the MCP tool. Importing
 * runner/context-tracker from lib follows the existing precedent of
 * mcp/server.ts importing runner/socket-server.
 */
import * as fs from "node:fs/promises";
import {
  clawDriveBinPath,
  crashHandoverPath,
  eventsPath,
  sessionDir,
  statePath,
} from "./paths.js";
import { readState, writeState, isPidAlive } from "./state.js";
import { readEventsSince } from "./events.js";
import { buildCrashDigest, buildDistillerPrompt, runDistiller } from "./distill.js";
import { composeSuccessorBrief } from "./handover.js";
import {
  newSessionId,
  scaffoldSessionDir,
  spawnRunnerDetached,
  waitForReady,
} from "./spawn-session.js";
import { findLiveAliasHolder } from "./alias.js";
import { rotationConfigOf, effectiveMaxGenerations } from "../runner/context-tracker.js";

export interface RecoverInput {
  sessionId: string;
  model?: string | null;
  noStart?: boolean;
}

export type RecoverOutcome =
  | {
      ok: true;
      result: {
        handover_path: string;
        distilled: boolean;
        new_session_id?: string;
        alias?: string;
        generation?: number;
        watch_command?: string;
      };
    }
  | { ok: false; error: string; message: string };

const ACTIVE = new Set(["starting", "ready", "running"]);

export async function recoverSession(input: RecoverInput): Promise<RecoverOutcome> {
  const state = await readState(statePath(input.sessionId));
  if (!state) {
    return { ok: false, error: "SESSION_NOT_FOUND", message: `no state for ${input.sessionId}` };
  }
  const live =
    ACTIVE.has(state.status) && state.runner_pid !== null && isPidAlive(state.runner_pid);
  if (live) {
    return {
      ok: false,
      error: "SESSION_LIVE",
      message: "session is live — use rotate (or stop it first); recover targets dead sessions",
    };
  }
  if (state.rotated_to) {
    return {
      ok: false,
      error: "ALREADY_RECOVERED",
      message: `session already has a successor: ${state.rotated_to}`,
    };
  }

  const chPath = crashHandoverPath(input.sessionId);
  let handover: string | null = null;
  let distilled = false;
  try {
    handover = await fs.readFile(chPath, "utf-8");
  } catch {
    /* absent — distill below */
  }
  if (!handover) {
    const { events } = await readEventsSince(eventsPath(input.sessionId), 0);
    if (events.length === 0) {
      return { ok: false, error: "NO_RECORD", message: "no crash-handover and no events.jsonl to distill from" };
    }
    // Anti-telescoping (mirrors the rotate choreography and the crash
    // distiller in runner.ts): once a predecessor is itself a successor, its
    // scenario_brief is a COMPOSED brief (framing + handover + mission), not
    // the lineage's true original — prefer the typed original_brief field.
    const brief =
      state.original_brief ??
      (state as unknown as { scenario_brief?: string }).scenario_brief ??
      "";
    handover = await runDistiller({
      model: input.model ?? state.model,
      prompt: buildDistillerPrompt({ digest: buildCrashDigest(events), originalBrief: brief }),
      // Neutral cwd: the dead session's own dir always exists and holds no
      // CLAUDE.md / .claude/ of its own (see runDistiller's doc comment).
      cwd: sessionDir(input.sessionId),
    });
    if (!handover) {
      return { ok: false, error: "DISTILL_FAILED", message: "distiller produced no extractable <handover>" };
    }
    await fs.writeFile(chPath, handover);
    distilled = true;
  }
  if (input.noStart) {
    return { ok: true, result: { handover_path: chPath, distilled } };
  }

  const generation = (state.generation ?? 1) + 1;
  const cfg = rotationConfigOf(state.policy);
  const maxG = cfg ? effectiveMaxGenerations(cfg) : 0;
  let alias: string | undefined;
  if (state.alias && (await findLiveAliasHolder(state.alias)) === null) {
    alias = state.alias; // dead holder does not block; a live squatter does
  }
  const newId = newSessionId();
  // The lineage's TRUE original mission — never re-derive it from a
  // predecessor's scenario_brief once that predecessor is itself a successor
  // (that brief is already a composed handover, not the original; same
  // anti-telescoping fix as the rotate choreography's "rotate" case in
  // runner.ts). Resolved once and passed BOTH into composeSuccessorBrief
  // (for the successor's first turn) and as scaffoldSessionDir's own
  // originalBrief (so the successor's state carries the true original
  // forward instead of re-deriving it from its own composed scenario_brief).
  const originalBrief =
    state.original_brief ??
    (state as unknown as { scenario_brief?: string }).scenario_brief ??
    "(no original brief was recorded at session start)";
  await scaffoldSessionDir({
    sessionId: newId,
    cwd: state.cwd,
    policy: state.policy,
    decisionTimeoutSeconds: state.decision_timeout_seconds,
    model: state.model,
    scenarioBrief: composeSuccessorBrief({
      originalBrief,
      handover,
      generation,
      maxGenerations: maxG,
      predecessorId: input.sessionId,
      predecessorEventsPath: eventsPath(input.sessionId),
    }),
    originalBrief,
    wrapper: state.wrapper,
    alias,
    lineage: {
      generation,
      root_session_id: state.root_session_id ?? input.sessionId,
      rotated_from: input.sessionId,
    },
  });
  spawnRunnerDetached(newId);
  if (!(await waitForReady(newId, 5000))) {
    await fs.rm(sessionDir(newId), { recursive: true, force: true });
    return { ok: false, error: "RECOVER_FAILED", message: "successor runner did not become ready within 5s" };
  }
  state.rotated_to = newId;
  await writeState(statePath(input.sessionId), state);
  return {
    ok: true,
    result: {
      handover_path: chPath,
      distilled,
      new_session_id: newId,
      ...(alias ? { alias } : {}),
      generation,
      watch_command: `${clawDriveBinPath()} watch ${newId}`,
    },
  };
}
