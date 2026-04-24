import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("defer + remember_as_policy (integration)", () => {
  it("resolve defer --remember appends to auto_defer in state.json", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;

    // Policy that escalates everything so the first Bash call pauses.
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
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.stdout.trim();

    await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Use the Bash tool to run exactly `echo hello-remember`. If the tool returns an error, respond with a single line starting with 'ACK' and stop.",
    ]);

    const deadline = Date.now() + 60_000;
    let callId: string | null = null;
    while (Date.now() < deadline && !callId) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      for (const l of tail.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(l);
        if (
          ev.kind === "tool_decision_required" &&
          ev.tool === "Bash" &&
          typeof ev.args?.command === "string" &&
          ev.args.command.includes("echo hello-remember")
        ) {
          callId = ev.call_id;
          break;
        }
      }
      if (!callId) await new Promise((r) => setTimeout(r, 500));
    }
    expect(callId, "never saw tool_decision_required for our command").toBeTruthy();

    const resolve = await runCliBlocking(sess.binPath, sess.env, [
      "defer",
      callId!,
      "--remember",
      "--reason",
      "remember-defer integration",
    ]);
    expect(resolve.code, resolve.stderr).toBe(0);

    // Wait a beat so the runner flushes the updated policy to state.json.
    await new Promise((r) => setTimeout(r, 500));

    const stateJson = JSON.parse(
      await fs.readFile(`${sess.clawDriveRoot}/sessions/${sessionId}/state.json`, "utf-8")
    );
    const deferList = (stateJson.policy?.auto_defer ?? []) as Array<Record<string, unknown>>;
    const match = deferList.find(
      (r) =>
        r.tool === "Bash" &&
        typeof r.bash_command_matches === "string" &&
        (r.bash_command_matches as string).startsWith("^echo ")
    );
    expect(
      match,
      `expected remembered Bash rule in auto_defer; got ${JSON.stringify(deferList)}`
    ).toBeTruthy();
    expect((match as any).name).toMatch(/remembered: defer echo/);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 120_000);
});
