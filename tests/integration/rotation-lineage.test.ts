import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";
import { ROTATION_POLICY, padding, eventsOf, waitFor } from "./rotation-helpers.js";

describe("context-rotation rotation lineage (REAL claude, costs tokens)", () => {
  it("rotates twice: handover, lineage, alias transfer, verbatim mission", async () => {
    const t = await makeTmpSession();
    try {
      const policyFile = path.join(t.cwd, "policy.json");
      await fs.writeFile(policyFile, JSON.stringify(ROTATION_POLICY));
      const briefFile = path.join(t.cwd, "brief.md");
      const MISSION = "MISSION-MARKER-XYZ: read readme.txt when asked, otherwise reply exactly: ok";
      await fs.writeFile(briefFile, MISSION);

      const started = await runCliBlocking(t.binPath, t.env, [
        "start", "--cwd", t.cwd, "--policy", policyFile, "--brief", briefFile, "--name", "rotator",
      ]);
      expect(started.code).toBe(0);
      const gen1 = started.stdout.trim();
      console.log(`[rotation-lineage] gen1 (root, generation 1) = ${gen1}`);

      // NOTE (Task 12 addition): wait for the auto-queued bootstrap turn (from
      // --brief) to actually complete before sending anything else. `start`
      // only waits for the runner to be ready, not for that turn to finish, and
      // send_turn has no in-flight guard — it writes straight to B's stdin
      // regardless of whether a previous turn is still being processed. Sending
      // PAD 0 while bootstrap is still in flight risks interleaving two user
      // messages into one claude turn, which can permanently stall the
      // turn_completed count the loop below waits on. Confirmed via two real
      // runs that hung at exactly that wait until diagnostic replication
      // (which always waited here first) showed the mechanism works cleanly
      // once properly sequenced. This mirrors the wait already present before
      // gen2's own first send later in this file, and in rotation-recover.test.ts.
      await waitFor(t.clawDriveRoot, gen1, (evs) =>
        evs.filter((e) => e.kind === "turn_completed").length >= 1, 240_000);

      // Fill past the 35k threshold (bootstrap ~26k + 2 padded turns).
      //
      // NOTE (Task 12 deviation from the brief's literal padding(6000)): a single
      // padding(6000) call produces a ~300,000-byte string. Passed as one argv
      // element to runCliBlocking's spawn(), that exceeds Linux's kernel-enforced
      // MAX_ARG_STRLEN (32 * PAGE_SIZE = 131,072 bytes) for any single argument,
      // so the child process fails to spawn at all with `Error: spawn E2BIG` —
      // deterministic on every run, unrelated to claude/tokens (confirmed via a
      // real failed run + byte-length math). padding(2000) (~100,000 bytes) stays
      // safely under that ceiling. The total calibrated padding "mass" is
      // preserved by keeping the same 2-turn structure — this is a functional fix
      // for a hard OS limit, not a token-saving reduction: at roughly one token
      // per repeated word, ~20,000 tokens per turn still clears the 35k threshold
      // (bootstrap ~26k) several times over across the two turns.
      for (let i = 0; i < 2; i++) {
        const send = await runCliBlocking(t.binPath, t.env, [
          "send", gen1, `PAD ${i}: ignore the filler, reply exactly: ok. Filler: ${padding(2000)}`,
        ]);
        expect(send.code).toBe(0);
        await waitFor(t.clawDriveRoot, gen1, (evs) =>
          evs.filter((e) => e.kind === "turn_completed").length >= i + 2, 240_000);
      }
      await waitFor(t.clawDriveRoot, gen1, (evs) =>
        evs.some((e) => e.kind === "context_threshold_reached"), 30_000);

      // First rotation.
      const rot1 = await runCliBlocking(t.binPath, t.env, ["rotate", gen1]);
      expect(rot1.code).toBe(0);
      const gen2 = rot1.stdout.trim();
      expect(gen2).toMatch(/^sess_/);
      console.log(`[rotation-lineage] gen2 (generation 2, rotated_from ${gen1}) = ${gen2}`);

      const oldState = JSON.parse(
        await fs.readFile(path.join(t.clawDriveRoot, "sessions", gen1, "state.json"), "utf-8"));
      const newState = JSON.parse(
        await fs.readFile(path.join(t.clawDriveRoot, "sessions", gen2, "state.json"), "utf-8"));
      expect(oldState.rotated_to).toBe(gen2);
      expect(oldState.alias).toBeUndefined();
      expect(newState).toMatchObject({
        rotated_from: gen1, generation: 2, root_session_id: gen1, alias: "rotator",
      });
      // Verbatim mission + handover embedded in the successor's brief.
      expect(newState.scenario_brief).toContain(
        `=== ORIGINAL MISSION (verbatim) ===\n${MISSION}\n=== END ORIGINAL MISSION ===`);
      expect(newState.scenario_brief).toContain("## Next steps");
      const handover = await fs.readFile(
        path.join(t.clawDriveRoot, "sessions", gen1, "handover.md"), "utf-8");
      expect(handover).toContain("## Current objective");
      // session_rotated precedes session_stopped in the predecessor's log.
      //
      // NOTE (Task 12 deviation from the brief's literal eventsOf() read): teardown
      // is asynchronous — session_stopped only fires once the predecessor's claude
      // subprocess actually exits (teardownSession waits on the child's own 'exit'
      // event, with a 10s SIGTERM / 20s SIGKILL grace in the runner) — while the
      // `rotate` socket response returns immediately after session_rotated, before
      // the deferred teardown has necessarily run. A real run confirmed this:
      // session_rotated was present immediately after `rotate` returned,
      // session_stopped was not. Poll for it instead of assuming it's already
      // written, the same way this file already waits on other eventually-
      // consistent conditions (turn_completed, context_threshold_reached).
      const evs1 = await waitFor(t.clawDriveRoot, gen1, (evs) =>
        evs.some((e) => e.kind === "session_stopped"), 30_000);
      const rotSeq = evs1.find((e) => e.kind === "session_rotated")!.seq;
      const stopEv = evs1.find((e) => e.kind === "session_stopped")!;
      expect(rotSeq).toBeLessThan(stopEv.seq);
      expect((stopEv as { reason: string }).reason).toBe(`rotated:${gen2}`);

      // Successor is live and addressable by the bare alias; rotate it too.
      await waitFor(t.clawDriveRoot, gen2, (evs) =>
        evs.filter((e) => e.kind === "turn_completed").length >= 1, 240_000);
      // Same E2BIG fix as above — see the note at the first padding() call site.
      const send2 = await runCliBlocking(t.binPath, t.env, [
        "send", "rotator", `PAD again, reply exactly: ok. Filler: ${padding(2000)}`,
      ]);
      expect(send2.code).toBe(0);
      await waitFor(t.clawDriveRoot, gen2, (evs) =>
        evs.some((e) => e.kind === "context_threshold_reached"), 300_000);
      const rot2 = await runCliBlocking(t.binPath, t.env, ["rotate", "rotator"]);
      expect(rot2.code).toBe(0);
      const gen3 = rot2.stdout.trim();
      console.log(`[rotation-lineage] gen3 (generation 3, rotated_from ${gen2}) = ${gen3}`);
      const gen3State = JSON.parse(
        await fs.readFile(path.join(t.clawDriveRoot, "sessions", gen3, "state.json"), "utf-8"));
      expect(gen3State).toMatchObject({ generation: 3, root_session_id: gen1, rotated_from: gen2 });

      await runCliBlocking(t.binPath, t.env, ["stop", gen3]);
    } finally {
      await t.cleanup();
    }
  }, 1_800_000);
});
