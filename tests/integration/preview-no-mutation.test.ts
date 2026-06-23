import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe("approve --preview (integration)", () => {
  it("prints the derived rule and does NOT mutate state.json policy", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;

    const policy = { auto_approve: [{ tool: "Read" }], escalate_default: true, decision_timeout_seconds: 60 };
    const policyPath = `${sess.clawDriveRoot}/policy.json`;
    await fs.writeFile(policyPath, JSON.stringify(policy));

    const start = await runCliBlocking(sess.binPath, sess.env, ["start", "--cwd", sess.cwd, "--policy", policyPath]);
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.stdout.trim();

    await runCliBlocking(sess.binPath, sess.env, [
      "send", sessionId,
      "Use the Bash tool to run exactly `echo hello-preview`. If the tool returns an error, respond with a single line starting with 'ACK' and stop.",
    ]);

    const deadline = Date.now() + 60_000;
    let callId: string | null = null;
    while (Date.now() < deadline && !callId) {
      const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
      for (const l of tail.stdout.split("\n").filter(Boolean)) {
        const ev = JSON.parse(l);
        if (ev.kind === "tool_decision_required" && ev.tool === "Bash" &&
            typeof ev.args?.command === "string" && ev.args.command.includes("echo hello-preview")) {
          callId = ev.call_id; break;
        }
      }
      if (!callId) await new Promise((r) => setTimeout(r, 500));
    }
    expect(callId, "never saw tool_decision_required").toBeTruthy();

    const preview = await runCliBlocking(sess.binPath, sess.env, ["approve", callId!, "--preview"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("would remember → auto_approve");
    expect(preview.stdout).toContain("[derived]");

    await new Promise((r) => setTimeout(r, 500));
    const stateJson = JSON.parse(
      await fs.readFile(`${sess.clawDriveRoot}/sessions/${sessionId}/state.json`, "utf-8")
    );
    const approveList = (stateJson.policy?.auto_approve ?? []) as Array<Record<string, unknown>>;
    const leaked = approveList.find(
      (r) => typeof r.bash_command_matches === "string" && (r.bash_command_matches as string).startsWith("^echo ")
    );
    expect(leaked, `preview must not append a rule; got ${JSON.stringify(approveList)}`).toBeFalsy();

    // The call is still pending — a real --remember now appends it.
    const real = await runCliBlocking(sess.binPath, sess.env, ["approve", callId!, "--remember"]);
    expect(real.code, real.stderr).toBe(0);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 120_000);
});
