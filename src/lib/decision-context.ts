/**
 * CD-8 decision-context enrichment. Pure helper (no I/O, no clock, no globals)
 * that turns a tool call + its surrounding context into a glanceable
 * `{ rationale?, diff? }` for the human/driver resolving an escalation. The
 * runner supplies the already-resolved strings (preceding assistant_text, and
 * for Write the existing file content); this module only formats + caps them,
 * so every consumer (pending, status, MCP poll) gets the same bounded payload.
 */

/** Head-truncation cap for the rationale snippet (matches status.ts's 1000-char convention). */
export const RATIONALE_CAP = 1000;
/** Bound for the rendered diff (~4 KiB from the design doc). The capped diff never exceeds this. */
export const DIFF_CAP = 4096;

const MARKER = "…";

export interface DecisionContextInput {
  tool: string;
  args: unknown;
  /** The same turn's preceding assistant_text, if any (the runner resolves this). */
  priorAssistantText?: string;
  /** For Write: the existing target file's content, if it exists (the runner reads this). */
  existingFileContent?: string;
}

export interface DecisionContext {
  rationale?: string;
  diff?: string;
}

/** Split into lines, dropping a single trailing newline so "a\nb\n" → ["a","b"]. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Minimal dependency-free unified-diff formatter: the old block as `-` lines
 * and the new block as `+` lines under standard `---`/`+++`/`@@` headers. The
 * inputs are already-scoped snippets (an Edit's old/new_string, or a file
 * body), so a full block is the clearest, deterministic representation.
 */
function unifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join("\n");
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** Render the diff for an Edit/Write call, or undefined when not applicable. */
function renderDiff(input: DecisionContextInput): string | undefined {
  const args = (input.args ?? {}) as Record<string, unknown>;
  const filePath = isStr(args.file_path) ? args.file_path : "(file)";

  if (input.tool === "Edit") {
    if (!isStr(args.old_string) || !isStr(args.new_string)) return undefined;
    return unifiedDiff(args.old_string, args.new_string, filePath);
  }
  if (input.tool === "Write") {
    if (!isStr(args.content)) return undefined;
    // Diff against the existing file when the runner resolved it; otherwise
    // render the content verbatim as the added body (new-file semantics).
    return unifiedDiff(input.existingFileContent ?? "", args.content, filePath);
  }
  return undefined;
}

export function buildDecisionContext(input: DecisionContextInput): DecisionContext {
  const ctx: DecisionContext = {};

  if (isStr(input.priorAssistantText) && input.priorAssistantText.length > 0) {
    const t = input.priorAssistantText;
    // Rationale: cap content at RATIONALE_CAP, marker appended beyond it.
    ctx.rationale = t.length > RATIONALE_CAP ? t.slice(0, RATIONALE_CAP) + MARKER : t;
  }

  const diff = renderDiff(input);
  if (diff !== undefined) {
    // Diff: the marker counts toward DIFF_CAP so the result never exceeds it.
    ctx.diff =
      diff.length > DIFF_CAP ? diff.slice(0, DIFF_CAP - MARKER.length) + MARKER : diff;
  }

  return ctx;
}
