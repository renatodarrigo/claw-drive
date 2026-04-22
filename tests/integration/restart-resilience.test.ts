import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("restart resilience (integration)", () => {
  it("runner survives simulated caller restart (fresh CLI invocations)", async () => {
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
    expect(start.code).toBe(0);
    const sessionId = start.stdout.trim();

    await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Reply with only the word 'done'.",
    ]);

    // Each CLI invocation is a fresh process — the runner is already detached.
    // Use sessions + tail from separate invocations to prove state persists.
    const list = await runCliBlocking(sess.binPath, sess.env, ["sessions"]);
    expect(list.stdout).toContain(sessionId);

    const deadline = Date.now() + 60_000;
    let completed = false;
    while (Date.now() < deadline && !completed) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      if (tail.stdout.includes('"kind":"turn_completed"')) completed = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(completed).toBe(true);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 90_000);
});
