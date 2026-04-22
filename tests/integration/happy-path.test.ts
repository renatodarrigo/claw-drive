import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("happy path (integration)", () => {
  it("start → send → turn_completed → stop", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;

    // Bypass policy for simplicity
    const policyPath = `${sess.clawDriveRoot}/policy.json`;
    await fs.writeFile(policyPath, JSON.stringify("bypass"));

    const start = await runCliBlocking(sess.binPath, sess.env, [
      "start",
      "--cwd",
      sess.cwd,
      "--policy",
      policyPath,
    ]);
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.stdout.trim();
    expect(sessionId).toMatch(/^sess_/);

    // Send a simple turn that needs no tools
    const send = await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Reply with only the single word 'pong'.",
    ]);
    expect(send.code, send.stderr).toBe(0);
    const sendResult = JSON.parse(send.stdout.trim());
    expect(sendResult.turn_id).toMatch(/^turn_/);

    // Poll tail until turn_completed (60s budget)
    const deadline = Date.now() + 60_000;
    let completed = false;
    while (Date.now() < deadline && !completed) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      for (const line of tail.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(line);
        if (ev.kind === "turn_completed") {
          completed = true;
          break;
        }
      }
      if (!completed) await new Promise((r) => setTimeout(r, 500));
    }
    expect(completed).toBe(true);

    // Stop
    const stop = await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
    expect(stop.code, stop.stderr).toBe(0);
  }, 90_000);
});
