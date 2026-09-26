import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("defer flow (integration)", () => {
  it("auto_defer pauses → defer releases → provide-output at the boundary → B continues", async () => {
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

    // The call is paused for a decision (an auto_defer match escalates with a
    // defer default). Release it explicitly: the hook gets the DEFERRED
    // denial, B continues and — told to wait for a follow-up turn — ends
    // turn_1. The output turn can only start at that boundary (a send
    // mid-turn is refused).
    const released = await runCliBlocking(sess.binPath, sess.env, [
      "defer",
      deferredCall.call_id,
      "--reason",
      "the test harness runs it locally",
    ]);
    expect(released.code, released.stderr).toBe(0);

    const boundaryDeadline = Date.now() + 90_000;
    let firstDone = false;
    while (Date.now() < boundaryDeadline && !firstDone) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      firstDone = tail.stdout
        .split("\n")
        .filter(Boolean)
        .some((l) => {
          const ev = JSON.parse(l);
          return ev.kind === "turn_completed" && ev.turn_id === "turn_1";
        });
      if (!firstDone) await new Promise((r) => setTimeout(r, 500));
    }
    expect(firstDone, "expected turn_1 to complete after the DEFERRED denial").toBe(true);

    // Provide the output — it goes in as turn_2 and B continues.
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
    expect(poResult.result).toEqual({ turn_id: "turn_2", via: "turn" });

    // Two completions, each stamped on its own turn, plus the audit event.
    const completeDeadline = Date.now() + 90_000;
    let completedTurns: string[] = [];
    let sawOutputProvided = false;
    while (Date.now() < completeDeadline && (!sawOutputProvided || completedTurns.length < 2)) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      completedTurns = [];
      sawOutputProvided = false;
      for (const l of tail.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(l);
        if (ev.kind === "turn_completed") completedTurns.push(ev.turn_id);
        if (ev.kind === "tool_output_provided") sawOutputProvided = true;
      }
      if (!sawOutputProvided || completedTurns.length < 2) await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawOutputProvided, "expected tool_output_provided event").toBe(true);
    expect(completedTurns, "expected turn_1 and turn_2 to complete on their own ids").toEqual(["turn_1", "turn_2"]);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 300_000);
});
