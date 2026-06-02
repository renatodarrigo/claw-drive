import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { makeTmpSession, type TmpSession } from "../helpers/tmp-session.js";

/**
 * Regression test for the MCP `start_session` / `update_policy` bug where a
 * `policy` argument arriving as a JSON STRING (some clients serialize the
 * untyped object param in transit) was rejected with
 * "policy must be 'bypass' or an object". The server now coerces a JSON-string
 * policy into an object before validating.
 *
 * We pass an INVALID string policy so validation rejects it BEFORE a runner is
 * spawned (cheap — no real claude). The rejection MESSAGE is the proof: an
 * "unknown key '...'" error is only reachable once the string has been parsed
 * into an object. The pre-fix code would have said the policy "must be 'bypass'
 * or an object" because it never parsed the string.
 */
function runMcpCall(sess: TmpSession, requestLine: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(sess.binPath, ["mcp"], { env: sess.env });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("exit", () => resolve(out));
    const init =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n";
    child.stdin.write(init);
    child.stdin.write(requestLine);
    setTimeout(() => child.stdin.end(), 1500);
    setTimeout(() => child.kill(), 6000);
  });
}

describe("MCP start_session accepts a JSON-string policy", () => {
  let sess: TmpSession;
  afterEach(async () => {
    if (sess) await sess.cleanup();
  });

  it("parses a stringified policy before validating (regression)", async () => {
    sess = await makeTmpSession();
    const req =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "start_session",
          arguments: { cwd: sess.cwd, policy: '{"bogus_key":1}' },
        },
      }) + "\n";
    const out = await runMcpCall(sess, req);
    // The stringified policy was parsed into an object, then validated:
    expect(out).toContain("unknown key 'bogus_key'");
    // ...not rejected as a non-object, which was the pre-fix behaviour:
    expect(out).not.toContain("must be 'bypass' or an object");
  });
});
