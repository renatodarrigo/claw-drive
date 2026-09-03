import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as net from "node:net";
import { handleListSessions, handleResolveToolCall, handleStartSession } from "../../src/mcp/server.js";
import { MCP_TOOL_DEFS } from "../../src/mcp/tool-defs.js";
import { startSocketServer } from "../../src/runner/socket-server.js";
import { sessionDir, statePath, socketPath } from "../../src/lib/paths.js";
import type { ControlRequest, ControlResponse } from "../../src/lib/socket-protocol.js";

let home: string;
const servers: net.Server[] = [];
const ENV_KEYS = ["CLAW_DRIVE_HOME", "CLAW_DRIVE_FLEET", "CLAUDE_CODE_SESSION_ID"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const MCP_TAG_MESSAGE =
  "fleet must be 1-64 chars of letters, digits, '_', '.', '-' and start with a letter or digit";

function body(res: unknown): Record<string, any> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

async function writeSession(id: string, over: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(sessionDir(id), { recursive: true });
  await fs.writeFile(
    statePath(id),
    JSON.stringify({
      session_id: id, status: "running", cwd: "/tmp/x", policy: "bypass",
      decision_timeout_seconds: 3600, model: null, runner_pid: process.pid,
      started_at: "2026-09-02T00:00:00Z", last_event_at: null, turns: 0,
      exit_code: null, exit_reason: null, ...over,
    })
  );
}

async function holdCall(id: string, callId: string): Promise<void> {
  const handler = async (req: ControlRequest): Promise<ControlResponse> =>
    (req as { call_id?: string }).call_id === callId
      ? { id: req.id, ok: true, result: { ok: true } }
      : { id: req.id, ok: false, error: "NOT_PENDING", message: "no such call" };
  servers.push(await startSocketServer(socketPath(id), handler));
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd-mcp-fleet-"));
  process.env.CLAW_DRIVE_HOME = home;
  process.env.CLAW_DRIVE_FLEET = "team-a";
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("list_sessions — fleet view", () => {
  beforeEach(async () => {
    await writeSession("sess_own", { fleet: "team-a" });
    await writeSession("sess_other", { fleet: "team-b" });
    await writeSession("sess_free");
  });

  it("returns own + untagged rows (with fleet when set) and hidden_in_other_fleets", async () => {
    const res = body(await handleListSessions({}));
    expect(res.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(["sess_free", "sess_own"]);
    expect(res.sessions[1].fleet).toBe("team-a");
    expect(res.sessions[0]).not.toHaveProperty("fleet");
    expect(res.hidden_in_other_fleets).toBe(1);
  });

  it("all_fleets returns everyone and omits the hidden count; fleet acts as another fleet", async () => {
    const all = body(await handleListSessions({ all_fleets: true }));
    expect(all.sessions).toHaveLength(3);
    expect(all).not.toHaveProperty("hidden_in_other_fleets");
    const asB = body(await handleListSessions({ fleet: "team-b" }));
    expect(asB.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(["sess_free", "sess_other"]);
  });

  it("the hidden count honors include_orphaned (only rows the rule would have shown count)", async () => {
    await writeSession("sess_other_dead", { fleet: "team-b", runner_pid: 999_999_999 });
    expect(body(await handleListSessions({})).hidden_in_other_fleets).toBe(2);
    expect(body(await handleListSessions({ include_orphaned: false })).hidden_in_other_fleets).toBe(1);
  });

  it("BAD_REQUEST on an invalid fleet, a non-boolean all_fleets, or both inputs together", async () => {
    expect(body(await handleListSessions({ fleet: "-x" }))).toEqual({ error: "BAD_REQUEST", message: MCP_TAG_MESSAGE });
    expect(body(await handleListSessions({ all_fleets: "yes" }))).toEqual({ error: "BAD_REQUEST", message: "all_fleets must be a boolean" });
    expect(body(await handleListSessions({ fleet: "team-b", all_fleets: true }))).toEqual({
      error: "BAD_REQUEST",
      message: "fleet and all_fleets are mutually exclusive",
    });
  });

  it("a missing sessions root still answers { sessions: [] }", async () => {
    await fs.rm(path.join(home, "sessions"), { recursive: true, force: true });
    expect(body(await handleListSessions({}))).toEqual({ sessions: [] });
  });
});

describe("resolve_tool_call — fleet view", () => {
  it("scans only the view's live sessions unless all_fleets", async () => {
    await writeSession("sess_other", { fleet: "team-b" });
    await holdCall("sess_other", "c1");
    const hidden = body(await handleResolveToolCall({ call_id: "c1", action: "approve", reason: "r" }));
    expect(hidden).toEqual({ error: "CALL_NOT_FOUND", message: "call_id not found in any live session" });
    const widened = body(await handleResolveToolCall({ call_id: "c1", action: "approve", reason: "r", all_fleets: true }));
    expect(widened).toEqual({ ok: true });
    const asB = body(await handleResolveToolCall({ call_id: "c1", action: "approve", reason: "r", fleet: "team-b" }));
    expect(asB).toEqual({ ok: true });
  });

  it("validates the fleet inputs after the call's own required inputs", async () => {
    expect(body(await handleResolveToolCall({ call_id: "c1", action: "approve", reason: "r", fleet: "a b" }))).toEqual({
      error: "BAD_REQUEST",
      message: MCP_TAG_MESSAGE,
    });
    expect(body(await handleResolveToolCall({ action: "approve", reason: "r", fleet: "a b" }))).toEqual({
      error: "BAD_REQUEST",
      message: "call_id required",
    });
  });
});

describe("tool-defs — fleet inputs", () => {
  function schemaOf(name: string) {
    const def = MCP_TOOL_DEFS.find((t) => t.name === name)!;
    return def.inputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
  }
  it("list_sessions and resolve_tool_call expose optional fleet (string) and all_fleets (boolean)", () => {
    for (const name of ["list_sessions", "resolve_tool_call"]) {
      const s = schemaOf(name);
      expect(s.properties.fleet.type).toBe("string");
      expect(s.properties.all_fleets.type).toBe("boolean");
    }
    expect(schemaOf("list_sessions").required).toBeUndefined();
    expect(schemaOf("resolve_tool_call").required).toEqual(["call_id", "action", "reason"]);
  });
});

describe("server's own CLAW_DRIVE_FLEET — invalid env surfaces as BAD_REQUEST", () => {
  // Same code path as the Task 3 review finding: an invalid fleet tag coming
  // from this server process's OWN environment (as opposed to an invalid
  // `fleet` input) must surface the env-flavored FleetTagError text, not
  // FLEET_TAG_MCP_MESSAGE.
  it("handleStartSession({ cwd }) rejects an invalid CLAW_DRIVE_FLEET in its own env", async () => {
    process.env.CLAW_DRIVE_FLEET = "-x";
    const parent = path.join(os.homedir(), "tmp", "claw-drive-ut");
    await fs.mkdir(parent, { recursive: true });
    const cwd = await fs.mkdtemp(path.join(parent, "cwd-"));
    try {
      const res = await handleStartSession({ cwd });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(body(res).message).toContain("invalid CLAW_DRIVE_FLEET");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("handleListSessions({}) rejects an invalid CLAW_DRIVE_FLEET in its own env", async () => {
    process.env.CLAW_DRIVE_FLEET = "-x";
    const res = body(await handleListSessions({}));
    expect(res.error).toBe("BAD_REQUEST");
    expect(res.message).toContain("invalid CLAW_DRIVE_FLEET");
  });
});
