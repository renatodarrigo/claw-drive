import * as fs from "node:fs";
import * as path from "node:path";
import { runnerLogPath } from "./paths.js";

/**
 * CD-9 runner-log capture + rotation. The runner is spawned detached with
 * `stdio:"ignore"` (src/mcp/server.ts, src/cli/commands/start.ts), so its own
 * `console.log`/`console.error` would go to /dev/null — nothing to read when
 * the most opaque component dies headlessly.
 *
 * The design splits into a testable SINK and a thin process redirect:
 *   - `openRunnerLog(sessionId)` → a `RunnerLog` whose `write()` appends to
 *     `<session_dir>/runner.log`, rotating by size. All capture + rotation
 *     logic lives here and is unit-tested directly.
 *   - `installRunnerLogCapture(sessionId)` redirects `process.stdout.write` /
 *     `process.stderr.write` into that sink, so every existing `console.*` call
 *     is captured with no call-site rewrites. The runner owns the fd (which
 *     rotation requires). This wiring is covered end-to-end by the integration
 *     test (a real subprocess), because vitest intercepts `console.*`
 *     in-process and would never reach a stdout redirect.
 */

/** 10 MiB default cap before the live log rolls. */
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Default number of rolled generations kept (runner.log.1 … .3). */
const DEFAULT_LOG_KEEP = 3;

/**
 * Read a positive-integer env override, falling back to `fallback` for an
 * absent / non-integer / zero / negative value. The bound is never disabled —
 * a bad value must not let the log grow unbounded.
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export interface RunnerLog {
  /** Append a chunk to the live runner.log, rotating first if needed. Never throws. */
  write(chunk: string | Uint8Array): void;
  /** Best-effort fsync. Never throws. */
  flush(): void;
  /** Close the underlying fd. Idempotent; subsequent writes are no-ops. */
  close(): void;
}

/**
 * Open the per-session runner.log sink in append mode with size-based rotation.
 * Rolls before a write that would push the live log past LOG_MAX_BYTES:
 * `runner.log.<KEEP>` is deleted, each `.i` shifts to `.i+1`, the live log
 * becomes `.1`, and a fresh live log opens. An empty live log is never rolled
 * (a single oversized chunk is written as-is, then the next write rotates).
 * Byte accounting is in-process, seeded from the log's pre-existing size.
 */
export function openRunnerLog(sessionId: string): RunnerLog {
  const logPath = runnerLogPath(sessionId);
  const maxBytes = envPositiveInt("CLAW_DRIVE_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES);
  const keep = envPositiveInt("CLAW_DRIVE_LOG_KEEP", DEFAULT_LOG_KEEP);

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let fd: number | null = fs.openSync(logPath, "a");
  let bytesWritten = 0;
  try {
    bytesWritten = fs.fstatSync(fd).size;
  } catch {
    /* fresh file */
  }

  // Roll the live log. Every fs op is guarded — rotation must not crash the runner.
  function rotate(): void {
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(`${logPath}.${keep}`, { force: true });
    } catch {
      /* may not exist */
    }
    for (let i = keep - 1; i >= 1; i--) {
      try {
        if (fs.existsSync(`${logPath}.${i}`)) fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
      } catch {
        /* skip a wedged generation */
      }
    }
    try {
      fs.renameSync(logPath, `${logPath}.1`);
    } catch {
      /* live may have vanished */
    }
    fd = fs.openSync(logPath, "a");
    bytesWritten = 0;
  }

  return {
    write(chunk: string | Uint8Array): void {
      if (fd === null) return;
      try {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        // Rotate before a write that would exceed the cap — but never roll an
        // empty live log (a single oversized chunk writes as-is).
        if (bytesWritten > 0 && bytesWritten + buf.length > maxBytes) {
          rotate();
        }
        fs.writeSync(fd, buf);
        bytesWritten += buf.length;
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
 * Begin capturing this process's stdout/stderr into `<session_dir>/runner.log`
 * with size-based rotation. Idempotent: a second call while a capture is active
 * returns a handle onto the existing capture. Returns a handle to flush/close it.
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
