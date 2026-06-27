/**
 * Quoting-aware scan of a Bash command string for the per-segment policy mode.
 * Splits at top-level command separators so each segment can be policy-evaluated
 * independently, and flags "opaque" constructs the segmenter cannot reason about
 * (command/process substitution, here-docs/here-strings). Operators inside
 * single/double quotes or after a backslash are literal and never split.
 *
 * Cooperative-not-adversarial: this is precision against false positives on a
 * well-intentioned agent's real commands, not a defense against obfuscation.
 * See docs/superpowers/specs/2026-06-25-bash-composition-per-segment-design.md.
 */
export interface CompositionAnalysis {
  segments: string[];
  opaque: boolean;
  malformed: boolean;
}

export function analyzeComposition(command: string): CompositionAnalysis {
  const segments: string[] = [];
  let buf = "";
  let opaque = false;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const n = command.length;

  const flush = (): void => {
    segments.push(buf.trim());
    buf = "";
  };

  while (i < n) {
    const c = command[i];
    const c2 = command.slice(i, i + 2);

    // Backslash escape (not inside single quotes): take the next char literally.
    if (!inSingle && c === "\\") {
      buf += command.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (inDouble) {
      // Substitution is live inside double quotes; operators are not.
      if (c2 === "$(") { opaque = true; buf += c2; i += 2; continue; }
      if (c === "`") { opaque = true; buf += c; i += 1; continue; }
      if (c === '"') inDouble = false;
      buf += c;
      i += 1;
      continue;
    }

    // --- top level (outside all quotes) ---
    if (c === "'") { inSingle = true; buf += c; i += 1; continue; }
    if (c === '"') { inDouble = true; buf += c; i += 1; continue; }

    // Opaque constructs (presence ⇒ reject). Bare '(' / '{' are intentionally
    // absent: they false-positive on brace-expansion and array assignment.
    if (c2 === "$(" || c2 === "<(" || c2 === ">(" || c2 === "<<") {
      opaque = true; buf += c2; i += 2; continue;
    }
    if (c === "`") { opaque = true; buf += c; i += 1; continue; }

    // Two-char split operators (longest match first).
    if (c2 === "&&" || c2 === "||" || c2 === "|&") { flush(); i += 2; continue; }

    // One-char separators.
    if (c === ";" || c === "|" || c === "\n") { flush(); i += 1; continue; }

    // '&' splits only as a true background operator, not as part of a redirect
    // (2>&1, >&2, &>file).
    if (c === "&") {
      const prev = i > 0 ? command[i - 1] : "";
      const next = i + 1 < n ? command[i + 1] : "";
      if (prev === ">" || prev === "<" || next === ">") {
        buf += c; i += 1; continue;
      }
      flush(); i += 1; continue;
    }

    buf += c;
    i += 1;
  }
  flush();

  const malformed = segments.some((s) => s.length === 0);
  return { segments, opaque, malformed };
}
