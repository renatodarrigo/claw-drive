import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isInsideHome } from "../../lib/paths.js";
import { validatePolicy, type Policy } from "../../lib/policy.js";
import { isValidAlias, findLiveAliasHolder } from "../../lib/alias.js";
import { parseFleetFlags } from "../../lib/fleet.js";
import {
  newSessionId,
  scaffoldSessionDir,
  spawnRunnerDetached,
  waitForReady,
} from "../../lib/spawn-session.js";

export async function cmdStart(argv: string[]): Promise<number> {
  // Fleets: --fleet TAG stamps the acting fleet (else CLAW_DRIVE_FLEET, else
  // the driver's Claude Code session id). --all-fleets has no meaning on
  // start and is refused rather than silently accepted.
  const fleet = parseFleetFlags(argv);
  if (!fleet.ok) {
    console.error(fleet.error);
    return 2;
  }
  if (fleet.view.allFleets) {
    console.error("--all-fleets is not a start flag");
    return 2;
  }
  const args = fleet.rest;
  let cwd: string | undefined;
  let policyFile: string | undefined;
  let briefFile: string | undefined;
  let wrapper: boolean | undefined;
  let alias: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") cwd = args[++i];
    else if (args[i] === "--policy") policyFile = args[++i];
    else if (args[i] === "--brief") briefFile = args[++i];
    else if (args[i] === "--no-wrapper") wrapper = false;
    else if (args[i] === "--name") alias = args[++i];
  }
  if (!cwd) {
    console.error("--cwd required");
    return 2;
  }
  const cwdAbs = path.resolve(cwd);

  try {
    const st = await fs.stat(cwdAbs);
    if (!st.isDirectory()) {
      console.error(`cwd is not a directory: ${cwdAbs}`);
      return 2;
    }
  } catch {
    console.error(`cwd does not exist: ${cwdAbs}`);
    return 2;
  }
  if (!isInsideHome(cwdAbs)) {
    console.error(`cwd must be inside $HOME: ${cwdAbs}`);
    return 2;
  }

  let policy: Policy = "bypass";
  if (policyFile) policy = JSON.parse(await fs.readFile(policyFile, "utf-8"));
  const pv = validatePolicy(policy);
  if (!pv.ok) {
    console.error(`invalid policy: ${(pv as any).error}`);
    return 2;
  }
  // CD-10: validate + uniqueness-check the alias BEFORE creating any session
  // dir/state, so an invalid or conflicting --name leaves nothing behind.
  if (alias !== undefined) {
    if (!isValidAlias(alias)) {
      console.error(
        `invalid --name '${alias}': alias must be 1-32 chars, start with a letter, ` +
          `use only letters/digits/_/-, and not begin with 'sess_'`
      );
      return 2;
    }
    const holder = await findLiveAliasHolder(alias);
    if (holder) {
      console.error(`alias '${alias}' is already in use by live session ${holder}`);
      return 2;
    }
  }

  const brief = briefFile ? await fs.readFile(briefFile, "utf-8") : undefined;

  // Honor decision_timeout_seconds from policy object if present
  const decisionTimeoutSec =
    typeof policy === "object" && policy !== null && "decision_timeout_seconds" in policy
      ? (policy as { decision_timeout_seconds?: number }).decision_timeout_seconds ?? 3600
      : 3600;

  const sessionId = newSessionId();
  await scaffoldSessionDir({
    sessionId,
    cwd: cwdAbs,
    policy,
    decisionTimeoutSeconds: decisionTimeoutSec,
    model: null,
    scenarioBrief: brief,
    wrapper,
    alias,
    fleet: fleet.view.acting,
  });
  spawnRunnerDetached(sessionId);
  if (await waitForReady(sessionId)) {
    console.log(sessionId);
    return 0;
  }
  console.error("runner did not become ready");
  return 1;
}
