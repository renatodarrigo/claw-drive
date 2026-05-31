import * as fs from "node:fs";
import { eventsPath } from "./paths.js";
import { readEventsSince, type Event } from "./events.js";
import {
  shouldEmit,
  userFilter,
  decideWatchEmit,
  catchUpPending,
  newIdleState,
  noteSurface,
  cancelIdle,
  shouldFireIdle,
  deriveCurrentTurn,
} from "../cli/commands/watch.js";

export interface SessionTailerOptions {
  sessionId: string;
  /** Sink for ready-to-write JSONL lines (each already ends in "\n"). */
  emit: (line: string) => void;
  since: number | "current";
  allowed: Set<string> | null;
  noTokenFilter: boolean;
  suspectedNeedsInput: boolean;
  idleAfterSeconds: number;
  /**
   * When set, every emitted line carries an additive `session_id` field so a
   * merged multi-session stream (`watch --all`) can attribute each event.
   * When absent, emitted output is byte-identical to single-session `watch`.
   */
  tag?: string;
  /** Called if the events file cannot be watched (e.g. it vanished). */
  onWatchError?: (message: string) => void;
}

export interface SessionTailerHandle {
  /** Resolves when the session stops (`session_stopped`) or `close()` is called. */
  done: Promise<void>;
  /** Idempotent teardown: stops the fs.watch + idle ticker and resolves `done`. */
  close: () => void;
}

/**
 * Tail one session's `events.jsonl` and write its filtered, optionally
 * `session_id`-tagged JSONL stream to a sink. This is the single-session watch
 * loop — catch-up of unresolved gates, cursor + `readEventsSince`, `fs.watch`,
 * the idle ticker, the `shouldEmit`/`userFilter`/`decideWatchEmit` chain, and
 * `session_stopped` handling — extracted so both `cmdWatch` (single session)
 * and the `watch --all` multiplexer can reuse it.
 *
 * Returns immediately with a handle; the async tailing runs in the background.
 * `done` resolves on `session_stopped` or `close()`. SIGINT handling belongs to
 * the caller (single-session `cmdWatch` or the multiplexer), not the tailer.
 */
export function startSessionTailer(opts: SessionTailerOptions): SessionTailerHandle {
  const { sessionId, emit, allowed, noTokenFilter, suspectedNeedsInput, tag } = opts;

  const allEvents: Event[] = [];
  const idle = newIdleState(opts.idleAfterSeconds, Date.now());

  // Synthetic events use NEGATIVE seq numbers so they never collide with the
  // runner's positive monotonic seq from events.jsonl. v0.5.7 convention.
  let nextSyntheticSeq = -1;
  const syntheticSeq = (): number => nextSyntheticSeq--;

  let since = opts.since;
  let stopped = false;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let watcher: fs.FSWatcher | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let finished = false;

  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    resolveDone();
  };

  // Write a payload, prepending the additive `session_id` tag when present.
  // Without a tag the serialized line is byte-identical to single-session watch.
  const writeLine = (payload: unknown): void => {
    if (finished) return;
    const out = tag === undefined ? payload : { session_id: tag, ...(payload as object) };
    emit(JSON.stringify(out) + "\n");
  };

  const maybeEmitIdle = (): void => {
    if (!shouldFireIdle(idle, Date.now())) return;
    const idleEvent = {
      seq: syntheticSeq(),
      at: new Date().toISOString(),
      kind: "idle" as const,
      silent_for_ms: idle.thresholdMs,
      current_turn: deriveCurrentTurn(allEvents),
    };
    if (userFilter(idleEvent as unknown as Event, allowed)) {
      writeLine(idleEvent);
    }
    // Reset the silence timer even when userFilter drops the idle event.
    noteSurface(idle, Date.now());
  };

  let cursor = 0;
  const drain = async (): Promise<void> => {
    const { events, nextSince } = await readEventsSince(eventsPath(sessionId), cursor);
    for (const e of events) {
      allEvents.push(e);
      if (shouldEmit(e) && userFilter(e, allowed)) {
        const decision = decideWatchEmit(e, allEvents, { noTokenFilter, suspectedNeedsInput });
        if (decision.emit) {
          writeLine(decision.payload);
          noteSurface(idle, Date.now());
        }
      }
      if (e.kind === "session_stopped") {
        stopped = true;
        cancelIdle(idle);
      }
    }
    cursor = nextSince;
    maybeEmitIdle();
  };

  void (async () => {
    // Default (since==="current"): stream NEW events only, but catch up on
    // unresolved gates + session_stopped first (CLV-16 race fix).
    if (since === "current") {
      let all;
      try {
        all = await readEventsSince(eventsPath(sessionId), 0);
      } catch {
        all = { events: [] as Event[], nextSince: 0 };
      }
      allEvents.push(...all.events);
      for (const e of catchUpPending(all.events)) {
        if (userFilter(e, allowed)) {
          writeLine(e);
          noteSurface(idle, Date.now());
        }
        if (e.kind === "session_stopped") {
          stopped = true;
          cancelIdle(idle);
        }
      }
      since = all.nextSince;
    }
    cursor = since;

    // Initial drain (only meaningful for --replay / --since < current).
    await drain();
    if (finished) return; // closed during catch-up/drain
    if (stopped) {
      cleanup();
      return;
    }

    try {
      watcher = fs.watch(eventsPath(sessionId), { persistent: true });
    } catch (err) {
      opts.onWatchError?.((err as Error).message);
      cleanup();
      return;
    }
    if (finished) {
      // close() raced the fs.watch setup.
      watcher.close();
      watcher = null;
      return;
    }

    // fs.watch only fires on file changes — idle is the absence-of-changes
    // signal, so we need an independent ticker. Tick at ~quarter the threshold,
    // clamped to [250ms, 5s].
    const tickMs =
      idle.thresholdMs === 0
        ? 0
        : Math.max(250, Math.min(5000, Math.floor(idle.thresholdMs / 4)));

    watcher.on("change", async () => {
      try {
        await drain();
        if (stopped) cleanup();
      } catch {
        /* swallow transient read errors */
      }
    });
    if (tickMs > 0) {
      ticker = setInterval(() => {
        try {
          maybeEmitIdle();
        } catch {
          /* defensive: never let a tick crash the watcher */
        }
      }, tickMs);
    }
  })();

  return { done, close: cleanup };
}
