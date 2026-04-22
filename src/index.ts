import { runMcpServer } from "./mcp/server.js";
import { runRunner } from "./runner/runner.js";
import { runCli } from "./cli/cli.js";

const mode = process.argv[2];

async function main(): Promise<void> {
  switch (mode) {
    case "mcp":
      await runMcpServer();
      break;
    case "runner": {
      const id = process.argv[3];
      if (!id) {
        console.error("usage: claw-drive runner <session_id>");
        process.exit(2);
      }
      await runRunner(id);
      break;
    }
    default:
      // Everything else is a CLI subcommand (sessions, show, tail, send, etc.)
      // or --help.
      await runCli(process.argv.slice(2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
