import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { startSessionTailer } from "../../src/lib/session-tailer.js";

let root: string;
let prevHome: string | undefined;
const SID = "sess_tail01";

const EVENTS = [
  { seq: 1, at: "t", kind: "turn_started", turn_id: "x", message: "go" },
  { seq: 2, at: "t", kind: "assistant_text", turn_id: "x", text: "all done\n[DONE]" },
  { seq: 3, at: "t", kind: "turn_completed", turn_id: "x", stop_reason: "success" },
  { seq: 4, at: "t", kind: "session_stopped", reason: "done", exit_code: 0 },
];

async function writeEvents(lines: object[]): Promise<void> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

function collect(opts: Partial<Parameters<typeof startSessionTailer>[0]>) {
  const lines: string[] = [];
  const handle = startSessionTailer({
    sessionId: SID,
    emit: (l) => lines.push(l),
    since: 0,
    allowed: null,
    noTokenFilter: false,
    suspectedNeedsInput: true,
    idleAfterSeconds: 0,
    ...opts,
  });
  return { lines, handle };
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd39-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("startSessionTailer — additive session_id tag", () => {
  it("with a tag, every emitted line carries session_id alongside all original fields", async () => {
    await writeEvents(EVENTS);
    const { lines, handle } = collect({ tag: SID });
    await handle.done;
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.length).toBeGreaterThanOrEqual(2); // turn_completed + session_stopped
    for (const p of parsed) expect(p.session_id).toBe(SID);
    const tc = parsed.find((p) => p.kind === "turn_completed");
    expect(tc).toMatchObject({ seq: 3, kind: "turn_completed", turn_id: "x", stop_reason: "success" });
  });

  it("without a tag, output is byte-identical to untagged single-session watch", async () => {
    await writeEvents(EVENTS);
    const { lines, handle } = collect({}); // no tag
    await handle.done;
    for (const l of lines) expect(l).not.toContain("session_id");
    const tcLine = lines.find((l) => l.includes("turn_completed"))!;
    expect(JSON.parse(tcLine)).toEqual({
      seq: 3,
      at: "t",
      kind: "turn_completed",
      turn_id: "x",
      stop_reason: "success",
    });
  });

  it("the sentinel tokenFilter still applies under the tailer ([DONE] surfaces the turn)", async () => {
    await writeEvents(EVENTS);
    const { lines, handle } = collect({ tag: SID });
    await handle.done;
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain("turn_completed"); // [DONE] token → surfaced
    expect(kinds).not.toContain("assistant_text"); // noise dropped
  });

  it("resolves done on session_stopped", async () => {
    await writeEvents(EVENTS);
    const { handle } = collect({});
    await expect(handle.done).resolves.toBeUndefined();
  });

  it("close() resolves done even without a session_stopped event", async () => {
    await writeEvents(EVENTS.slice(0, 3)); // no session_stopped
    const { handle } = collect({});
    await new Promise((r) => setTimeout(r, 50)); // let the async init set up fs.watch
    handle.close();
    await expect(handle.done).resolves.toBeUndefined();
  });
});
