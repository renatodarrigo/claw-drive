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
      // 10s gives claude time to stream the tool_use + hook to fire, yet keeps
      // the total test wall-time under 2 min. 3s was too aggressive — claude
      // sometimes hasn't reached the Bash call by then, and the test became
      // flaky for a reason unrelated to the timeout mechanism.
      decision_timeout_seconds: 10,
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
      "Use the Bash tool to run exactly `echo hello` and report the stdout. Do not use any other tool.",
    ]);

    // Wait for *either* tool_decision_required to show up (proves escalation
    // happened) OR the test deadline. Then wait for the timer.
    const escalationDeadline = Date.now() + 90_000;
    let sawRequired = false;
    while (Date.now() < escalationDeadline && !sawRequired) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      if (tail.stdout.includes('"kind":"tool_decision_required"')) sawRequired = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawRequired, "expected a tool_decision_required event to surface").toBe(true);

    // Now wait for the timeout resolver (escalate_default=true → default_action=approve)
    const timeoutDeadline = Date.now() + 30_000;
    let sawTimeout = false;
    while (Date.now() < timeoutDeadline && !sawTimeout) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      if (tail.stdout.includes('"resolved_by":"timeout"')) sawTimeout = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawTimeout, "expected a resolved_by:timeout event within the timer window").toBe(true);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 180_000);
});
