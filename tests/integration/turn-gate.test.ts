import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpSession, runCliBlocking, type TmpSession } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

type Ev = { kind: string; turn_id?: string; [k: string]: unknown };

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

describe("turn gate (integration)", () => {
  it("a send while a turn runs is refused; the retry at the boundary starts turn_2 with turn_1 fully attributed", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const policyPath = `${sess.clawDriveRoot}/policy.json`;
    await fs.writeFile(policyPath, JSON.stringify("bypass"));

    const start = await runCliBlocking(sess.binPath, sess.env, ["start", "--cwd", sess.cwd, "--policy", policyPath]);
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.stdout.trim();

    // Turn 1: a loop-shaped ~10 s wait (claude 2.1.28x's Bash guard blocks a standalone `sleep`).
    const first = await runCliBlocking(sess.binPath, sess.env, [
      "send",
      sessionId,
      'Run this exact Bash command in the foreground and nothing else: i=0; until [ "$i" -ge 10 ]; do sleep 1; i=$((i+1)); done; echo waited-10s. Then reply with the single line `first done`.',
    ]);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout.trim()).turn_id).toBe("turn_1");

    // The latch is set at acceptance, so this second send is refused before B has even started its tool.
    const second = await runCliBlocking(sess.binPath, sess.env, ["send", sessionId, "second message"]);
    expect(second.code).toBe(1);
    const refusal = JSON.parse(second.stderr.trim());
    expect(refusal).toMatchObject({ ok: false, error: "TURN_IN_FLIGHT" });
    expect(refusal.message).toContain("turn_1 is in flight");

    // At the boundary the retry is accepted as turn_2.
    const afterFirst = await waitFor(sess, sessionId, (all) => all.some((e) => e.kind === "turn_completed" && e.turn_id === "turn_1"), 90_000);
    expect(afterFirst.some((e) => e.kind === "turn_completed" && e.turn_id === "turn_1"), "turn_1 never completed").toBe(true);
    const third = await runCliBlocking(sess.binPath, sess.env, ["send", sessionId, "Reply with the single line `second done`."]);
    expect(third.code, third.stderr).toBe(0);
    expect(JSON.parse(third.stdout.trim()).turn_id).toBe("turn_2");

    // Attribution: every turn_1 event precedes turn_2's turn_started, turn_1 has exactly one terminal event, nothing is turn_unknown.
    const all = await waitFor(sess, sessionId, (evs) => evs.some((e) => e.kind === "turn_completed" && e.turn_id === "turn_2"), 90_000);
    const startedIdx = all.findIndex((e) => e.kind === "turn_started" && e.turn_id === "turn_2");
    expect(startedIdx).toBeGreaterThan(0);
    all.forEach((e, i) => {
      if (e.turn_id === "turn_1") expect(i, `${e.kind} of turn_1 landed after turn_2 started`).toBeLessThan(startedIdx);
    });
    expect(all.filter((e) => e.turn_id === "turn_1" && (e.kind === "turn_completed" || e.kind === "turn_failed"))).toHaveLength(1);
    expect(all.some((e) => e.turn_id === "turn_unknown")).toBe(false);

    await runCliBlocking(sess.binPath, sess.env, ["stop", sessionId]);
  }, 300_000);
});
