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

import { randomUUID } from "node:crypto";
import { type Socket, connect } from "node:net";
import {
  type EmitContext,
  type EmitInput,
  enqueue,
} from "../events/enqueue.js";
import { bridgeSegment } from "../events/event-store.js";
import { UNERR_VERSION } from "../version.js";
import {
  BridgeCatalog,
  LOCAL_CATALOG_FALLBACK_MS,
  type PendingLocalRequest,
} from "./bridge-catalog.js";

/** stderr-only logger. stdout is MCP territory. */
const log = {
  info: (msg: string) => process.stderr.write(`[unerr:bridge] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerr:bridge] WARN: ${msg}\n`),
};

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 2_000;
const MAX_MISSED_HEARTBEATS = 3;

/**
 * unerr's per-bridge session id — a UUID minted once when this `unerr --mcp`
 * process loads (one bridge process == one coding-agent conversation). Stable
 * across UDS reconnects (proxy restart / daemon respawn) because it is module-
 * scoped, so the proxy keeps grouping a conversation's events under one id even
 * when the socket drops. Announced to the proxy in the `unerr/hello` frame.
 * This is the `session_id` that lands on every event row (distinct from the
 * agent's own `native_session_id`); group a conversation by
 * coalesce(native_session_id, session_id).
 */
const BRIDGE_SESSION_ID = randomUUID();

export interface BridgeResult {
  /** Why the bridge closed. */
  reason: "socket_closed" | "daemon_dead" | "stdin_closed" | "connect_error";
}

export interface BridgeOptions {
  /** Coding-agent id baked into the MCP config (`claude-code`, `cursor`, …).
   *  When set, the bridge rewrites the `initialize` frame's
   *  `params.clientInfo.name` so the per-repo proxy attributes every
   *  tool call from this bridge to the named agent — works even when
   *  two IDEs share one daemon. */
  codingAgent?: string;
  /** Repo root whose `.unerr/events/mcp-<pid>.jsonl` segment receives this
   *  bridge's session-lifecycle events (L6). The same `cwd` the bridge hands
   *  the daemon as the repo identity, so the bridge's segment lands beside the
   *  proxy's `proxy.jsonl` in one store. Omitted → the bridge writes no events
   *  (standalone / pre-repo contexts stay silent). */
  repoRoot?: string;
}

/**
 * The bridge's session-lifecycle event. One bridge process spans one whole
 * coding-agent conversation, so it owns the session's wall-clock window: open
 * (no `ended_at`) on first connect, close (with `ended_at`) when the IDE
 * detaches. The proxy adds token/turn counts under the same `session_id`.
 */
export function bridgeSessionEvent(
  startedAt: string,
  endedAt?: string
): EmitInput {
  return {
    type: "session",
    detail: {
      started_at: startedAt,
      ...(endedAt ? { ended_at: endedAt } : {}),
    },
  };
}

/** First-connect timestamp, set once so a UDS reconnect keeps the original
 *  start rather than re-opening the session. Module-scoped to match
 *  {@link BRIDGE_SESSION_ID}'s process lifetime. */
let bridgeSessionStartedAt: string | null = null;

/** Reset the once-per-process session-open guard. Test-only. */
export function _resetBridgeSessionForTest(): void {
  bridgeSessionStartedAt = null;
}

/**
 * Rewrite outgoing JSON-RPC frames so `initialize.params.clientInfo.name`
 * is the install-time-known coding-agent id. Newline-delimited frames are
 * parsed lazily; non-`initialize` frames pass through unchanged. Returns
 * the rewritten Buffer (same length when nothing matched, so the caller
 * can write it as-is). A malformed line falls back to the original chunk
 * — we never block forwarding on a parse failure.
 */
function rewriteInitializeFrame(chunk: Buffer, codingAgent: string): Buffer {
  const str = chunk.toString();
  // Fast bail: most chunks aren't `initialize`. Avoid JSON.parse() entirely.
  if (!str.includes('"initialize"')) return chunk;
  const lines = str.split("\n");
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('"initialize"')) continue;
    try {
      const frame = JSON.parse(line) as {
        method?: string;
        params?: { clientInfo?: { name?: string; version?: string } };
      };
      if (frame.method !== "initialize") continue;
      frame.params = frame.params ?? {};
      frame.params.clientInfo = frame.params.clientInfo ?? {};
      frame.params.clientInfo.name = codingAgent;
      lines[i] = JSON.stringify(frame);
      mutated = true;
    } catch {
      // Partial line or malformed JSON — leave it alone.
    }
  }
  return mutated ? Buffer.from(lines.join("\n")) : chunk;
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
  preBufferedChunks?: Buffer[],
  options?: BridgeOptions
): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const socket: Socket = connect(sockPath);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let missedHeartbeats = 0;
    let pendingPing = false;
    let resolved = false;

    // Frame-aware relay state for this connection: answers initialize /
    // tools/list locally if the proxy is too slow (FIX A). Timer-free; the
    // bridge owns the fallback timers (keyed by request id).
    const catalog = new BridgeCatalog();
    const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Track stdin listeners so we can remove them on cleanup. Declared at their
    // assignment sites below (`const`); `cleanup()` reads them but only runs on
    // later async events, long after both are attached.

    // Gapless stdin relay (warm-reconnect `tools/list` drop fix). mcpBoot
    // detaches its static-catalog interceptor synchronously right before
    // invoking us, but `connect` fires on a later tick. Attach the relay
    // handler NOW so a `tools/list` the IDE fires the instant `initialize` is
    // answered locally (warm daemon+proxy) is captured, not dropped — the drop
    // surfaced as "-32001". Frames queue until `connect` drains and opens them.
    let connected = false;
    const preConnectQueue: Buffer[] = [];
    const codingAgent = options?.codingAgent;
    // Identity for this bridge's own lifecycle events (L6). Its segment is
    // `mcp-<pid>.jsonl`, keyed by the process pid; null when no repo root was
    // passed, so the emit calls below no-op in standalone contexts.
    const bridgeCtx: EmitContext | null = options?.repoRoot
      ? {
          repoRoot: options.repoRoot,
          segment: bridgeSegment(process.pid),
          source: `unerr-cli@${UNERR_VERSION}`,
          session_id: BRIDGE_SESSION_ID,
          ...(codingAgent ? { agent: codingAgent } : {}),
        }
      : null;
    const maybeRewrite = (chunk: Buffer): Buffer =>
      codingAgent ? rewriteInitializeFrame(chunk, codingAgent) : chunk;
    const stdinDataHandler = (chunk: Buffer) => {
      if (!connected) {
        preConnectQueue.push(chunk);
        return;
      }
      if (socket.destroyed) return;
      const { forward, arm } = catalog.ingestFromIde(chunk);
      for (const buf of forward) socket.write(maybeRewrite(buf));
      for (const req of arm) armFallback(req);
    };
    process.stdin.on("data", stdinDataHandler);

    /** Arm a single fallback timer per request id (idempotent). */
    function armFallback(req: PendingLocalRequest) {
      const key = String(req.id);
      if (fallbackTimers.has(key)) return;
      const timer = setTimeout(() => {
        fallbackTimers.delete(key);
        const reply = catalog.fireFallback(req);
        if (reply) process.stdout.write(reply);
      }, LOCAL_CATALOG_FALLBACK_MS);
      timer.unref();
      fallbackTimers.set(key, timer);
    }

    function cleanup(reason: BridgeResult["reason"]) {
      if (resolved) return;
      resolved = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
      for (const timer of fallbackTimers.values()) clearTimeout(timer);
      fallbackTimers.clear();
      if (!socket.destroyed) socket.destroy();
      if (stdinDataHandler)
        process.stdin.removeListener("data", stdinDataHandler);
      if (stdinEndHandler) process.stdin.removeListener("end", stdinEndHandler);
      // L6: close the session window only on a terminal stdin EOF (the IDE
      // detached). socket_closed / daemon_dead are reconnect triggers, not the
      // end of the conversation, so they leave the session open.
      if (bridgeCtx && bridgeSessionStartedAt && reason === "stdin_closed") {
        enqueue(
          bridgeCtx,
          bridgeSessionEvent(bridgeSessionStartedAt, new Date().toISOString())
        );
      }
      resolve({ reason });
    }

    socket.on("connect", () => {
      log.info(`Connected to proxy at ${sockPath}`);

      // L6: record the conversation's start once (a reconnect keeps the
      // original started_at). The proxy adds token/turn counts under the same
      // session_id; the server merges the two rows.
      if (bridgeCtx && !bridgeSessionStartedAt) {
        bridgeSessionStartedAt = new Date().toISOString();
        enqueue(bridgeCtx, bridgeSessionEvent(bridgeSessionStartedAt));
      }

      // Announce the coding-agent id to the proxy independently of the IDE's
      // MCP `initialize` handshake. IDEs only send `initialize` once per MCP
      // transport; on bridge reconnects (proxy restart, daemon respawn) the
      // IDE-side client treats the MCP session as already initialized and
      // never re-sends the frame, so the proxy would otherwise have no way to
      // attribute events from this bridge. The `unerr/hello` notification is
      // a notification (no `id`) — proxy dispatches setAgent and never
      // replies. Safe to send before draining the pre-buffer.
      // Always send hello (even without a coding-agent flag) so the proxy
      // registers this bridge's per-conversation `session_id`. The agent is
      // included when known; the proxy stamps both onto every event from this
      // clientId.
      if (!socket.destroyed) {
        const hello = `${JSON.stringify({
          jsonrpc: "2.0",
          method: "unerr/hello",
          params: {
            ...(codingAgent ? { agent: codingAgent } : {}),
            session_id: BRIDGE_SESSION_ID,
          },
        })}\n`;
        socket.write(hello);
      }

      // Drain frames captured before connect (caller's pre-buffer first, then
      // frames that arrived while connecting) THROUGH the catalog so a split
      // frame is reassembled and answerable requests still arm a fallback. Then
      // open the gate so live frames relay directly (FIX A + warm-reconnect).
      const pending = [...(preBufferedChunks ?? []), ...preConnectQueue];
      preConnectQueue.length = 0;
      if (pending.length > 0) {
        log.info(`Draining ${pending.length} pre-buffered chunk(s)`);
        for (const chunk of pending) {
          const { forward, arm } = catalog.ingestFromIde(chunk);
          for (const buf of forward) {
            if (!socket.destroyed) socket.write(maybeRewrite(buf));
          }
          for (const req of arm) armFallback(req);
        }
      }
      connected = true;

      // UDS → stdout: forward MCP responses from proxy to IDE. The catalog
      // strips heartbeat pongs, cancels the fallback for any request the proxy
      // answered in time, and suppresses the proxy's late duplicate of a
      // request we already answered locally.
      socket.on("data", (data: Buffer) => {
        const { toIde, sawPong, settledByProxy } =
          catalog.ingestFromProxy(data);
        if (sawPong) {
          missedHeartbeats = 0;
          pendingPing = false;
          if (heartbeatTimeoutTimer) {
            clearTimeout(heartbeatTimeoutTimer);
            heartbeatTimeoutTimer = undefined;
          }
        }
        for (const key of settledByProxy) {
          const timer = fallbackTimers.get(key);
          if (timer) {
            clearTimeout(timer);
            fallbackTimers.delete(key);
          }
        }
        for (const buf of toIde) {
          process.stdout.write(buf);
        }
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

    const stdinEndHandler = () => {
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
