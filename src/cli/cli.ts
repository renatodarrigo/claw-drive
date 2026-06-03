import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { COMMANDS } from "./registry.js";
import { renderHelp } from "./help-text.js";

const dispatch: Record<string, (argv: string[]) => Promise<number>> =
  Object.fromEntries(COMMANDS.map((c) => [c.name, c.handler]));
const COMMAND_NAMES = COMMANDS.map((c) => c.name).join(", ");

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(renderHelp());
    process.exit(0);
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(getVersion());
    process.exit(0);
  }
  const handler = dispatch[cmd];
  if (!handler) {
    console.error(
      `unknown command: ${cmd}\n` +
        `commands: ${COMMAND_NAMES}\n` +
        `Run 'claw-drive help' for concepts, MCP tools, and examples.`,
    );
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
