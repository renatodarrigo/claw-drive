import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking, type TmpSession } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

type Ev = { kind: string; turn_id?: string; call_id?: string; tool?: string; args?: { command?: string }; result?: unknown; [k: string]: unknown };

async function events(sess: TmpSession, sessionId: string): Promise<Ev[]> {
  const tail = await runCliBlocking(sess.binPath, sess.env, ["tail", sessionId]);
  return tail.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
}

async function waitFor(sess: TmpSession, sessionId: string, pred: (all: Ev[]) => boolean, ms: number): Promise<Ev[]> {
  const deadline = Date.now() + ms;
  let all: Ev[] = [];
  while (Date.now() < deadline) {
    all = await events(sess, sessionId);
    if (pred(all)) return all;
    await new Promise((r) => setTimeout(r, 500));
  }
  return all;
}

describe("pending call output through the hook (integration)", () => {
  it("provide-output on a still-paused call delivers the output as the call's own result inside turn_1", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    // Escalate everything: B's echo pauses in the hook instead of being auto-deferred.
    const policy = { auto_approve: [], auto_defer: [], auto_reject: [], escalate_default: true, decision_timeout_seconds: 120 };
    const policyPath = `${sess.clawDriveRoot}/policy.json`;
    await fs.writeFile(policyPath, JSON.stringify(policy));

    const start = await runCliBlocking(sess.binPath, sess.env, ["start", "--cwd", sess.cwd, "--policy", policyPath]);
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.stdout.trim();

    const send = await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      "Run the Bash tool exactly once with the command `echo probe` (no other tool calls). The call will be answered by a hook; you will receive text instead of the echo's normal output. Do not retry it. Then reply with the single line `RESULT: ` followed by the first line of the text you received.",
    ]);
    expect(send.code, send.stderr).toBe(0);

    const paused = await waitFor(
      sess, sessionId,
      (all) => all.some((e) => e.kind === "tool_decision_required" && e.tool === "Bash" && (e.args?.command ?? "").startsWith("echo probe")),
      60_000
    );
    const pending = paused.find((e) => e.kind === "tool_decision_required" && e.tool === "Bash" && (e.args?.command ?? "").startsWith("echo probe"));
    expect(pending, "expected the escalated echo to pause").toBeDefined();
    const callId = pending!.call_id as string;

    // Answer while the call is still paused.
    const po = await runCliBlocking(sess.binPath, sess.env, ["provide-output", callId, "--stdout", "gate-answer", "--exit", "0"]);
    expect(po.code, po.stderr).toBe(0);
    const result = JSON.parse(po.stdout.trim());
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ turn_id: "turn_1", via: "hook" });

    const all = await waitFor(sess, sessionId, (evs) => evs.some((e) => e.kind === "turn_completed" && e.turn_id === "turn_1"), 90_000);
    expect(all.filter((e) => e.kind === "turn_started")).toHaveLength(1);
    expect(all.filter((e) => e.kind === "turn_completed")).toHaveLength(1);
    expect(all.find((e) => e.kind === "tool_output_provided")).toMatchObject({ turn_id: "turn_1", call_id: callId });
    expect(all.find((e) => e.kind === "tool_decision_resolved" && e.call_id === callId)).toMatchObject({
      turn_id: "turn_1", action: "defer", resolved_by: "user_mcp_auto",
    });
    const toolResult = all.find((e) => e.kind === "tool_call_result" && e.call_id === callId);
    expect(toolResult, "expected the call's own tool_result to carry the output").toBeDefined();
    expect(JSON.stringify(toolResult!.result)).toContain("gate-answer");
    expect(all.every((e) => e.turn_id === undefined || e.turn_id === "turn_1")).toBe(true);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 300_000);
});
