import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cmdStart } from "../../src/cli/commands/start.js";
import { handleStartSession } from "../../src/mcp/server.js";
import { MCP_TOOL_DEFS } from "../../src/mcp/tool-defs.js";
import { statePath } from "../../src/lib/paths.js";
import { readState } from "../../src/lib/state.js";

// Both start paths scaffold a session dir and spawn CLAW_DRIVE_BIN as the
// runner. A stub runner that only touches the ready marker lets the real
// cmdStart / handleStartSession run end-to-end (recover.test.ts precedent).

const ENV_KEYS = ["CLAW_DRIVE_HOME", "CLAW_DRIVE_BIN", "CLAW_DRIVE_FLEET", "CLAUDE_CODE_SESSION_ID"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let home: string;
let cwd: string;
let stubDir: string;

const MCP_TAG_MESSAGE =
  "fleet must be 1-64 chars of letters, digits, '_', '.', '-' and start with a letter or digit";

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd-start-fleet-"));
  process.env.CLAW_DRIVE_HOME = home;
  // cwd must live inside $HOME (paths.isInsideHome) — the integration harness convention.
  const parent = path.join(os.homedir(), "tmp", "claw-drive-ut");
  await fs.mkdir(parent, { recursive: true });
  cwd = await fs.mkdtemp(path.join(parent, "cwd-"));
  stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "cd-start-stub-"));
  const stub = path.join(stubDir, "fake-runner");
  await fs.writeFile(stub, '#!/bin/sh\ntouch "$CLAW_DRIVE_HOME/sessions/$2/ready"\n', { mode: 0o755 });
  await fs.chmod(stub, 0o755);
  process.env.CLAW_DRIVE_BIN = stub;
  delete process.env.CLAW_DRIVE_FLEET;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(stubDir, { recursive: true, force: true });
});

async function start(argv: string[]): Promise<{ code: number; id: string | undefined; errors: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const code = await cmdStart(argv);
  const id = log.mock.calls.flat().find((a) => typeof a === "string" && a.startsWith("sess_")) as string | undefined;
  return { code, id, errors: errSpy.mock.calls.flat().join("\n") };
}

function body(res: unknown): Record<string, unknown> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;
}

describe("claw-drive start — fleet stamp", () => {
  it("stamps an explicit --fleet", async () => {
    const r = await start(["--cwd", cwd, "--fleet", "team-a"]);
    expect(r.code).toBe(0);
    expect((await readState(statePath(r.id!)))?.fleet).toBe("team-a");
  });

  it("defaults to CLAUDE_CODE_SESSION_ID, and CLAW_DRIVE_FLEET beats it", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "f141e77b-1c83-49b8-8aa8-eb80c5cc5424";
    const r1 = await start(["--cwd", cwd]);
    expect((await readState(statePath(r1.id!)))?.fleet).toBe("f141e77b-1c83-49b8-8aa8-eb80c5cc5424");
    process.env.CLAW_DRIVE_FLEET = "team-b";
    const r2 = await start(["--cwd", cwd]);
    expect((await readState(statePath(r2.id!)))?.fleet).toBe("team-b");
  });

  it("with no identity the session is unowned (no fleet key)", async () => {
    const r = await start(["--cwd", cwd]);
    expect(r.code).toBe(0);
    expect(await readState(statePath(r.id!))).not.toHaveProperty("fleet");
  });

  it("rejects an invalid tag and --all-fleets with exit 2, creating nothing", async () => {
    const bad = await start(["--cwd", cwd, "--fleet", "-x"]);
    expect(bad.code).toBe(2);
    expect(bad.errors).toContain("invalid --fleet '-x'");
    const widened = await start(["--cwd", cwd, "--all-fleets"]);
    expect(widened.code).toBe(2);
    expect(widened.errors).toContain("--all-fleets is not a start flag");
    expect(await fs.readdir(path.join(home, "sessions")).catch(() => [])).toEqual([]);
  });
});

describe("start_session — fleet input + response field (MCP)", () => {
  it("stamps an explicit fleet and echoes it in the response", async () => {
    const res = body(await handleStartSession({ cwd, fleet: "team-a" }));
    expect(res.fleet).toBe("team-a");
    expect((await readState(statePath(res.session_id as string)))?.fleet).toBe("team-a");
  });

  it("defaults to the server process's env and omits the field when unowned", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "abc-123";
    const tagged = body(await handleStartSession({ cwd }));
    expect(tagged.fleet).toBe("abc-123");
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const unowned = body(await handleStartSession({ cwd }));
    expect(unowned).not.toHaveProperty("fleet");
    expect(unowned.session_id).toMatch(/^sess_/);
  });

  it("BAD_REQUEST on an invalid fleet, creating nothing", async () => {
    const res = await handleStartSession({ cwd, fleet: "-x" });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(body(res)).toEqual({ error: "BAD_REQUEST", message: MCP_TAG_MESSAGE });
    expect(await fs.readdir(path.join(home, "sessions")).catch(() => [])).toEqual([]);
  });

  it("the start_session tool-def exposes an optional fleet string input", () => {
    const def = MCP_TOOL_DEFS.find((t) => t.name === "start_session")!;
    const schema = def.inputSchema as { properties: Record<string, { type?: string }>; required: string[] };
    expect(schema.properties.fleet.type).toBe("string");
    expect(schema.required).toEqual(["cwd"]);
  });
});
