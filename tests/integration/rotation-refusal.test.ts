import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";
import { ROTATION_POLICY, eventsOf, waitFor } from "./rotation-helpers.js";

describe("context-rotation bootstrap refusal (REAL claude, cheap)", () => {
  it("first turn exceeds a 1k threshold → rotate refuses, session lives", async () => {
    const t = await makeTmpSession();
    try {
      const policyFile = path.join(t.cwd, "policy.json");
      await fs.writeFile(policyFile, JSON.stringify({
        ...ROTATION_POLICY, rotation: { threshold_tokens: 1000 },
      }));
      const started = await runCliBlocking(t.binPath, t.env, [
        "start", "--cwd", t.cwd, "--policy", policyFile,
      ]);
      expect(started.code).toBe(0);
      const id = started.stdout.trim();
      const send = await runCliBlocking(t.binPath, t.env, ["send", id, "Reply exactly: ok"]);
      expect(send.code).toBe(0);
      await waitFor(t.clawDriveRoot, id, (evs) =>
        evs.some((e) => e.kind === "context_threshold_reached"), 240_000);

      const rot = await runCliBlocking(t.binPath, t.env, ["rotate", id]);
      expect(rot.code).toBe(1);
      expect(rot.stderr).toContain("BOOTSTRAP_EXCEEDS_THRESHOLD");
      const evs = await eventsOf(t.clawDriveRoot, id);
      expect(evs.some((e) =>
        e.kind === "rotation_refused" &&
        (e as { reason: string }).reason === "bootstrap_exceeds_threshold")).toBe(true);
      // Guiding invariant: the session is still alive and responsive. Pin it for
      // real — wait for the second turn to actually complete, not just for the
      // CLI to accept the send.
      const send2 = await runCliBlocking(t.binPath, t.env, ["send", id, "Reply exactly: ok"]);
      expect(send2.code).toBe(0);
      await waitFor(t.clawDriveRoot, id, (evs) =>
        evs.filter((e) => e.kind === "turn_completed").length >= 2, 240_000);
      await runCliBlocking(t.binPath, t.env, ["stop", id]);
    } finally {
      await t.cleanup();
    }
  }, 600_000);
});
