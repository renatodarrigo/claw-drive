import { startSessionTailer, type SessionTailerHandle } from "./session-tailer.js";
import { readState, isPidAlive } from "./state.js";
import { statePath } from "./paths.js";
import type { WatchFilterArgs } from "../cli/commands/watch.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface LineageTailerOptions {
  /** First lineage member to tail (already resolved to a canonical id). */
  sessionId: string;
  /** Sink for ready-to-write JSONL lines (each already ends in "\n"). */
  emit: (line: string) => void;
  /**
   * Per-member filter/replay flags. `since` binds to the FIRST member;
   * successors tail from "current" — except a full-history walk (since 0,
   * i.e. --replay), which propagates so the whole lineage replays. A numeric
   * --since N never propagates: seq numbers are per-session.
   */
  filters: WatchFilterArgs;
  /** Successor-pointer poll cadence (recover hops). Defaults to 1000ms. */
  pollIntervalMs?: number;
  /** Called once if a member's events file cannot be watched, or on a lineage cycle. */
  onWatchError?: (message: string) => void;
}

export interface LineageTailerHandle {
  /** Resolves on lineage end, a member watch error, or close(). */
  done: Promise<void>;
  /** Idempotent teardown: stops the poll, closes the current member's tailer. */
  close: () => void;
}

/**
 * `watch --follow-lineage`: tail a session and, when it gains a successor
 * (rotation, or a recover of a crashed member), hop to the successor and
 * continue — until a member stops without one. Members are strictly
 * sequential: a successor's tailer starts only after the predecessor's is
 * closed, so the merged output never interleaves. Every line carries the
 * additive session_id/alias/generation tags (the `watch --all` trio).
 *
 * Two hop triggers per member:
 *  - natural tailer end (session_stopped observed) → re-read state; a set
 *    `rotated_to` is the successor (rotation writes it BEFORE the stop, so
 *    the read is race-free); unset means lineage end.
 *  - a state poll for corpses: a member with a dead runner pid never writes
 *    session_stopped, so when its state gains `rotated_to` (recover) the
 *    poll closes the tailer — gated on `caughtUp` and a final `drainNow()`
 *    flush, so a hop can never truncate the member's emission. A live pid
 *    means a rotation is in flight (or a dangling pointer on a live
 *    predecessor): the natural stop handles it, the poll stays hands-off.
 */
export function startLineageTailer(opts: LineageTailerOptions): LineageTailerHandle {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const visited = new Set<string>();
  let finished = false;
  let current: SessionTailerHandle | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const close = (): void => {
    if (finished) return;
    finished = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    current?.close();
    resolveDone();
  };

  const fail = (message: string): void => {
    if (finished) return;
    opts.onWatchError?.(message);
    close();
  };

  // Recover-hop trigger. A corpse (dead runner pid) never writes
  // session_stopped, so its tailer never ends on its own; when its state
  // gains `rotated_to`, close the tailer — but only after two gates:
  // `caughtUp` (the tail-start catch-up/replay is emitted) and `drainNow()`
  // (anything appended since is flushed too). A dead runner appends no
  // further events, so once both gates clear, the tailer has emitted
  // everything it ever will. The close resolves tailer.done, which
  // converges on advance().
  const startPoll = (
    id: string,
    tailer: SessionTailerHandle,
    isAdvanced: () => boolean
  ): void => {
    const tick = async (): Promise<void> => {
      if (finished || isAdvanced()) return;
      let st;
      try {
        st = await readState(statePath(id));
      } catch {
        return; // best-effort tick
      }
      if (st?.rotated_to === undefined) return;
      if (st.runner_pid !== null && isPidAlive(st.runner_pid)) return;
      await tailer.caughtUp;
      if (finished || isAdvanced()) return;
      await tailer.drainNow();
      if (finished || isAdvanced()) return;
      tailer.close();
    };
    void tick(); // immediate: a pre-recovered corpse hops without waiting a full interval
    pollTimer = setInterval(() => {
      void tick();
    }, pollMs);
  };

  const runMember = async (id: string): Promise<void> => {
    if (finished) return;
    if (visited.has(id)) {
      fail(`lineage cycle at ${id}`);
      return;
    }
    visited.add(id);
    const since: number | "current" =
      visited.size === 1 ? opts.filters.since : opts.filters.since === 0 ? 0 : "current";

    // Best-effort tag read (multiplexer addSession precedent).
    let aliasTag: string | undefined;
    let generationTag: number | undefined;
    try {
      const st = await readState(statePath(id));
      aliasTag = st?.alias;
      generationTag = st?.generation;
    } catch {
      aliasTag = undefined;
      generationTag = undefined;
    }

    let memberWatchError: string | null = null;
    const tailer = startSessionTailer({
      sessionId: id,
      emit: opts.emit,
      since,
      allowed: opts.filters.allowed,
      noTokenFilter: opts.filters.noTokenFilter,
      suspectedNeedsInput: opts.filters.suspectedNeedsInput,
      idleAfterSeconds: opts.filters.idleAfterSeconds,
      tag: id,
      aliasTag,
      generationTag,
      onWatchError: (m) => {
        memberWatchError = m;
      },
    });
    current = tailer;
    if (finished) {
      // close() raced the member start.
      tailer.close();
      return;
    }

    // One member advances exactly once — the natural end and a poll-forced
    // close both land here via tailer.done.
    let advanced = false;
    const advance = async (): Promise<void> => {
      if (finished || advanced) return;
      advanced = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (memberWatchError !== null) {
        fail(memberWatchError);
        return;
      }
      let successor: string | undefined;
      try {
        successor = (await readState(statePath(id)))?.rotated_to;
      } catch {
        // Prune race after the stop: treat as no successor.
        successor = undefined;
      }
      if (finished) return;
      if (successor === undefined) {
        close(); // lineage end
        return;
      }
      void runMember(successor);
    };
    void tailer.done.then(() => {
      void advance();
    });

    startPoll(id, tailer, () => advanced);
  };

  void runMember(opts.sessionId);
  return { done, close };
}
