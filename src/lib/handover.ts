/**
 * context-rotation handover machinery: the baked-in versioned template + instruction turn
 * sent to a rotating session, the marker extractor, and the successor-brief
 * composer. All pure (no I/O) so every piece is unit-testable.
 *
 * Design notes (spec: 2026-07-29-context-rotation-design.md):
 * - Section 1 of the 9-section template — the ORIGINAL MISSION — is
 *   runner-prepended verbatim by composeSuccessorBrief; B is explicitly told
 *   NOT to restate it. That is the anti-telephone-game guard: no generation
 *   ever paraphrases the task spec.
 * - The handover travels as pure assistant text between <handover> markers —
 *   no Write tool, so it works under any policy (the starter policy rejects
 *   writes into ~/.claw-drive/**) and cannot stall on an escalation.
 */

export const HANDOVER_TEMPLATE_VERSION = 1;

const SECTION_GUIDE = `Sections, in order (use these exact markdown headings):
## Current objective
   The sub-goal you are pursuing right now, and why it is the current one.
## Progress ledger
   Done / in-progress / not-started — each with concrete anchors: file paths,
   commit hashes, test names. Claims, not vibes.
## Decisions made
   Each decision WITH its rationale, so the successor never re-litigates
   settled questions.
## Dead ends and discovered constraints
   What was tried and abandoned (and why), environment quirks, gotchas.
## Workspace state (believed)
   Branch, uncommitted changes, background processes you started, files
   mid-edit. Labelled "believed" — you are writing from memory.
## Verify on arrival
   The exact commands the successor must run BEFORE trusting the section
   above (e.g. git status, the relevant test command).
## Next steps
   Ordered and concrete; the first one immediately executable.
## Pending human threads
   Unresolved questions, deferred commands awaiting output, anything
   mid-escalation.`;

const CORE_INSTRUCTION = `[claw-drive rotation] Your context window is nearly full. This session is being
replaced by a fresh successor session that will continue the task from a
handover document you write now.

Respond with ONLY the handover document, wrapped exactly in <handover> and
</handover> markers. Rules:
- No tool calls. Write from what you already know; the successor verifies.
- Do NOT end with a sentinel token ([NEEDS-INPUT] / [DONE]) — this turn is
  consumed by machinery, not by the driver.
- Do NOT restate the original mission brief; the runner delivers it to the
  successor verbatim.
- Be complete but compact: target under ~2,500 tokens. The successor's
  context window is the resource you are conserving.

${SECTION_GUIDE}`;

export function buildHandoverInstruction(opts: { attempt: 1 | 2 }): string {
  if (opts.attempt === 2) {
    return (
      "SECOND ATTEMPT — your previous response contained no extractable " +
      "<handover> block. Output ONLY the two markers and the handover document " +
      "between them, nothing else.\n\n" +
      CORE_INSTRUCTION
    );
  }
  return CORE_INSTRUCTION;
}

const HANDOVER_RE = /<handover>([\s\S]*?)<\/handover>/;

/**
 * Pull the handover body out of a turn's concatenated assistant text.
 * Tolerant of preamble/postamble outside the markers (including a stray
 * sentinel token — it lands outside and is simply dropped). Returns null on
 * no markers or an empty body — the caller treats that as a failed attempt.
 */
export function extractHandover(turnText: string): string | null {
  const m = HANDOVER_RE.exec(turnText);
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body : null;
}

export interface SuccessorBriefInput {
  originalBrief: string;
  handover: string;
  /** The SUCCESSOR's generation (predecessor + 1). */
  generation: number;
  /** Effective cap (config value with the default already applied); 0 = unlimited. */
  maxGenerations: number;
  predecessorId: string;
  predecessorEventsPath: string;
}

export function composeSuccessorBrief(input: SuccessorBriefInput): string {
  const genPhrase =
    input.maxGenerations > 0
      ? `generation ${input.generation} of ${input.maxGenerations}`
      : `generation ${input.generation} (no generation cap)`;
  const finalNotice =
    input.maxGenerations > 0 && input.generation >= input.maxGenerations
      ? `\nFINAL GENERATION NOTICE: this lineage is at or past its generation cap — ` +
        `no automatic successor (rotation or auto-respawn) will follow; only a manual ` +
        `recover may extend the lineage. Prioritize reaching a clean stopping point; ` +
        `do not open new work fronts.\n`
      : "";
  return `[claw-drive rotation] You are ${genPhrase}, continuing an in-progress task. Your predecessor session (${input.predecessorId}) reached its context threshold and wrote the handover below. The ORIGINAL MISSION is reproduced verbatim first — it is the authoritative task spec; the handover describes progress against it. Read the handover, run its "Verify on arrival" commands BEFORE trusting its workspace claims, then continue from "Next steps".
${finalNotice}
Predecessor's full event log (consult only if the handover leaves you blocked; grep/tail selectively, never read wholesale): ${input.predecessorEventsPath}

=== ORIGINAL MISSION (verbatim) ===
${input.originalBrief}
=== END ORIGINAL MISSION ===

=== PREDECESSOR HANDOVER (written by generation ${input.generation - 1}) ===
${input.handover}
=== END HANDOVER ===`;
}
