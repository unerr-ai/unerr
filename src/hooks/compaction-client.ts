/**
 * Compaction UDS client (cost lever 3).
 *
 * The compaction hooks (`unerr hook post-compact`, and the `session-start` hook
 * when the session started from a compact/clear) are short-lived subprocesses.
 * Each tells the long-lived per-repo proxy "the agent's context was compacted —
 * drop what you think it still has" over the existing UDS control channel
 * (`unerr/compaction`, compaction-protocol.ts).
 *
 * Contract this module guarantees to its caller:
 *   - NEVER throws. Every failure mode (no socket file, proxy down, connection
 *     refused, malformed reply, slow reply) resolves to `null`.
 *   - NEVER stalls. A hard timeout caps the whole round-trip; the socket is
 *     torn down on every exit path. Claude Code blocks on the hook process, so
 *     a hung call would freeze the session — `null` on timeout instead.
 *
 * `null` means "the proxy never confirmed the flush"; dedup then behaves exactly
 * as it does today (the 5-turn guess window stays in force until some flush does
 * land). A non-null result is the proxy's ack with the entry count it dropped.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  COMPACTION_METHOD,
  type CompactionRequestParams,
  type CompactionResult,
  isCompactionResult,
} from "../proxy/compaction-protocol.js";

/** Default round-trip ceiling. The server-side work is an in-memory Map sweep
 *  (<1ms); this budget covers UDS connect + reply with wide headroom while
 *  staying far below any IDE hook timeout, so a busy proxy degrades fast rather
 *  than stalling the session. */
export const DEFAULT_COMPACTION_TIMEOUT_MS = 300;

/** Resolve the per-repo proxy socket path (mirrors proxy.ts `stateDir`). */
function proxySockPath(cwd: string): string {
  return join(cwd, ".unerr", "state", "proxy.sock");
}

export interface CompactionClientOptions {
  /** Override the repo root used to locate the socket (tests / non-cwd repos). */
  cwd?: string;
  /** Override the socket path outright (tests). */
  sockPath?: string;
  /** Hard round-trip ceiling in ms. */
  timeoutMs?: number;
}

/**
 * Tell the proxy a compaction happened. Resolves to the proxy's ack, or `null`
 * if the proxy is unreachable / slow / malformed.
 */
export function notifyCompaction(
  params: CompactionRequestParams,
  options: CompactionClientOptions = {}
): Promise<CompactionResult | null> {
  const sockPath =
    options.sockPath ?? proxySockPath(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS;

  // Fast path: no socket file means no proxy — nothing holds stale dedup state,
  // so there is nothing to flush.
  if (!existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: CompactionResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    // Don't let the timer keep the (already short-lived) process alive.
    timer.unref?.();

    socket.on("connect", () => {
      const frame = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: COMPACTION_METHOD,
        params,
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
      const line = buffer.slice(0, nl);
      try {
        const response = JSON.parse(line) as {
          result?: unknown;
          error?: unknown;
        };
        if (response.error || !isCompactionResult(response.result)) {
          finish(null);
          return;
        }
        finish({ dropped: response.result.dropped });
      } catch {
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
