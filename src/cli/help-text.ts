import { COMMANDS, type CommandGroup } from "./registry.js";
import { MCP_TOOL_DEFS } from "../mcp/tool-defs.js";

const CONCEPTS = `claw-drive — capability map

You are Session A, the driver. claw-drive runs and supervises a second Claude
Code session (Session B) as if you were its human operator: you start B in a
real project directory, send it turns, watch what it does, and approve or reject
the tool calls it tries to make. Every one of B's tool calls is checked against
a permission policy before it runs; anything the policy doesn't auto-decide
pauses and surfaces to you. You see only the events that need a human.

WHAT CLAW-DRIVE IS
  A drive-as-user layer for Claude Code. A (you) drives B (the work session)
  through claw-drive's MCP tools and CLI. claw-drive owns the policy gate, the
  event stream, and the human-in-the-loop decision queue.

MENTAL MODEL
  Session A      you, the orchestrator (this session).
  Session B      a real claude process claw-drive spawns in a project cwd; it
                 does the actual work.
  Runner         the per-session process that supervises B, applies the policy,
                 and appends events to the session's log.
  Approver hook  the gate B's tool calls pass through; auto_approve/auto_reject
                 resolve here, escalate/auto_defer pause for you.
  Events flow A <- B. Consume them with 'watch' (for the Monitor tool) or 'tail'.

THE DRIVING LOOP
  1. start    spawn B in a cwd with a policy (and optional brief).
  2. watch    stream B's human-actionable events (approvals, completions,
              errors). Feed the start_session watch_command to Monitor.
  3. resolve  when a tool call pauses: approve / reject / defer it; for a review
              gate, send B the go-ahead.
  4. send     give B its next instruction as a user turn.
  5. stop     reap B when the task is done.
  Sentinel vocabulary: B emits [NEEDS-INPUT] when it needs you and [DONE] when
  the task is complete; watch surfaces a turn as actionable only when one of
  those trailing tokens is present. An idle event fires when a session goes
  quiet (default 600s). A silent-miss backstop catches turns that end without a
  sentinel.

POLICY & SAFETY
  Each session runs under a policy of ordered rules. Rule verbs:
    auto_approve   let the call run, no human.
    auto_reject    deny it, no human.
    escalate       pause and ask you.
    auto_defer     deny in B and hand the command to the human to run locally;
                   feed the result back with provide-output.
  Templates: starter (conservative, the default), permissive (adds common dev
  CLIs), bypass (approve everything — sandboxes only). A session budget /
  circuit-breaker caps spend and trips on repeated failures. Unresolved
  decisions fail secure after decision_timeout_seconds (default 3600). Lint a
  policy with 'policy lint'; dry-run a command against one with 'policy-test'.

FLEET
  'watch --all' merges every live session into one session_id-tagged stream with
  dynamic membership. Name sessions with 'start --name'. 'status' snapshots one
  or all sessions: state, current turn, pending decisions, recent errors.
`;

const POINTERS = `LEARN MORE
  README.md and THREAT-MODEL.md in the repo; https://renatodarrigo.github.io/claw-drive/.
  start_session returns a notification_contract describing the session's
  vocabulary and watch defaults — read it instead of hardcoding to a version.
`;

const GROUP_ORDER = ["lifecycle", "observe", "decide", "policy", "maintenance"] as const satisfies readonly CommandGroup[];
// Compile-time exhaustiveness: every CommandGroup must appear in GROUP_ORDER, so a new
// group can't silently drop its commands from the rendered guide.
type _AllGroupsOrdered = CommandGroup extends (typeof GROUP_ORDER)[number] ? true : never;
const _allGroupsOrdered: _AllGroupsOrdered = true;
void _allGroupsOrdered;
const GROUP_TITLES: Record<CommandGroup, string> = {
  lifecycle: "Session lifecycle",
  observe: "Observe",
  decide: "Resolve decisions",
  policy: "Policy",
  maintenance: "Maintenance",
};

function renderCommands(): string {
  const lines: string[] = ["CLI COMMANDS", "  Run as: claw-drive <command>", ""];
  for (const group of GROUP_ORDER) {
    const entries = COMMANDS.filter((c) => c.group === group);
    if (entries.length === 0) continue;
    lines.push(`  ${GROUP_TITLES[group]}`);
    for (const c of entries) {
      lines.push(`    ${c.name}`);
      lines.push(`        ${c.summary}`);
      lines.push(`        usage: ${c.usage}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderTools(): string {
  const lines: string[] = ["MCP TOOLS", "  Call from an MCP client via the claw-drive MCP server.", ""];
  for (const t of MCP_TOOL_DEFS) {
    lines.push(`    ${t.name}`);
    lines.push(`        ${t.description}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderHelp(): string {
  return [CONCEPTS, renderCommands(), renderTools(), POINTERS].join("\n");
}
