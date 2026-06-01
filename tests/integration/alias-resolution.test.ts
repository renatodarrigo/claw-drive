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

async function startNamed(sess: TmpSession, name: string): Promise<string> {
  const policyPath = `${sess.clawDriveRoot}/policy.json`;
  await fs.writeFile(policyPath, JSON.stringify("bypass"));
  const r = await runCliBlocking(sess.binPath, sess.env, [
    "start", "--cwd", sess.cwd, "--policy", policyPath, "--name", name,
  ]);
  expect(r.code, r.stderr).toBe(0);
  const id = r.stdout.trim();
  started.push({ sess, id });
  return id;
}

describe("alias resolution at session-arg call sites (integration)", () => {
  it("a CLI command (show) accepts both the canonical id and the live alias", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const id = await startNamed(sess, "alpha");

    const byId = await runCliBlocking(sess.binPath, sess.env, ["show", id]);
    expect(byId.code).toBe(0);
    expect(byId.stdout).toContain(id);

    const byAlias = await runCliBlocking(sess.binPath, sess.env, ["show", "alpha"]);
    expect(byAlias.code).toBe(0);
    expect(byAlias.stdout).toContain(id); // resolved to the same canonical session
  }, 30_000);

  it("an unresolvable ref yields a clear 'no live session' error and non-zero exit", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const r = await runCliBlocking(sess.binPath, sess.env, ["show", "ghostly"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no live session");
  }, 20_000);

  it("an MCP tool (poll_session) accepts the live alias and resolves to the same session", async () => {
    const sess = await makeTmpSession();
    cleanup = sess.cleanup;
    const id = await startNamed(sess, "bravo");

    // Drive poll_session over the MCP stdio server with the alias as session_id.
    const req =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "poll_session", arguments: { session_id: "bravo", wait_ms: 0 } },
      }) + "\n";
    const res = await runMcpCall(sess, req);
    // The tool returns ok with an events/session_status payload — not a
    // SESSION_NOT_FOUND error — proving the alias resolved.
    expect(res).not.toContain("SESSION_NOT_FOUND");
    expect(res).toContain("session_status");
  }, 30_000);
});

/**
 * Send a single JSON-RPC line to `claw-drive mcp` over stdio and return the
 * concatenated stdout. The server stays up on stdin EOF-less close, so we end
 * stdin after writing and collect until exit.
 */
import { spawn } from "node:child_process";
function runMcpCall(sess: TmpSession, requestLine: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(sess.binPath, ["mcp"], { env: sess.env });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("exit", () => resolve(out));
    // initialize handshake then the call; many MCP servers require initialize first.
    const init =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n";
    child.stdin.write(init);
    child.stdin.write(requestLine);
    // Give the server a moment to answer, then close.
    setTimeout(() => child.stdin.end(), 1500);
    setTimeout(() => child.kill(), 6000);
  });
}
