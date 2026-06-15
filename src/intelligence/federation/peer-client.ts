/**
 * Drive a peer repo's proxy over its UDS socket via the `unerr/federated_call`
 * control method: connect, send one line-delimited JSON-RPC frame, resolve the
 * raw structured tool content. The home proxy uses this to fan a tool call out
 * to sibling repos. The federated method returns the raw `executeRaw` payload
 * (no prose/signal assembly) so results merge cleanly — mirrors the
 * `unerr/blast_radius` control-channel precedent, not the prose-wrapped
 * `tools/call` path.
 *
 * @sem domain=intelligence
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";

/** Default per-peer wait before a fan-out call is treated as a straggler. */
export const DEFAULT_PEER_CALL_TIMEOUT_MS = 4_000;

/** Control-channel method the home proxy calls on a peer for federation. */
export const FEDERATED_CALL_METHOD = "unerr/federated_call";

/**
 * Call one tool on a peer proxy over its UDS socket and resolve the raw
 * structured content, or `null` on any failure — unreachable socket, timeout,
 * error reply, or malformed frame. Never throws, so a bad peer degrades to a
 * partial fan-out instead of failing the whole query.
 *
 * @sem domain=intelligence role=transport
 */
export function callPeerTool(
  sockPath: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_PEER_CALL_TIMEOUT_MS
): Promise<unknown | null> {
  // Fast path: no socket file means no live peer proxy — don't attempt connect.
  if (!sockPath || !existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connect(sockPath);

    const finish = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      const frame = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: FEDERATED_CALL_METHOD,
        params: { name, arguments: args },
      })}\n`;
      try {
        socket.write(frame);
      } catch {
        finish(null);
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return; // wait for a complete line
      try {
        const reply = JSON.parse(buffer.slice(0, nl)) as {
          result?: { content?: unknown };
          error?: unknown;
        };
        // The federated method wraps the payload as `{content}` so an empty-but-
        // valid result (e.g. no search hits) is distinguishable from an error.
        if (reply.error || reply.result === undefined) {
          finish(null);
          return;
        }
        finish(reply.result.content ?? null);
      } catch {
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
