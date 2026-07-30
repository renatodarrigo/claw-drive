import * as path from "node:path";
import { readEventsSince } from "../../src/lib/events.js";
import type { Event } from "../../src/lib/events.js";

export const ROTATION_POLICY = {
  auto_approve: [{ tool: "/.*/" }],
  escalate_default: true,
  rotation: { threshold_tokens: 35000 },
};

export function padding(words: number): string {
  return Array(words).fill("the quick brown fox jumps over the lazy river dog").join(" ");
}

export async function eventsOf(root: string, id: string): Promise<Event[]> {
  return (await readEventsSince(path.join(root, "sessions", id, "events.jsonl"), 0)).events;
}

export async function waitFor(
  root: string,
  id: string,
  pred: (evs: Event[]) => boolean,
  timeoutMs: number
): Promise<Event[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evs = await eventsOf(root, id);
    if (pred(evs)) return evs;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for predicate on ${id}`);
}
