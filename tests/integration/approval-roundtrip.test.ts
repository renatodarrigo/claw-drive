import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("approval roundtrip (integration)", () => {
  it("escalate Bash → pending → approve → B proceeds", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;

    const policy = {
      auto_approve: [{ tool: "Read" }],
      escalate_default: true,
      decision_timeout_seconds: 60,
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
    expect(start.code).toBe(0);
    const sessionId = start.stdout.trim();

    await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Run `echo hello-from-hook` with the Bash tool. Report stdout.",
    ]);

    // Poll for pending approval
    const deadline = Date.now() + 60_000;
    let pending: any = null;
    while (Date.now() < deadline && !pending) {
      const pend = await runCliBlocking(sess.binPath, sess.env, ["pending", sessionId]);
      for (const l of pend.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(l);
        if (ev.kind === "tool_decision_required" && ev.tool === "Bash") {
          pending = ev;
          break;
        }
      }
      if (!pending) await new Promise((r) => setTimeout(r, 500));
    }
    expect(pending).not.toBeNull();

    // Approve
    const ap = await runCliBlocking(sess.binPath, sess.env, [
      "approve",
      pending.call_id,
      "--reason",
      "test",
    ]);
    expect(ap.code).toBe(0);

    // Wait for turn_completed
    const deadline2 = Date.now() + 60_000;
    let completed = false;
    while (Date.now() < deadline2 && !completed) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      if (tail.stdout.includes('"kind":"turn_completed"')) completed = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(completed).toBe(true);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 180_000);
});
