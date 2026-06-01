import * as fs from "node:fs";
import * as path from "node:path";
import { runnerLogPath } from "./paths.js";

/**
 * CD-9 runner-log capture. The runner is spawned detached with
 * `stdio:"ignore"` (src/mcp/server.ts, src/cli/commands/start.ts), so its own
 * `console.log`/`console.error` would go to /dev/null — nothing to read when
 * the most opaque component dies headlessly.
 *
 * The design splits into a testable SINK and a thin process redirect:
 *   - `openRunnerLog(sessionId)` → a `RunnerLog` whose `write()` appends to
 *     `<session_dir>/runner.log`. All the capture (and CD-44 rotation) logic
 *     lives here and is unit-tested directly.
 *   - `installRunnerLogCapture(sessionId)` redirects `process.stdout.write` /
 *     `process.stderr.write` into that sink, so every existing `console.*` call
 *     is captured with no call-site rewrites. The runner owns the fd (which
 *     CD-44 rotation requires). This wiring is covered end-to-end by the
 *     integration test (a real subprocess), because vitest intercepts
 *     `console.*` in-process and would never reach a stdout redirect.
 */

export interface RunnerLog {
  /** Append a chunk to the live runner.log. Never throws. */
  write(chunk: string | Uint8Array): void;
  /** Best-effort fsync. Never throws. */
  flush(): void;
  /** Close the underlying fd. Idempotent; subsequent writes are no-ops. */
  close(): void;
}

/**
 * Open the per-session runner.log sink in append mode. CD-43 is capture-only;
 * CD-44 layers size-based rotation into this same factory.
 */
export function openRunnerLog(sessionId: string): RunnerLog {
  const logPath = runnerLogPath(sessionId);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let fd: number | null = fs.openSync(logPath, "a");

  return {
    write(chunk: string | Uint8Array): void {
      if (fd === null) return;
      try {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        fs.writeSync(fd, buf);
      } catch {
        /* never let logging crash the runner */
      }
    },
    flush(): void {
      if (fd === null) return;
      try {
        fs.fsyncSync(fd);
      } catch {
        /* best-effort */
      }
    },
    close(): void {
      if (fd === null) return;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      fd = null;
    },
  };
}

export interface RunnerLogHandle {
  /** Best-effort fsync of the log file. Never throws. */
  flush(): void;
  /** Restore the original stdout/stderr writers and close the log. Idempotent. */
  close(): void;
}

type WriteFn = typeof process.stdout.write;

interface ActiveCapture {
  log: RunnerLog;
  origStdout: WriteFn;
  origStderr: WriteFn;
  closed: boolean;
}

// A process has exactly one stdout/stderr, so at most one capture is active.
// A second install returns a handle onto the same capture rather than stacking
// redirects (which would double every line).
let active: ActiveCapture | null = null;

/**
 * A drop-in for `process.stdout.write` / `process.stderr.write` that forwards
 * the bytes to the runner-log sink. Handles both call shapes —
 * `write(chunk, cb)` and `write(chunk, encoding, cb)` — invokes the callback so
 * `console.*` never hangs, and returns true.
 */
function makeRedirect(cap: ActiveCapture): WriteFn {
  return function (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
    const callback =
      typeof encodingOrCb === "function" ? encodingOrCb : typeof cb === "function" ? cb : undefined;
    const encoding = (typeof encodingOrCb === "string" ? encodingOrCb : "utf8") as BufferEncoding;
    if (!cap.closed) {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk as Uint8Array);
      cap.log.write(buf);
    }
    if (callback) (callback as (err?: Error | null) => void)();
    return true;
  } as WriteFn;
}

/**
 * Begin capturing this process's stdout/stderr into `<session_dir>/runner.log`.
 * Idempotent: a second call while a capture is active returns a handle onto the
 * existing capture. Returns a handle to flush/close it.
 */
export function installRunnerLogCapture(sessionId: string): RunnerLogHandle {
  if (active && !active.closed) {
    return makeHandle(active);
  }
  const cap: ActiveCapture = {
    log: openRunnerLog(sessionId),
    origStdout: process.stdout.write,
    origStderr: process.stderr.write,
    closed: false,
  };
  const redirect = makeRedirect(cap);
  process.stdout.write = redirect;
  process.stderr.write = redirect;
  active = cap;
  return makeHandle(cap);
}

function makeHandle(cap: ActiveCapture): RunnerLogHandle {
  return {
    flush(): void {
      cap.log.flush();
    },
    close(): void {
      if (cap.closed) return;
      cap.closed = true;
      process.stdout.write = cap.origStdout;
      process.stderr.write = cap.origStderr;
      cap.log.close();
      if (active === cap) active = null;
    },
  };
}
