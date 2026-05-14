/**
 * `unerr --mcp` bridge — thin stdio ↔ UDS relay with heartbeat.
 *
 * Sole job: forward MCP JSON-RPC frames between the IDE's stdio and the
 * per-repo `unerr` process's UDS socket. The bridge imports **no** modules
 * from `src/intelligence/` or `src/behaviors/` (Layer 12 DM-0 invariant) —
 * all graph / fact / ledger work lives in the per-repo process.
 *
 * Heartbeat:
 *   - Sends JSON-RPC `unerr/ping` every 5 s, expects `unerr/pong` within 2 s
 *   - 3 missed heartbeats → bridge resolves with reason="daemon_dead"
 *   - Caller (cli.ts mcpBoot) prints an error and exits 1; DM-3 will add
 *     auto-spawn so the user never has to start the proxy manually.
 *
 * Protocol: newline-delimited JSON-RPC over UDS (matches TransportMux).
 */

import { type Socket, connect } from "node:net";

/** stderr-only logger. stdout is MCP territory. */
const log = {
  info: (msg: string) => process.stderr.write(`[unerr:bridge] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerr:bridge] WARN: ${msg}\n`),
};

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 2_000;
const MAX_MISSED_HEARTBEATS = 3;

export interface BridgeResult {
  /** Why the bridge closed. */
  reason: "socket_closed" | "daemon_dead" | "stdin_closed" | "connect_error";
}

/**
 * Start bridging stdin/stdout to the proxy's UDS socket.
 * Returns when the connection closes, with a reason indicating why.
 */
export function startUdsBridge(sockPath: string): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(sockPath);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let missedHeartbeats = 0;
    let pendingPing = false;
    let resolved = false;

    function cleanup(reason: BridgeResult["reason"]) {
      if (resolved) return;
      resolved = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
      if (!socket.destroyed) socket.destroy();
      resolve({ reason });
    }

    socket.on("connect", () => {
      log.info(`Connected to proxy at ${sockPath}`);

      // stdin → UDS: forward MCP requests from IDE to proxy
      process.stdin.on("data", (chunk: Buffer) => {
        if (!socket.destroyed) {
          socket.write(chunk);
        }
      });

      // UDS → stdout: forward MCP responses from proxy to IDE
      socket.on("data", (data: Buffer) => {
        // Check if this is a heartbeat pong response
        const str = data.toString();
        if (str.includes('"unerr/pong"')) {
          missedHeartbeats = 0;
          pendingPing = false;
          if (heartbeatTimeoutTimer) {
            clearTimeout(heartbeatTimeoutTimer);
            heartbeatTimeoutTimer = undefined;
          }
          // Filter out pong from data sent to IDE — find and remove the pong line
          const lines = str.split("\n");
          const filtered = lines.filter((l) => !l.includes('"unerr/pong"'));
          const remaining = filtered.join("\n");
          if (remaining.trim().length > 0) {
            process.stdout.write(remaining);
          }
          return;
        }
        process.stdout.write(data);
      });

      // Start heartbeat monitoring
      heartbeatTimer = setInterval(() => {
        if (socket.destroyed) {
          cleanup("daemon_dead");
          return;
        }

        if (pendingPing) {
          // Previous ping didn't get a pong
          missedHeartbeats++;
          if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
            log.warn(
              `${MAX_MISSED_HEARTBEATS} heartbeats missed — daemon appears dead`,
            );
            cleanup("daemon_dead");
            return;
          }
        }

        // Send heartbeat ping as JSON-RPC notification
        pendingPing = true;
        const ping = JSON.stringify({
          jsonrpc: "2.0",
          method: "unerr/ping",
          params: { ts: Date.now() },
        });
        try {
          socket.write(ping + "\n");
        } catch {
          cleanup("daemon_dead");
          return;
        }

        // Set timeout for this specific ping
        heartbeatTimeoutTimer = setTimeout(() => {
          // Ping timed out — increment missed count (handled on next interval)
          heartbeatTimeoutTimer = undefined;
        }, HEARTBEAT_TIMEOUT_MS);
      }, HEARTBEAT_INTERVAL_MS);
    });

    socket.on("close", () => {
      log.info("Proxy connection closed");
      cleanup("socket_closed");
    });

    socket.on("error", (err) => {
      log.warn(`Connection error: ${err.message}`);
      if (resolved) return;
      // Connection errors before connect are fatal
      if (!socket.connecting && !heartbeatTimer) {
        reject(err);
      } else {
        cleanup("daemon_dead");
      }
    });

    // If stdin closes (IDE disconnects), allow a grace period for pending
    // responses before tearing down. Without this, piped input like
    //   echo '{"jsonrpc":"2.0",...}' | unerr --mcp
    // closes stdin immediately, destroying the socket before the proxy
    // can write its response back.
    process.stdin.on("end", () => {
      const grace = setTimeout(() => cleanup("stdin_closed"), 3_000);
      socket.once("end", () => {
        clearTimeout(grace);
        cleanup("stdin_closed");
      });
    });

    // Keep the process alive while bridging
    process.stdin.resume();
  });
}
