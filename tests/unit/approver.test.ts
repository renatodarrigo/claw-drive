import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// bin/claw-drive-approver renders the runner's verdict as claude's
// hookSpecificOutput envelope. Driven here as claude drives it — bash, the
// PreToolUse payload on stdin, the session id as the argument, the session's
// control socket — against a fake runner on a real Unix socket. Needs a
// Unix-socket-capable nc (ncat or OpenBSD nc), as the script itself does.

const APPROVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "claw-drive-approver");
const SID = "sess_apprv01";

function which(tool: string): string {
  return spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
}
const BASH = which("bash");
const hasNc = which("ncat") !== "" || which("nc") !== "";

const PAYLOAD = JSON.stringify({
  session_id: "claude-sess",
  cwd: "/tmp/x",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
  tool_use_id: "toolu_1",
});

let root: string;
let server: net.Server | null = null;
let child: ChildProcess | null = null;
const sockets = new Set<net.Socket>();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "apprv-"));
  await fs.mkdir(path.join(root, "sessions", SID), { recursive: true });
});

afterEach(async () => {
  try {
    // A hung approver must not outlive the test: SIGKILL the bash's process
    // group (bash, the `$(...)` subshell and `head` — GNU `timeout` puts
    // itself and `nc` in their own group), then destroy the fake runner's
    // connections so `nc` reads EOF and `timeout` exits with it, and
    // server.close() does not wait on them.
    if (child !== null && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    child = null;
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function socketPath(): string {
  return path.join(root, "sessions", SID, "control.sock");
}

/** A fake runner: answers the first request line on the session socket with
 * reply(request) — a raw line, so a malformed reply can be modelled too —
 * and, like the real runner, leaves the connection open: the approver's own
 * `head -n1` is what ends its nc. */
async function fakeRunner(reply: (req: Record<string, unknown>) => string): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      seen.push(req);
      sock.write(reply(req) + "\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath(), () => resolve()));
  return seen;
}

function runApprover(env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    child = spawn(BASH, [APPROVER, SID], {
      env: { ...process.env, CLAW_DRIVE_HOME: root, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const proc = child;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    // stdio is the literal ["pipe","pipe","pipe"] above, so these streams are
    // never null; the assertions are needed only because `proc`'s type comes
    // from the module-level `ChildProcess | null` declaration, which widens
    // away spawn()'s more specific per-call return type.
    proc.stdout!.on("data", (c: Buffer) => out.push(c));
    proc.stderr!.on("data", (c: Buffer) => err.push(c));
    proc.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") })
    );
    proc.stdin!.end(PAYLOAD + "\n");
  });
}

interface Envelope {
  hookEventName: string;
  permissionDecision: string;
  permissionDecisionReason: string;
}

function envelope(stdout: string): Envelope {
  return (JSON.parse(stdout) as { hookSpecificOutput: Envelope }).hookSpecificOutput;
}

/** 200 KiB of awkward bytes: above Linux's 128 KiB per-argument cap, made of
 * the characters the deny channel was probed to carry (quotes, backslashes,
 * tabs, newlines, non-ASCII, braces, backticks). */
function bigReason(): string {
  const line = 'line "q" \\ \t {x} `y` é ü 日本\n';
  return line.repeat(Math.ceil((200 * 1024) / Buffer.byteLength(line)));
}

describe.skipIf(!hasNc)("bin/claw-drive-approver", () => {
  it("forwards the payload as approve_tool and renders a deny with a 200 KiB reason intact, exit 2", async () => {
    const reason = bigReason();
    expect(Buffer.byteLength(reason)).toBeGreaterThan(128 * 1024);
    const seen = await fakeRunner((req) => JSON.stringify({ id: req.id, ok: true, result: { behavior: "deny", message: reason } }));
    const r = await runApprover();
    expect(r.code).toBe(2);
    expect(envelope(r.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "approve_tool", pretooluse: JSON.parse(PAYLOAD) });
  });

  it("renders an allow with a 200 KiB reason intact, exit 0", async () => {
    const reason = bigReason();
    await fakeRunner((req) => JSON.stringify({ id: req.id, ok: true, result: { behavior: "allow", message: reason } }));
    const r = await runApprover();
    expect(r.code).toBe(0);
    expect(envelope(r.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason });
  });

  it("an allow without a reason says allowed", async () => {
    await fakeRunner((req) => JSON.stringify({ id: req.id, ok: true, result: { behavior: "allow" } }));
    const r = await runApprover();
    expect(r.code).toBe(0);
    expect(envelope(r.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "allowed" });
  });

  it("a deny without a reason says denied", async () => {
    await fakeRunner((req) => JSON.stringify({ id: req.id, ok: true, result: { behavior: "deny" } }));
    const r = await runApprover();
    expect(r.code).toBe(2);
    expect(envelope(r.stdout)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "denied" });
  });

  it("a runner error is rendered as a deny naming the code and message, exit 2", async () => {
    await fakeRunner((req) => JSON.stringify({ id: req.id, ok: false, error: "NOT_RUNNING", message: "session stopped" }));
    const r = await runApprover();
    expect(r.code).toBe(2);
    expect(envelope(r.stdout).permissionDecisionReason).toBe("approver: runner error NOT_RUNNING: session stopped");
  });

  it("a missing control socket is a deny, exit 2, before any connection", async () => {
    const r = await runApprover(); // no fake runner: no socket file
    expect(r.code).toBe(2);
    expect(envelope(r.stdout).permissionDecision).toBe("deny");
    expect(envelope(r.stdout).permissionDecisionReason).toContain("control socket missing");
  });

  it("a reply that is not JSON is a deny, exit 2, with an envelope on stdout", async () => {
    await fakeRunner(() => "not json at all");
    const r = await runApprover();
    expect(r.code).toBe(2);
    expect(envelope(r.stdout).permissionDecision).toBe("deny");
  });

  it("with jq missing from PATH the fallback envelope still denies, exit 2", async () => {
    await fakeRunner((req) => JSON.stringify({ id: req.id, ok: true, result: { behavior: "allow", message: "fine" } }));
    // A PATH holding everything the script needs except jq.
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    for (const tool of ["bash", "nc", "ncat", "timeout", "head", "cat", "date"]) {
      const found = which(tool);
      if (found !== "") await fs.symlink(found, path.join(bin, tool));
    }
    const r = await runApprover({ PATH: bin });
    expect(r.code).toBe(2);
    expect(envelope(r.stdout)).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "approver: internal failure — fail-secure deny",
    });
  });
});
