import { cmdSessions } from "./commands/sessions.js";
import { cmdShow } from "./commands/show.js";
import { cmdTail } from "./commands/tail.js";
import { cmdPending } from "./commands/pending.js";
import { cmdApprove } from "./commands/approve.js";
import { cmdReject } from "./commands/reject.js";
import { cmdDefer } from "./commands/defer.js";
import { cmdSend } from "./commands/send.js";
import { cmdStart } from "./commands/start.js";
import { cmdStop } from "./commands/stop.js";
import { cmdInterrupt } from "./commands/interrupt.js";
import { cmdPolicy } from "./commands/policy.js";
import { cmdPrune } from "./commands/prune.js";
import { cmdWatch } from "./commands/watch.js";
import { cmdProvideOutput } from "./commands/provide-output.js";
import { cmdPolicyTest } from "./commands/policy-test.js";
import { cmdStatus } from "./commands/status.js";

export type CommandGroup = "lifecycle" | "observe" | "decide" | "policy" | "maintenance";

export interface CommandEntry {
  name: string;
  group: CommandGroup;
  summary: string;
  usage: string;
  handler: (argv: string[]) => Promise<number>;
}

export const COMMANDS: readonly CommandEntry[] = [
  // Session lifecycle
  { name: "start", group: "lifecycle",
    summary: "Spawn a driven session (B) in a project cwd.",
    usage: "start --cwd <path> [--policy FILE] [--brief FILE] [--name <alias>]",
    handler: cmdStart },
  { name: "send", group: "lifecycle",
    summary: "Send B a user turn.",
    usage: "send <session> \"<message>\"",
    handler: cmdSend },
  { name: "interrupt", group: "lifecycle",
    summary: "SIGINT the current turn; the session stays alive.",
    usage: "interrupt <session> <turn>",
    handler: cmdInterrupt },
  { name: "stop", group: "lifecycle",
    summary: "Reap a session's Claude process; keep its dir for inspection.",
    usage: "stop <session>",
    handler: cmdStop },
  // Observe
  { name: "sessions", group: "observe",
    summary: "List all sessions, including orphaned ones.",
    usage: "sessions",
    handler: cmdSessions },
  { name: "status", group: "observe",
    summary: "Snapshot of one or all sessions: state, turn, pending decisions, recent errors.",
    usage: "status [<session>] [--json]",
    handler: cmdStatus },
  { name: "show", group: "observe",
    summary: "State + pending decisions + recent events for one session.",
    usage: "show <session>",
    handler: cmdShow },
  { name: "tail", group: "observe",
    summary: "Print a session's event log.",
    usage: "tail <session> [--since N] [--follow]",
    handler: cmdTail },
  { name: "watch", group: "observe",
    summary: "Stream human-actionable events as JSONL for Monitor; --all merges every live session.",
    usage: "watch <session|--all> [--replay|--since N]",
    handler: cmdWatch },
  { name: "pending", group: "observe",
    summary: "List tool calls awaiting a human decision.",
    usage: "pending [<session>]",
    handler: cmdPending },
  // Resolve decisions
  { name: "approve", group: "decide",
    summary: "Approve a paused tool call.",
    usage: "approve <call_id> [--reason R]",
    handler: cmdApprove },
  { name: "reject", group: "decide",
    summary: "Reject a paused tool call.",
    usage: "reject <call_id> [--reason R]",
    handler: cmdReject },
  { name: "defer", group: "decide",
    summary: "Defer a paused tool call to the human to run locally.",
    usage: "defer <call_id> [--reason R]",
    handler: cmdDefer },
  { name: "provide-output", group: "decide",
    summary: "Relay a human-run command's output back to a deferred call.",
    usage: "provide-output <call_id> [--stdout S] [--stderr S] [--exit N] [--extra S] [--from-file PATH]",
    handler: cmdProvideOutput },
  // Policy
  { name: "policy", group: "policy",
    summary: "Show or replace a session's policy; `policy lint <file>` analyzes a policy file.",
    usage: "policy <session> [--set FILE] [--show]  |  policy lint <file> [--check-coverage] [--json] [--max-severity warn|error]",
    handler: cmdPolicy },
  { name: "policy-test", group: "policy",
    summary: "Dry-run a command against a policy to see the decision.",
    usage: "policy-test '<command>' [--policy starter|permissive|bypass|<file>] [--explain|--json]",
    handler: cmdPolicyTest },
  // Maintenance
  { name: "prune", group: "maintenance",
    summary: "Delete old stopped/orphaned session dirs.",
    usage: "prune [--older-than 24h]",
    handler: cmdPrune },
];
