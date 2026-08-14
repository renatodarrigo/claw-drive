import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { startSessionTailer } from "../../src/lib/session-tailer.js";

let root: string;
let prevHome: string | undefined;
const SID = "sess_20200101T000000_aaaaaa";

const REPLAYABLE = [
  { seq: 1, at: "t", kind: "turn_started", turn_id: "x", message: "go" },
  { seq: 2, at: "t", kind: "assistant_text", turn_id: "x", text: "done\n[DONE]" },
  { seq: 3, at: "t", kind: "turn_completed", turn_id: "x", stop_reason: "success" },
];

async function writeEvents(lines: object[]): Promise<void> {
  const dir = path.join(root, "sessions", SID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

function collect(over: Partial<Parameters<typeof startSessionTailer>[0]> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const handle = startSessionTailer({
    sessionId: SID,
    emit: (l) => lines.push(l),
    since: 0,
    allowed: null,
    noTokenFilter: false,
    suspectedNeedsInput: true,
    idleAfterSeconds: 0,
    onWatchError: (m) => errors.push(m),
    ...over,
  });
  return { lines, errors, handle };
}

beforeEach(async () => {
  prevHome = process.env.CLAW_DRIVE_HOME;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cd-tailer-"));
  process.env.CLAW_DRIVE_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAW_DRIVE_HOME;
  else process.env.CLAW_DRIVE_HOME = prevHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("startSessionTailer — caughtUp", () => {
  it("is a promise that resolves only after the initial drain has emitted", async () => {
    await writeEvents(REPLAYABLE); // no session_stopped: the tailer keeps running
    const { lines, handle } = collect();
    expect(handle.caughtUp).toBeInstanceOf(Promise);
    await handle.caughtUp;
    // Everything already in the file has been offered to the filter chain:
    // the tokened turn_completed is out before caughtUp resolves.
    expect(lines.some((l) => l.includes('"turn_completed"'))).toBe(true);
    handle.close();
    await handle.done;
  });

  it("resolves on the watch-error path (missing events file), never hanging", async () => {
    // No session dir at all.
    const { errors, handle } = collect();
    await handle.caughtUp;
    await handle.done;
    expect(errors.length).toBe(1);
  });

  it("resolves on the watch-error path when the initial drain hits a non-ENOENT read error, never hanging", async () => {
    // events.jsonl exists but as a directory: readFile fails EISDIR, not the
    // ENOENT that readEventsSince already swallows.
    const dir = path.join(root, "sessions", SID);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "events.jsonl"));
    const { errors, handle } = collect();
    await handle.caughtUp;
    await handle.done;
    expect(errors.length).toBe(1);
  });

  it("resolves when close() lands before the drain", async () => {
    await writeEvents(REPLAYABLE);
    const { handle } = collect();
    handle.close();
    await handle.caughtUp;
    await handle.done;
  });
});

describe("startSessionTailer — drainNow", () => {
  it("exists and resolves", async () => {
    await writeEvents(REPLAYABLE); // no session_stopped: the tailer keeps running
    const { handle } = collect();
    await handle.caughtUp;
    await expect(handle.drainNow()).resolves.toBeUndefined();
    handle.close();
    await handle.done;
  });

  it("emits events appended after tail start once it resolves, without waiting on fs.watch", async () => {
    await writeEvents(REPLAYABLE);
    const { lines, handle } = collect();
    await handle.caughtUp;
    const dir = path.join(root, "sessions", SID);
    const followUp = [
      { seq: 4, at: "t", kind: "turn_started", turn_id: "y", message: "go2" },
      { seq: 5, at: "t", kind: "assistant_text", turn_id: "y", text: "done2\n[DONE]" },
      { seq: 6, at: "t", kind: "turn_completed", turn_id: "y", stop_reason: "success" },
    ];
    await fs.appendFile(
      path.join(dir, "events.jsonl"),
      followUp.map((l) => JSON.stringify(l)).join("\n") + "\n"
    );
    await handle.drainNow(); // do NOT wait for fs.watch's own notification first
    expect(lines.some((l) => l.includes('"turn_id":"y"') && l.includes('"turn_completed"'))).toBe(
      true
    );
    handle.close();
    await handle.done;
  });

  it("resolves immediately after close(), never hanging", async () => {
    await writeEvents(REPLAYABLE);
    const { handle } = collect();
    await handle.caughtUp;
    handle.close();
    await handle.drainNow();
  });

  it("called before caughtUp on a 'current' tailer, resolves without replaying catch-up-consumed history", async () => {
    await writeEvents(REPLAYABLE); // no session_stopped: the tailer keeps running
    const { lines, handle } = collect({ since: "current" });
    // Deliberately skip `await handle.caughtUp` — cursor isn't assigned yet,
    // so an early drainNow() must not race it and re-offer the whole file.
    await handle.drainNow();
    expect(lines.some((l) => l.includes('"turn_completed"'))).toBe(false);
    handle.close();
    await handle.done;
  });
});
