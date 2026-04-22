import * as net from "node:net";
import * as fs from "node:fs/promises";
import {
  decodeMessage,
  encodeMessage,
  type ControlRequest,
  type ControlResponse,
} from "../lib/socket-protocol.js";

export type RequestHandler = (req: ControlRequest) => Promise<ControlResponse>;

/**
 * Start a Unix socket server at `socketPath` that accepts newline-delimited
 * JSON control messages and dispatches each to `handler`. The handler's
 * response is written back on the same connection.
 */
export async function startSocketServer(
  socketPath: string,
  handler: RequestHandler
): Promise<net.Server> {
  // Remove any stale socket file (from a prior crashed runner)
  await fs.rm(socketPath, { force: true });

  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", async (chunk) => {
      buffer += chunk.toString("utf-8");
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let req: ControlRequest;
        try {
          req = decodeMessage(line) as ControlRequest;
        } catch (err) {
          conn.write(
            encodeMessage({
              id: "unknown",
              ok: false,
              error: "BAD_REQUEST",
              message: `parse error: ${(err as Error).message}`,
            })
          );
          continue;
        }
        try {
          const resp = await handler(req);
          conn.write(encodeMessage(resp));
        } catch (err) {
          conn.write(
            encodeMessage({
              id: req.id,
              ok: false,
              error: "HANDLER_ERROR",
              message: (err as Error).message,
            })
          );
        }
      }
    });
    conn.on("error", () => {
      /* ignore; client went away */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

/**
 * Open a connection, send one request, await one response, close.
 *
 * `timeoutMs === Number.POSITIVE_INFINITY` disables the client-side timer,
 * which is what the approver shim needs (the runner enforces its own
 * decision_timeout_seconds for held approvals).
 */
export async function sendRequest(
  socketPath: string,
  req: ControlRequest,
  timeoutMs: number = 5000
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    const unbounded = timeoutMs === Number.POSITIVE_INFINITY;
    const timer = unbounded
      ? null
      : setTimeout(() => {
          conn.destroy();
          reject(new Error("socket timeout"));
        }, timeoutMs);
    const clear = () => { if (timer) clearTimeout(timer); };

    let buffer = "";
    conn.on("connect", () => {
      conn.write(encodeMessage(req));
    });
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        clear();
        conn.destroy();
        try {
          resolve(decodeMessage(line) as ControlResponse);
        } catch (err) {
          reject(err as Error);
        }
      }
    });
    conn.on("error", (err) => {
      clear();
      reject(err);
    });
  });
}
