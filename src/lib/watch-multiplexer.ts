import { listLiveSessions } from "./live-sessions.js";
import { startSessionTailer, type SessionTailerHandle } from "./session-tailer.js";
import { readState } from "./state.js";
import { statePath } from "./paths.js";
import type { WatchFilterArgs } from "../cli/commands/watch.js";

const DEFAULT_RESCAN_INTERVAL_MS = 1000;

export interface WatchMultiplexerOptions {
  /** Sink for ready-to-write JSONL lines (each already ends in "\n"). */
  emit: (line: string) => void;
  /** The per-session filter/replay flags applied independently in each tailer. */
  filters: WatchFilterArgs;
  /** Live-set rescan cadence (dynamic membership). Defaults to 1000ms. */
  rescanIntervalMs?: number;
}

export interface WatchMultiplexerHandle {
  /** Resolves on close() (SIGINT). NOT when an individual session stops. */
  done: Promise<void>;
  /** Idempotent teardown: stops the rescan timer and closes every tailer. */
  close: () => void;
}

/**
 * `watch --all`: tail every live session into one merged, `session_id`-tagged
 * JSONL stream with dynamic membership. Sessions present at start are tailed
 * immediately; a periodic rescan of the live set picks up sessions spawned
 * later. A session's tailer self-closes when it stops (its `session_stopped`
 * surfaces first); the merged stream runs until `close()` (SIGINT), not when
 * any single session stops. Every per-session filter (`shouldEmit`, `--only` /
 * `--decision-only`, the sentinel tokenFilter + CD-6 backstop, `--idle-after`)
 * applies independently inside each tailer.
 */
export function startWatchMultiplexer(opts: WatchMultiplexerOptions): WatchMultiplexerHandle {
  const tailers = new Map<string, SessionTailerHandle>();
  // Session ids we've ever started a tailer for. Session ids are unique and
  // monotonic, so once a session has been tailed (and possibly stopped) we
  // never re-tail it — this makes the rescan idempotent and stop-safe (a
  // stopped session can't be re-added even if its state lags behind its
  // session_stopped event).
  const everStarted = new Set<string>();

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  let finished = false;

  const addSession = async (id: string): Promise<void> => {
    if (everStarted.has(id)) return;
    everStarted.add(id);
    // CD-10: read the session's alias (if any) so the tag-line carries it
    // alongside session_id. Best-effort — a missing/unreadable state just omits it.
    let aliasTag: string | undefined;
    try {
      aliasTag = (await readState(statePath(id)))?.alias;
    } catch {
      aliasTag = undefined;
    }
    const handle = startSessionTailer({
      sessionId: id,
      emit: opts.emit,
      since: opts.filters.since,
      allowed: opts.filters.allowed,
      noTokenFilter: opts.filters.noTokenFilter,
      suspectedNeedsInput: opts.filters.suspectedNeedsInput,
      idleAfterSeconds: opts.filters.idleAfterSeconds,
      tag: id,
      aliasTag,
      onWatchError: () => {
        // events file vanished between enumeration and tail — drop it.
      },
    });
    tailers.set(id, handle);
    void handle.done.then(() => {
      tailers.delete(id);
    });
  };

  const rescan = async (): Promise<void> => {
    if (finished) return;
    let live: string[];
    try {
      live = await listLiveSessions();
    } catch {
      return;
    }
    for (const id of live) await addSession(id);
  };

  const close = (): void => {
    if (finished) return;
    finished = true;
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    for (const handle of tailers.values()) handle.close();
    tailers.clear();
    resolveDone();
  };

  // Initial scan + periodic rescan for dynamic membership.
  void rescan();
  rescanTimer = setInterval(() => {
    void rescan();
  }, opts.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS);

  return { done, close };
}
