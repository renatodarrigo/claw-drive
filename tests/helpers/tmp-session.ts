import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

export interface TmpSession {
  clawDriveRoot: string;
  binPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated CLAW_DRIVE_HOME and a test cwd, both under $HOME.
 * The cwd must be under $HOME because paths.isInsideHome rejects paths outside.
 */
export async function makeTmpSession(): Promise<TmpSession> {
  const tmpParent = path.join(os.homedir(), "tmp", "claw-drive-it");
  await fs.mkdir(tmpParent, { recursive: true });
  const clawDriveRoot = await fs.mkdtemp(path.join(tmpParent, "root-"));
  const cwd = await fs.mkdtemp(path.join(tmpParent, "cwd-"));
  // Seed a tiny file in cwd so B has something to read
  await fs.writeFile(path.join(cwd, "readme.txt"), "hello world\n");
  const binPath = path.resolve("bin/claw-drive");
  const env = { ...process.env, CLAW_DRIVE_HOME: clawDriveRoot };
  return {
    clawDriveRoot,
    binPath,
    env,
    cwd,
    cleanup: async () => {
      await fs.rm(clawDriveRoot, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

/**
 * Run the claw-drive binary as a child process, capturing stdout/stderr and
 * exit code. Returns after the process exits.
 */
export function runCliBlocking(
  binPath: string,
  env: NodeJS.ProcessEnv,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
