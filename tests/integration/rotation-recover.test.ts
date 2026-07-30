import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";
import { ROTATION_POLICY, waitFor } from "./rotation-helpers.js";

describe("context-rotation recover from a hard death (REAL claude, costs tokens)", () => {
  it("SIGKILLed runner → recover distills a crash-handover and spawns a successor", async () => {
    const t = await makeTmpSession();
    try {
      const policyFile = path.join(t.cwd, "policy.json");
      await fs.writeFile(policyFile, JSON.stringify(ROTATION_POLICY));
      const briefFile = path.join(t.cwd, "brief.md");
      await fs.writeFile(briefFile, "Count files in this directory when asked; reply tersely.");
      const started = await runCliBlocking(t.binPath, t.env, [
        "start", "--cwd", t.cwd, "--policy", policyFile, "--brief", briefFile,
      ]);
      expect(started.code).toBe(0);
      const id = started.stdout.trim();
      await waitFor(t.clawDriveRoot, id, (evs) =>
        evs.filter((e) => e.kind === "turn_completed").length >= 1, 240_000);

      // Hard death: SIGKILL the RUNNER (no chance for its own distillation).
      const state = JSON.parse(
        await fs.readFile(path.join(t.clawDriveRoot, "sessions", id, "state.json"), "utf-8"));
      process.kill(state.runner_pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 2000));

      const rec = await runCliBlocking(t.binPath, t.env, ["recover", id]);
      expect(rec.code).toBe(0);
      const newId = rec.stdout.trim();
      expect(newId).toMatch(/^sess_/);
      const crash = await fs.readFile(
        path.join(t.clawDriveRoot, "sessions", id, "crash-handover.md"), "utf-8");
      expect(crash).toContain("## Current objective");
      const succ = JSON.parse(
        await fs.readFile(path.join(t.clawDriveRoot, "sessions", newId, "state.json"), "utf-8"));
      expect(succ).toMatchObject({ rotated_from: id, generation: 2 });
      const dead = JSON.parse(
        await fs.readFile(path.join(t.clawDriveRoot, "sessions", id, "state.json"), "utf-8"));
      expect(dead.rotated_to).toBe(newId);

      await runCliBlocking(t.binPath, t.env, ["stop", newId]);
    } finally {
      await t.cleanup();
    }
  }, 900_000);
});
