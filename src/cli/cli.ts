import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

const commands: Record<string, (argv: string[]) => Promise<number>> = {
  sessions: cmdSessions,
  show: cmdShow,
  tail: cmdTail,
  pending: cmdPending,
  approve: cmdApprove,
  reject: cmdReject,
  defer: cmdDefer,
  send: cmdSend,
  start: cmdStart,
  stop: cmdStop,
  interrupt: cmdInterrupt,
  policy: cmdPolicy,
  "policy-test": cmdPolicyTest,
  status: cmdStatus,
  prune: cmdPrune,
  watch: cmdWatch,
  "provide-output": cmdProvideOutput,
};

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(getVersion());
    process.exit(0);
  }
  const handler = commands[cmd];
  if (!handler) {
    console.error(`unknown command: ${cmd}`);
    printUsage();
    process.exit(2);
  }
  const code = await handler(argv.slice(1));
  process.exit(code);
}

export function getVersion(): string {
  // dist/cli/cli.js → ../../VERSION (single source of truth at repo root)
  const here = fileURLToPath(import.meta.url);
  const versionPath = resolve(dirname(here), "..", "..", "VERSION");
  return readFileSync(versionPath, "utf8").trim();
}

function printUsage(): void {
  console.log(`claw-drive — driver CLI

Flags:
  --version, -v                 Print the installed version and exit
  --help, -h                    Print this help and exit

Commands:
  sessions                      List all sessions (including orphaned)
  show <session>                State + pending + recent events
  tail <session> [--since N] [--follow]
  watch <session> [--replay|--since N]
                                Stream human-actionable events as JSONL (for Monitor);
                                defaults to new events only; --replay = full history
  watch --all [same flags]      Merge every live session into one session_id-tagged
                                stream; dynamic membership; runs until SIGINT
  pending [<session>]           List awaiting-approval calls
  approve <call_id> [--reason R]
  reject <call_id> [--reason R]
  send <session> "<message>"    Send a user turn
  start --cwd <path> [--policy FILE] [--brief FILE] [--name <alias>]
  stop <session>
  interrupt <session> <turn>
  policy <session> [--set FILE] [--show]
  policy lint <file> [--check-coverage] [--json] [--max-severity warn|error]
                                Analyze a policy file for structural problems
                                (regex compile, shadowed/unreachable, overly-broad, known-FP)
  policy-test '<command>' [--policy starter|permissive|bypass|<file>] [--explain|--json]
                                Diagnose a tool call against a policy (Bash + non-Bash tools)
  status [<session>] [--json]   Snapshot of all (or one) driven session: state, current turn, pending decisions, recent errors
  prune [--older-than 24h]
  provide-output <call_id> [--stdout S] [--stderr S] [--exit N] [--extra S] [--from-file PATH]
                                Relay human-run command output to a deferred call
`);
}
