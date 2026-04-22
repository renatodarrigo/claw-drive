import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("b crash (integration)", () => {
  it("interrupt signals B, session returns valid state JSON", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const policyPath = `${sess.clawDriveRoot}/policy.json`;
    await fs.writeFile(policyPath, JSON.stringify("bypass"));

    const start = await runCliBlocking(sess.binPath, sess.env, [
      "start",
      "--cwd",
      sess.cwd,
      "--policy",
      policyPath,
    ]);
    const sessionId = start.stdout.trim();

    const send = await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Count slowly from 1 to 10, one number per sentence. Take your time.",
    ]);
    const { turn_id } = JSON.parse(send.stdout.trim());
    await new Promise((r) => setTimeout(r, 2000));
    await runCliBlocking(sess.binPath, sess.env, ["interrupt", sessionId, turn_id]);
    await new Promise((r) => setTimeout(r, 3000));

    const show = await runCliBlocking(sess.binPath, sess.env, ["show", sessionId]);
    // Output format is JSON state then a divider + events. Parse the first JSON blob.
    const firstBrace = show.stdout.indexOf("{");
    const jsonEnd = show.stdout.indexOf("\n=== last 20 events ===");
    const stateJson = show.stdout.slice(firstBrace, jsonEnd > 0 ? jsonEnd : undefined);
    const parsed = JSON.parse(stateJson);
    expect(parsed.session_id).toBe(sessionId);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 60_000);
});
