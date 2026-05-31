import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { buildEscalationContext } from "../../src/runner/runner.js";
import { RATIONALE_CAP, DIFF_CAP } from "../../src/lib/decision-context.js";

// CD-8 / CD-55: the runner's at-source enrichment, driven deterministically
// against a synthetic CLAW_DRIVE_HOME + a real temp cwd — no real claude.

let root: string;
let cwd: string;
let prevHome: string | undefined;
const SID = "sess_runner01";

async function seedEvents(lines: object[]): Promise<void> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd55-"));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cd55cwd-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("buildEscalationContext (runner at-source enrichment)", () => {
  it("Edit: rationale from the same turn's prior assistant_text + a diff", async () => {
    await seedEvents([
      { seq: 1, at: "t", kind: "turn_started", turn_id: "t1", message: "go" },
      { seq: 2, at: "t", kind: "assistant_text", turn_id: "t1", text: "I'll bump the version." },
    ]);
    const ctx = await buildEscalationContext(SID, cwd, "t1", "Edit", {
      file_path: "v.ts",
      old_string: "const v = 1;",
      new_string: "const v = 2;",
    });
    expect(ctx.rationale).toBe("I'll bump the version.");
    expect(ctx.diff).toContain("-const v = 1;");
    expect(ctx.diff).toContain("+const v = 2;");
  });

  it("Write against an existing file: unified diff vs the real file content", async () => {
    await fs.writeFile(path.join(cwd, "note.txt"), "old body");
    await seedEvents([
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "t1", text: "updating the note" },
    ]);
    const ctx = await buildEscalationContext(SID, cwd, "t1", "Write", {
      file_path: "note.txt",
      content: "new body",
    });
    expect(ctx.diff).toContain("-old body");
    expect(ctx.diff).toContain("+new body");
    expect(ctx.rationale).toBe("updating the note");
  });

  it("Write to a non-existent file: content rendered as added lines (new-file)", async () => {
    await seedEvents([{ seq: 1, at: "t", kind: "turn_started", turn_id: "t1", message: "go" }]);
    const ctx = await buildEscalationContext(SID, cwd, "t1", "Write", {
      file_path: "fresh.txt",
      content: "hello\nworld",
    });
    expect(ctx.diff).toContain("+hello");
    expect(ctx.diff).toContain("+world");
  });

  it("non-file tool (Bash): rationale only, no diff", async () => {
    await seedEvents([
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "t1", text: "listing files" },
    ]);
    const ctx = await buildEscalationContext(SID, cwd, "t1", "Bash", { command: "ls -la" });
    expect(ctx.rationale).toBe("listing files");
    expect("diff" in ctx).toBe(false);
  });

  it("no prior assistant_text in the turn: no rationale (graceful)", async () => {
    await seedEvents([
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "t0", text: "other turn" },
      { seq: 2, at: "t", kind: "turn_started", turn_id: "t1", message: "go" },
    ]);
    const ctx = await buildEscalationContext(SID, cwd, "t1", "Bash", { command: "ls" });
    expect("rationale" in ctx).toBe(false);
  });

  it("caps are enforced at source (rationale ≤ cap+marker, diff ≤ cap)", async () => {
    const longText = "z".repeat(RATIONALE_CAP + 400);
    const bigContent = Array.from({ length: 6000 }, (_, i) => `row ${i}`).join("\n");
    await seedEvents([
      { seq: 1, at: "t", kind: "assistant_text", turn_id: "t1", text: longText },
    ]);
    const ctx = await buildEscalationContext(SID, cwd, "t1", "Write", {
      file_path: "big.txt",
      content: bigContent,
    });
    expect(ctx.rationale!.length).toBe(RATIONALE_CAP + 1);
    expect(ctx.diff!.length).toBeLessThanOrEqual(DIFF_CAP);
  });
});
