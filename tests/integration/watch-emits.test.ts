import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("claw-drive watch (integration)", () => {
  it("emits only noteworthy events and exits on session_stopped", async () => {
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

    // Start `claw-drive watch` as a subprocess. Pass --no-token-filter so the
    // v0.5.6 sentinel filter doesn't drop turn_completed events from B's
    // simple "reply with 'hi'" turn (no [TOKEN] appended). This test is about
    // watch's noise filtering, not the sentinel filter — that's covered in
    // tests/unit/watch-token-filter.test.ts.
    const watchProc = spawn(sess.binPath, ["watch", sessionId, "--no-token-filter"], { env: sess.env });
    const lines: string[] = [];
    watchProc.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split("\n").filter(Boolean)) {
        lines.push(line);
      }
    });

    // Drive B through a simple turn
    await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Reply with only 'hi'.",
    ]);

    // Wait for watch to emit turn_completed
    const completeDeadline = Date.now() + 60_000;
    while (Date.now() < completeDeadline) {
      if (lines.some((l) => JSON.parse(l).kind === "turn_completed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Stop the session — watch should exit on session_stopped
    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);

    // Wait for watch to exit
    const exited = await new Promise<{ code: number | null }>((resolve) => {
      const timer = setTimeout(() => {
        watchProc.kill("SIGTERM");
        resolve({ code: null });
      }, 15_000);
      watchProc.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
    expect(exited.code, "expected watch to exit cleanly on session_stopped").toBe(0);

    // Parse all emitted events
    const events = lines.map((l) => JSON.parse(l));

    // Must contain at least: turn_completed + session_stopped
    expect(events.some((e) => e.kind === "turn_completed")).toBe(true);
    expect(events.some((e) => e.kind === "session_stopped")).toBe(true);

    // Must NOT contain: assistant_text, thinking, tool_call_requested, session_started
    for (const noise of ["assistant_text", "thinking", "tool_call_requested", "session_started", "turn_started"]) {
      expect(events.some((e) => e.kind === noise), `watch should drop ${noise}`).toBe(false);
    }
  }, 120_000);
});
