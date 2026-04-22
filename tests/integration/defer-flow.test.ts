import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("defer flow (integration)", () => {
  it("auto_defer → provide-output → B continues", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;

    const policy = {
      auto_defer: [
        { "tool": "Bash", "bash_command_matches": "^echo test-gate" },
      ],
      auto_approve: [{ tool: "Read" }],
      escalate_default: true,
      decision_timeout_seconds: 30,
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
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.stdout.trim();

    await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Use the Bash tool to run exactly `echo test-gate hello`. If you get an error, respond with a single line starting with 'GATE-ACK' and the message.",
    ]);

    // Wait for the deferred tool_decision_required event
    const eventDeadline = Date.now() + 60_000;
    let deferredCall: any = null;
    while (Date.now() < eventDeadline && !deferredCall) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      for (const l of tail.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(l);
        if (
          ev.kind === "tool_decision_required" &&
          ev.tool === "Bash" &&
          typeof ev.args?.command === "string" &&
          ev.args.command.startsWith("echo test-gate") &&
          ev.default_action === "defer"
        ) {
          deferredCall = ev;
          break;
        }
      }
      if (!deferredCall) await new Promise((r) => setTimeout(r, 500));
    }
    expect(deferredCall, "expected tool_decision_required with default_action=defer").not.toBeNull();

    // Provide the output — B should continue after seeing it
    const po = await runCliBlocking(sess.binPath, sess.env, [
      "provide-output",
      deferredCall.call_id,
      "--stdout",
      "test-gate hello",
      "--exit",
      "0",
      "--extra",
      "(ran by test harness)",
    ]);
    expect(po.code, po.stderr).toBe(0);
    const poResult = JSON.parse(po.stdout.trim());
    expect(poResult.ok).toBe(true);
    expect(poResult.result.turn_id).toMatch(/^turn_/);

    // Wait for turn_completed in the follow-up turn (turn_2).
    // The defer flow produces exactly ONE turn_completed: turn_1 is interrupted
    // when the Bash tool is denied (DEFERRED), and turn_2 is the injected
    // continuation turn. We need tool_output_provided + at least 1 turn_completed.
    const completeDeadline = Date.now() + 90_000;
    let completedCount = 0;
    let sawOutputProvided = false;
    while (Date.now() < completeDeadline && (!sawOutputProvided || completedCount < 1)) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      completedCount = 0;
      sawOutputProvided = false;
      for (const l of tail.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(l);
        if (ev.kind === "turn_completed") completedCount++;
        if (ev.kind === "tool_output_provided") sawOutputProvided = true;
      }
      if (!sawOutputProvided || completedCount < 1) await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawOutputProvided, "expected tool_output_provided event").toBe(true);
    expect(completedCount, "expected B to complete the follow-up turn").toBeGreaterThanOrEqual(1);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 300_000);
});
