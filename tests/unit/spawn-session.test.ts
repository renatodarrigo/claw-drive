import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { newSessionId, scaffoldSessionDir } from "../../src/lib/spawn-session.js";
import { statePath, settingsPath, mcpConfigPath } from "../../src/lib/paths.js";
import { readState } from "../../src/lib/state.js";

let home: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  savedEnv = process.env.CLAW_DRIVE_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cd11-scaffold-"));
  process.env.CLAW_DRIVE_HOME = home;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

const baseInput = (id: string) => ({
  sessionId: id,
  cwd: "/tmp/x",
  policy: "bypass" as const,
  decisionTimeoutSeconds: 3600,
  model: null,
});

describe("newSessionId", () => {
  it("matches the canonical shape", () => {
    expect(newSessionId()).toMatch(/^sess_\d{8}T\d{6}_[a-z0-9]{6}$/);
  });
});

describe("scaffoldSessionDir", () => {
  it("writes mcp.json, settings.json (approver hook), and state.json", async () => {
    const id = "sess_20260729T000000_aaaaaa";
    await scaffoldSessionDir(baseInput(id));
    const mcp = JSON.parse(await fs.readFile(mcpConfigPath(id), "utf-8"));
    expect(mcp).toEqual({ mcpServers: {} });
    const settings = JSON.parse(await fs.readFile(settingsPath(id), "utf-8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(id);
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(600);
    const state = await readState(statePath(id));
    expect(state).toMatchObject({ session_id: id, status: "starting", turns: 0 });
    expect(state!.generation).toBeUndefined(); // no rotation config, no lineage
  });

  it("stamps generation 1 + root on a rotation-configured fresh start", async () => {
    const id = "sess_20260729T000000_bbbbbb";
    await scaffoldSessionDir({
      ...baseInput(id),
      policy: { rotation: { threshold_tokens: 120000 } },
    });
    const state = await readState(statePath(id));
    expect(state!.generation).toBe(1);
    expect(state!.root_session_id).toBe(id);
    expect(state!.rotated_from).toBeUndefined();
  });

  it("stamps a successor's lineage verbatim and carries brief/alias/wrapper", async () => {
    const id = "sess_20260729T000000_cccccc";
    await scaffoldSessionDir({
      ...baseInput(id),
      scenarioBrief: "the composed successor brief",
      alias: "reviewer",
      wrapper: false,
      lineage: { generation: 3, root_session_id: "sess_root", rotated_from: "sess_prev" },
    });
    const state = await readState(statePath(id));
    expect(state).toMatchObject({
      generation: 3,
      root_session_id: "sess_root",
      rotated_from: "sess_prev",
      alias: "reviewer",
      wrapper: false,
    });
    expect((state as unknown as { scenario_brief?: string }).scenario_brief).toBe(
      "the composed successor brief"
    );
  });

  it("stamps original_brief from the scenario brief on a rotation-configured fresh start", async () => {
    const id = "sess_20260729T000000_gggggg";
    await scaffoldSessionDir({
      ...baseInput(id),
      policy: { rotation: { threshold_tokens: 120000 } },
      scenarioBrief: "the original mission",
    });
    const state = await readState(statePath(id));
    expect(state!.original_brief).toBe("the original mission");
  });

  it("stamps an explicit originalBrief verbatim on a lineage scaffold, distinct from the composed scenario_brief", async () => {
    const id = "sess_20260729T000000_hhhhhh";
    await scaffoldSessionDir({
      ...baseInput(id),
      scenarioBrief: "the composed successor brief",
      originalBrief: "the TRUE original mission from generation 1",
      lineage: { generation: 3, root_session_id: "sess_root", rotated_from: "sess_prev" },
    });
    const state = await readState(statePath(id));
    expect(state!.original_brief).toBe("the TRUE original mission from generation 1");
    expect((state as unknown as { scenario_brief?: string }).scenario_brief).toBe(
      "the composed successor brief"
    );
  });

  it("does NOT stamp original_brief on a plain non-rotation fresh start, even with a scenario brief", async () => {
    const id = "sess_20260729T000000_iiiiii";
    await scaffoldSessionDir({
      ...baseInput(id),
      scenarioBrief: "just a brief, no rotation configured",
    });
    const state = await readState(statePath(id));
    expect(state!.original_brief).toBeUndefined();
  });
});
