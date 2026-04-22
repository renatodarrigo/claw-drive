import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("decision timeout (integration)", () => {
  it("default_action fires after decision_timeout_seconds", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;

    const policy = {
      auto_approve: [{ tool: "Read" }],
      escalate_default: true,
      decision_timeout_seconds: 3,
    };
    const policyPath = `${sess.clawDriveRoot}/policy.json`;
    await fs.writeFile(policyPath, JSON.stringify(policy));

    const start = await runCliBlocking(sess.binPath, sess.env, [
      "start",
      "--cwd",
      sess.cwd,
      "--policy",
      policyPath,
    ]);
    const sessionId = start.stdout.trim();

    await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Run `echo hello`. One bash call, then reply 'done'.",
    ]);

    // Don't approve; wait for timeout to fire (escalate_default=true → default_action=approve)
    const deadline = Date.now() + 60_000;
    let sawTimeout = false;
    while (Date.now() < deadline && !sawTimeout) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      if (tail.stdout.includes('"resolved_by":"timeout"')) sawTimeout = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawTimeout).toBe(true);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 90_000);
});
