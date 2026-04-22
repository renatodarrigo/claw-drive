import { cmdSessions } from "./commands/sessions.js";
import { cmdShow } from "./commands/show.js";
import { cmdTail } from "./commands/tail.js";
import { cmdPending } from "./commands/pending.js";
import { cmdApprove } from "./commands/approve.js";
import { cmdReject } from "./commands/reject.js";
import { cmdSend } from "./commands/send.js";
import { cmdStart } from "./commands/start.js";
import { cmdStop } from "./commands/stop.js";
import { cmdInterrupt } from "./commands/interrupt.js";
import { cmdPolicy } from "./commands/policy.js";
import { cmdPrune } from "./commands/prune.js";
import { cmdWatch } from "./commands/watch.js";
import { cmdProvideOutput } from "./commands/provide-output.js";

const commands: Record<string, (argv: string[]) => Promise<number>> = {
  sessions: cmdSessions,
  show: cmdShow,
  tail: cmdTail,
  pending: cmdPending,
  approve: cmdApprove,
  reject: cmdReject,
  send: cmdSend,
  start: cmdStart,
  stop: cmdStop,
  interrupt: cmdInterrupt,
  policy: cmdPolicy,
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
  const handler = commands[cmd];
  if (!handler) {
    console.error(`unknown command: ${cmd}`);
    printUsage();
    process.exit(2);
  }
  const code = await handler(argv.slice(1));
  process.exit(code);
}

function printUsage(): void {
  console.log(`claw-drive — driver CLI

Commands:
  sessions                      List all sessions (including orphaned)
  show <session>                State + pending + recent events
  tail <session> [--since N] [--follow]
  watch <session> [--replay|--since N]
                                Stream human-actionable events as JSONL (for Monitor);
                                defaults to new events only; --replay = full history
  pending [<session>]           List awaiting-approval calls
  approve <call_id> [--reason R]
  reject <call_id> [--reason R]
  send <session> "<message>"    Send a user turn
  start --cwd <path> [--policy FILE] [--brief FILE]
  stop <session>
  interrupt <session> <turn>
  policy <session> [--set FILE] [--show]
  prune [--older-than 24h]
  provide-output <call_id> [--stdout S] [--stderr S] [--exit N] [--extra S] [--from-file PATH]
                                Relay human-run command output to a deferred call
`);
}
