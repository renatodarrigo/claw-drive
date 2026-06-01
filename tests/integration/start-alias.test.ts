import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmpSession, runCliBlocking, type TmpSession } from "../helpers/tmp-session.js";

let cleanup: (() => Promise<void>) | null = null;
const started: { sess: TmpSession; id: string }[] = [];

afterEach(async () => {
  for (const s of started) {
    await runCliBlocking(s.sess.binPath, s.sess.env, ["stop", s.id]).catch(() => {});
  }
  started.length = 0;
  if (cleanup) await cleanup();
  cleanup = null;
});

async function readAlias(sess: TmpSession, id: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(sess.clawDriveRoot, "sessions", id, "state.json"), "utf-8");
  return JSON.parse(raw).alias;
}

/**
 * `stop` returns once the runner acknowledges the request, which can be a beat
 * before the runner process actually exits — until then it is still a LIVE
 * alias holder. Poll the state until the session is terminal so the reuse check
 * is deterministic (this models a human re-using an alias after a session ends).
 */
async function waitUntilStopped(sess: TmpSession, id: string, timeoutMs = 10_000): Promise<void> {
  const statePath = path.join(sess.clawDriveRoot, "sessions", id, "state.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = JSON.parse(await fs.readFile(statePath, "utf-8"));
      if (s.status === "stopped" || s.status === "failed") return;
    } catch {
      /* state momentarily unreadable */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startBypass(sess: TmpSession, extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const policyPath = `${sess.clawDriveRoot}/policy.json`;
  await fs.writeFile(policyPath, JSON.stringify("bypass"));
  return runCliBlocking(sess.binPath, sess.env, ["start", "--cwd", sess.cwd, "--policy", policyPath, ...extra]);
}

describe("start --name (alias persistence + validation, integration)", () => {
  it("persists a valid alias on state.json and still prints the canonical id", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const r = await startBypass(sess, ["--name", "reviewer"]);
    expect(r.code).toBe(0);
    const id = r.stdout.trim();
    started.push({ sess, id });
    expect(id.startsWith("sess_")).toBe(true);
    expect(await readAlias(sess, id)).toBe("reviewer");
  }, 30_000);

  it("rejects an invalid alias with a clear error and a non-zero exit (no runner spawned)", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const r = await startBypass(sess, ["--name", "1bad name"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/alias|name/);
  }, 30_000);

  it("rejects a sess_-prefixed alias", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const r = await startBypass(sess, ["--name", "sess_nope"]);
    expect(r.code).not.toBe(0);
  }, 30_000);

  it("rejects a duplicate live alias and names the conflicting session_id", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const first = await startBypass(sess, ["--name", "dup"]);
    expect(first.code).toBe(0);
    const firstId = first.stdout.trim();
    started.push({ sess, id: firstId });

    const second = await startBypass(sess, ["--name", "dup"]);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain(firstId); // names the conflict
  }, 45_000);

  it("frees the alias after the holder stops (reuse on a new session)", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const first = await startBypass(sess, ["--name", "recycle"]);
    expect(first.code).toBe(0);
    const firstId = first.stdout.trim();
    await runCliBlocking(sess.binPath, sess.env, ["stop", firstId]);
    await waitUntilStopped(sess, firstId);

    const second = await startBypass(sess, ["--name", "recycle"]);
    expect(second.code).toBe(0);
    const secondId = second.stdout.trim();
    started.push({ sess, id: secondId });
    expect(secondId).not.toBe(firstId);
    expect(await readAlias(sess, secondId)).toBe("recycle");
  }, 45_000);
});
