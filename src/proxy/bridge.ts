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
 *
 * Safe to call multiple times (reconnect loop). Each call removes its
 * stdin listeners on cleanup so they don't accumulate across retries.
 *
 * `preBufferedChunks` carries any stdin data captured before the bridge
 * could connect (e.g. while mcpBoot was auto-spawning the supervisor).
 * The caller is expected to detach its capture handler and pass the
 * buffer in; we drain it into the socket immediately after connect so
 * the first MCP frame (`initialize`) isn't lost.
 */
export function startUdsBridge(
  sockPath: string,
  preBufferedChunks?: Buffer[]
): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const socket: Socket = connect(sockPath);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let missedHeartbeats = 0;
    let pendingPing = false;
    let resolved = false;

    // Track stdin listeners so we can remove them on cleanup
    let stdinDataHandler: ((chunk: Buffer) => void) | undefined;
    // biome-ignore lint/style/useConst: assigned after socket.on handlers below
    let stdinEndHandler: (() => void) | undefined;

    function cleanup(reason: BridgeResult["reason"]) {
      if (resolved) return;
      resolved = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
      if (!socket.destroyed) socket.destroy();
      if (stdinDataHandler)
        process.stdin.removeListener("data", stdinDataHandler);
      if (stdinEndHandler) process.stdin.removeListener("end", stdinEndHandler);
      resolve({ reason });
    }

    socket.on("connect", () => {
      log.info(`Connected to proxy at ${sockPath}`);

      // Drain frames the caller captured before we could connect (e.g. the
      // IDE's `initialize` arriving during auto-spawn). Order is preserved.
      if (preBufferedChunks && preBufferedChunks.length > 0) {
        log.info(`Draining ${preBufferedChunks.length} pre-buffered chunk(s)`);
        for (const chunk of preBufferedChunks) {
          if (!socket.destroyed) socket.write(chunk);
        }
        preBufferedChunks.length = 0;
      }

      // stdin → UDS: forward MCP requests from IDE to proxy
      stdinDataHandler = (chunk: Buffer) => {
        if (!socket.destroyed) {
          socket.write(chunk);
        }
      };
      process.stdin.on("data", stdinDataHandler);

      // UDS → stdout: forward MCP responses from proxy to IDE
      socket.on("data", (data: Buffer) => {
        const str = data.toString();
        if (str.includes('"unerr/pong"')) {
          missedHeartbeats = 0;
          pendingPing = false;
          if (heartbeatTimeoutTimer) {
            clearTimeout(heartbeatTimeoutTimer);
            heartbeatTimeoutTimer = undefined;
          }
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
          missedHeartbeats++;
          if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
            log.warn(
              `${MAX_MISSED_HEARTBEATS} heartbeats missed — daemon appears dead`
            );
            cleanup("daemon_dead");
            return;
          }
        }

        pendingPing = true;
        const ping = JSON.stringify({
          jsonrpc: "2.0",
          method: "unerr/ping",
          params: { ts: Date.now() },
        });
        try {
          socket.write(`${ping}\n`);
        } catch {
          cleanup("daemon_dead");
          return;
        }

        heartbeatTimeoutTimer = setTimeout(() => {
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
      if (!heartbeatTimer) {
        cleanup("connect_error");
      } else {
        cleanup("daemon_dead");
      }
    });

    stdinEndHandler = () => {
      const grace = setTimeout(() => cleanup("stdin_closed"), 3_000);
      socket.once("end", () => {
        clearTimeout(grace);
        cleanup("stdin_closed");
      });
    };
    process.stdin.on("end", stdinEndHandler);

    process.stdin.resume();
  });
}
