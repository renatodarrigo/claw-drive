import { describe, it, expect } from "vitest";
import { analyzeComposition } from "../../src/lib/bash-composition.js";

describe("analyzeComposition", () => {
  it("a plain command is a single, non-opaque segment", () => {
    const a = analyzeComposition("git status");
    expect(a.segments).toEqual(["git status"]);
    expect(a.opaque).toBe(false);
    expect(a.malformed).toBe(false);
  });

  it("splits on each sequencing/pipe operator at top level", () => {
    expect(analyzeComposition("a && b").segments).toEqual(["a", "b"]);
    expect(analyzeComposition("a || b").segments).toEqual(["a", "b"]);
    expect(analyzeComposition("a ; b").segments).toEqual(["a", "b"]);
    expect(analyzeComposition("a | b").segments).toEqual(["a", "b"]);
    expect(analyzeComposition("a |& b").segments).toEqual(["a", "b"]);
    expect(analyzeComposition("echo a & echo b").segments).toEqual(["echo a", "echo b"]);
    expect(analyzeComposition("a\nb").segments).toEqual(["a", "b"]);
  });

  it("longest-match: && is not two & splits, || not two |", () => {
    expect(analyzeComposition("a && b").segments).toEqual(["a", "b"]);
    expect(analyzeComposition("a || b").segments).toEqual(["a", "b"]);
  });

  it("does not split operators inside single or double quotes or after a backslash", () => {
    expect(analyzeComposition('git commit -m "fix: a && b"').segments).toEqual([
      'git commit -m "fix: a && b"',
    ]);
    expect(analyzeComposition("grep 'a | b' file").segments).toEqual(["grep 'a | b' file"]);
    expect(analyzeComposition("echo a\\;b").segments).toEqual(["echo a\\;b"]);
  });

  it("flags command/process substitution and here-docs as opaque", () => {
    expect(analyzeComposition("REPO=$(pwd)").opaque).toBe(true);
    expect(analyzeComposition("echo `date`").opaque).toBe(true);
    expect(analyzeComposition("diff <(a) <(b)").opaque).toBe(true);
    expect(analyzeComposition("tee >(cat)").opaque).toBe(true);
    expect(analyzeComposition("cat <<EOF").opaque).toBe(true);
    expect(analyzeComposition('echo "x $(id) y"').opaque).toBe(true);
  });

  it("redirect-& does NOT split; brace-expansion/array are NOT opaque", () => {
    expect(analyzeComposition("npm test 2>&1").segments).toEqual(["npm test 2>&1"]);
    expect(analyzeComposition("echo hi >&2").segments).toEqual(["echo hi >&2"]);
    expect(analyzeComposition("cmd &>out").segments).toEqual(["cmd &>out"]);
    expect(analyzeComposition("mkdir -p src/{a,b}").opaque).toBe(false);
    expect(analyzeComposition("mkdir -p src/{a,b}").segments).toEqual(["mkdir -p src/{a,b}"]);
    expect(analyzeComposition("arr=(a b)").opaque).toBe(false);
    expect(analyzeComposition("${VAR}").opaque).toBe(false);
  });

  it("lone redirects stay in-segment", () => {
    expect(analyzeComposition("npm test > out.log").segments).toEqual(["npm test > out.log"]);
    expect(analyzeComposition("cat < in.txt").segments).toEqual(["cat < in.txt"]);
  });

  it("empty/leading/double operators, and trailing connectors, are malformed", () => {
    expect(analyzeComposition("git status &&").malformed).toBe(true);
    expect(analyzeComposition("| foo").malformed).toBe(true);
    expect(analyzeComposition("ls ;; ls").malformed).toBe(true);
    // Trailing CONNECTORS leave a missing right operand → still malformed.
    expect(analyzeComposition("git status ||").malformed).toBe(true);
    expect(analyzeComposition("cat x |").malformed).toBe(true);
    // Entirely empty / whitespace-only stays malformed.
    expect(analyzeComposition("").malformed).toBe(true);
    expect(analyzeComposition("   ").malformed).toBe(true);
  });

  it("a trailing TERMINATOR (; or &) completes the command — not malformed", () => {
    // Regression: the starter ships per_segment ON, and `npm run dev &` was
    // being denied as "malformed" because the trailing background `&` left an
    // empty final segment. A terminator completes a command; drop the empty tail.
    const amp = analyzeComposition("npm run dev &");
    expect(amp.malformed).toBe(false);
    expect(amp.segments).toEqual(["npm run dev"]);

    const semi = analyzeComposition("git status ;");
    expect(semi.malformed).toBe(false);
    expect(semi.segments).toEqual(["git status"]);

    // A terminator BETWEEN two commands still splits both (unchanged).
    expect(analyzeComposition("echo a & echo b").segments).toEqual(["echo a", "echo b"]);
  });
});
