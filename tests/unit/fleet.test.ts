import { describe, it, expect } from "vitest";
import {
  FLEET_TAG_RE,
  isValidFleetTag,
  resolveActingFleet,
  inFleetView,
  parseFleetFlags,
  FleetTagError,
  FLEET_FLAGS_SINGLE_FORM_ERROR,
  hiddenFleetsHint,
} from "../../src/lib/fleet.js";

const EMPTY: NodeJS.ProcessEnv = {};
const UUID = "f141e77b-1c83-49b8-8aa8-eb80c5cc5424";
const TAG_RULE =
  "a fleet tag is 1-64 chars of letters, digits, '_', '.', '-' and starts with a letter or digit";

describe("isValidFleetTag / FLEET_TAG_RE", () => {
  it("accepts 1..64 chars of the allowed set starting with a letter or digit", () => {
    expect(isValidFleetTag("a")).toBe(true);
    expect(isValidFleetTag("0")).toBe(true);
    expect(isValidFleetTag("a".repeat(64))).toBe(true);
    expect(isValidFleetTag(UUID)).toBe(true); // a Claude Code session id: 36 chars, hyphens
    expect(isValidFleetTag("reviewer")).toBe(true); // alias-shaped tags are fine too
    expect(isValidFleetTag("team.a_b-c")).toBe(true);
    expect(FLEET_TAG_RE.test("9-lives")).toBe(true);
  });

  it("rejects empty, 65 chars, a leading '-' / '_' / '.', spaces, and non-strings", () => {
    expect(isValidFleetTag("")).toBe(false);
    expect(isValidFleetTag("a".repeat(65))).toBe(false);
    expect(isValidFleetTag("-a")).toBe(false);
    expect(isValidFleetTag("_a")).toBe(false);
    expect(isValidFleetTag(".a")).toBe(false);
    expect(isValidFleetTag("a b")).toBe(false);
    expect(isValidFleetTag(undefined)).toBe(false);
    expect(isValidFleetTag(42)).toBe(false);
  });
});

describe("resolveActingFleet — precedence (flag > CLAW_DRIVE_FLEET > CLAUDE_CODE_SESSION_ID > none)", () => {
  it("returns undefined with no flag and an empty env", () => {
    expect(resolveActingFleet({ env: EMPTY })).toBeUndefined();
  });

  it("falls back to CLAUDE_CODE_SESSION_ID (observed Claude Code export)", () => {
    expect(resolveActingFleet({ env: { CLAUDE_CODE_SESSION_ID: UUID } })).toBe(UUID);
  });

  it("CLAW_DRIVE_FLEET beats CLAUDE_CODE_SESSION_ID", () => {
    expect(
      resolveActingFleet({ env: { CLAW_DRIVE_FLEET: "team-a", CLAUDE_CODE_SESSION_ID: UUID } })
    ).toBe("team-a");
  });

  it("the explicit flag beats both env vars", () => {
    expect(
      resolveActingFleet({
        flag: "explicit",
        env: { CLAW_DRIVE_FLEET: "team-a", CLAUDE_CODE_SESSION_ID: UUID },
      })
    ).toBe("explicit");
  });

  it("a malformed CLAUDE_CODE_SESSION_ID is ignored, not an error (it is not user input)", () => {
    expect(resolveActingFleet({ env: { CLAUDE_CODE_SESSION_ID: "-bad id" } })).toBeUndefined();
  });

  it("an empty CLAW_DRIVE_FLEET counts as unset", () => {
    expect(resolveActingFleet({ env: { CLAW_DRIVE_FLEET: "", CLAUDE_CODE_SESSION_ID: UUID } })).toBe(UUID);
  });

  it("an invalid flag throws FleetTagError with the --fleet wording", () => {
    expect(() => resolveActingFleet({ flag: "-x", env: EMPTY })).toThrow(FleetTagError);
    expect(() => resolveActingFleet({ flag: "-x", env: EMPTY })).toThrow(`invalid --fleet '-x': ${TAG_RULE}`);
  });

  it("an invalid CLAW_DRIVE_FLEET throws FleetTagError naming the variable", () => {
    expect(() => resolveActingFleet({ env: { CLAW_DRIVE_FLEET: "a b" } })).toThrow(
      `invalid CLAW_DRIVE_FLEET 'a b': ${TAG_RULE}`
    );
  });
});

describe("inFleetView — truth table", () => {
  const own = { acting: "A", allFleets: false };
  const widened = { acting: "A", allFleets: true };
  const none = { acting: undefined, allFleets: false };

  it("own fleet and untagged sessions are in view; other fleets are not", () => {
    expect(inFleetView({ fleet: "A" }, own)).toBe(true);
    expect(inFleetView({}, own)).toBe(true);
    expect(inFleetView({ fleet: "B" }, own)).toBe(false);
  });

  it("--all-fleets puts everything in view", () => {
    expect(inFleetView({ fleet: "B" }, widened)).toBe(true);
  });

  it("with no identity only untagged sessions are in view (strict, D7)", () => {
    expect(inFleetView({ fleet: "A" }, none)).toBe(false);
    expect(inFleetView({}, none)).toBe(true);
  });

  it("a null state counts as untagged", () => {
    expect(inFleetView(null, own)).toBe(true);
  });
});

describe("parseFleetFlags", () => {
  it("lifts --fleet from any position and keeps the rest in order", () => {
    expect(parseFleetFlags(["sess_x", "--fleet", "team-a", "--json"], EMPTY)).toEqual({
      ok: true,
      rest: ["sess_x", "--json"],
      view: { acting: "team-a", allFleets: false },
      flagsSeen: true,
    });
  });

  it("lifts --all-fleets", () => {
    expect(parseFleetFlags(["--all-fleets", "--replay"], EMPTY)).toEqual({
      ok: true,
      rest: ["--replay"],
      view: { acting: undefined, allFleets: true },
      flagsSeen: true,
    });
  });

  it("with no flags, flagsSeen is false and the view comes from the env", () => {
    const r = parseFleetFlags(["x"], { CLAUDE_CODE_SESSION_ID: UUID });
    expect(r).toEqual({ ok: true, rest: ["x"], view: { acting: UUID, allFleets: false }, flagsSeen: false });
  });

  it("--fleet without a value, or followed by another flag, is an error", () => {
    expect(parseFleetFlags(["--fleet"], EMPTY)).toEqual({ ok: false, error: "--fleet requires a tag" });
    expect(parseFleetFlags(["--fleet", "--all-fleets"], EMPTY)).toEqual({ ok: false, error: "--fleet requires a tag" });
  });

  it("--fleet and --all-fleets together are mutually exclusive", () => {
    expect(parseFleetFlags(["--fleet", "a", "--all-fleets"], EMPTY)).toEqual({
      ok: false,
      error: "--fleet and --all-fleets are mutually exclusive",
    });
  });

  it("an invalid tag surfaces the FleetTagError text as { ok: false }", () => {
    expect(parseFleetFlags(["--fleet", "-x"], EMPTY)).toEqual({
      ok: false,
      error: `invalid --fleet '-x': ${TAG_RULE}`,
    });
  });

  it("an invalid CLAW_DRIVE_FLEET in the env is reported the same way", () => {
    expect(parseFleetFlags([], { CLAW_DRIVE_FLEET: "a b" })).toEqual({
      ok: false,
      error: `invalid CLAW_DRIVE_FLEET 'a b': ${TAG_RULE}`,
    });
  });

  it("stops lifting at a bare '--' and passes it (and everything after) through", () => {
    expect(parseFleetFlags(["--all", "--", "--fleet"], EMPTY)).toEqual({
      ok: true,
      rest: ["--all", "--", "--fleet"],
      view: { acting: undefined, allFleets: false },
      flagsSeen: false,
    });
  });
});

describe("shared strings", () => {
  it("hiddenFleetsHint is singular for 1 and plural otherwise", () => {
    expect(hiddenFleetsHint(1)).toBe("(1 session in other fleets hidden; --all-fleets shows them)");
    expect(hiddenFleetsHint(3)).toBe("(3 sessions in other fleets hidden; --all-fleets shows them)");
  });

  it("the single-form error is the spec's wording", () => {
    expect(FLEET_FLAGS_SINGLE_FORM_ERROR).toBe("--fleet/--all-fleets apply only to the fleet view");
  });
});
