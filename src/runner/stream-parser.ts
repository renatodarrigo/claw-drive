import type { Event } from "../lib/events.js";

export type PartialEvent = Omit<Event, "seq" | "at">;

export interface ParserOutput {
  events: PartialEvent[];
  claude_session_id?: string;
  /**
   * Context rotation: input-side context tokens (input + cache_creation + cache_read) of a
   * MAIN-LOOP assistant line (parent_tool_use_id === null). Subagent lines and
   * lines without a well-formed usage object produce no reading (undefined) —
   * never zero, so a malformed line can't reset tracking.
   */
  main_context_tokens?: number;
  /** Context rotation: this line is a native auto-compact marker (system:compact_boundary). */
  compact_boundary?: boolean;
}

/**
 * Transform one already-parsed claude stream-json line into zero or more
 * of our Events. Caller stamps seq + at.
 *
 * Input contract captured in docs/claude-cli-contract.md.
 * Multiple `assistant` events per turn are expected; each produces its own
 * parsed events (coalescing is a consumer concern).
 * Unknown top-level types (including rate_limit_event and hook system events)
 * silently produce empty events arrays.
 */
export function parseClaudeLine(line: unknown, turnId: string): ParserOutput {
  if (typeof line !== "object" || line === null) return { events: [] };
  const obj = line as Record<string, unknown>;

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init" && typeof obj.session_id === "string") {
        return { events: [], claude_session_id: obj.session_id };
      }
      if (obj.subtype === "compact_boundary") {
        return { events: [], compact_boundary: true };
      }
      // hook_started, hook_response, status, thinking_tokens, etc.: ignore
      return { events: [] };
    }

    case "assistant": {
      const out: ParserOutput = { events: parseAssistantMessage(obj, turnId) };
      if (obj.parent_tool_use_id === null) {
        const tokens = mainContextTokens((obj.message as Record<string, unknown> | undefined)?.usage);
        if (tokens !== null) out.main_context_tokens = tokens;
      }
      return out;
    }

    case "user":
      return { events: parseUserMessage(obj, turnId) };

    case "result": {
      const subtype = String(obj.subtype ?? "");
      const isError = obj.is_error === true || subtype.startsWith("error_");
      if (isError) {
        return {
          events: [
            {
              kind: "turn_failed",
              turn_id: turnId,
              error: subtype || "unknown",
            } as PartialEvent,
          ],
        };
      }
      return {
        events: [
          {
            kind: "turn_completed",
            turn_id: turnId,
            stop_reason: subtype || "success",
          } as PartialEvent,
        ],
      };
    }

    default:
      // rate_limit_event, unknown types, forward-compat: ignore
      return { events: [] };
  }
}

function parseAssistantMessage(obj: Record<string, unknown>, turnId: string): PartialEvent[] {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? []) as Array<Record<string, unknown>>;
  const out: PartialEvent[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ kind: "assistant_text", turn_id: turnId, text: block.text } as PartialEvent);
    } else if (block.type === "tool_use") {
      out.push({
        kind: "tool_call_requested",
        turn_id: turnId,
        call_id: String(block.id ?? ""),
        tool: String(block.name ?? ""),
        args: block.input ?? {},
      } as unknown as PartialEvent);
    } else if (block.type === "thinking") {
      const text =
        typeof (block as Record<string, unknown>).thinking === "string"
          ? (block as Record<string, unknown>).thinking as string
          : typeof (block as Record<string, unknown>).text === "string"
          ? (block as Record<string, unknown>).text as string
          : "";
      out.push({ kind: "thinking", turn_id: turnId, text } as PartialEvent);
    }
  }
  return out;
}

function parseUserMessage(obj: Record<string, unknown>, turnId: string): PartialEvent[] {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const out: PartialEvent[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "tool_result") {
      out.push({
        kind: "tool_call_result",
        turn_id: turnId,
        call_id: String(block.tool_use_id ?? ""),
        result: block.content ?? null,
        is_error: Boolean(block.is_error),
      } as PartialEvent);
    }
  }
  return out;
}

/**
 * Context rotation: sum the input-side usage fields. Returns null (no reading) unless
 * usage is an object with at least one finite input-side field — a bare `{}`
 * or garbage must not read as 0 and reset the runner's tracking.
 */
function mainContextTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const fields = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  let sum = 0;
  let seen = false;
  for (const f of fields) {
    const v = u[f];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      seen = true;
    }
  }
  return seen ? sum : null;
}
