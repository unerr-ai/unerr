/**
 * Blast-radius UDS client (P0.5).
 *
 * The pre-edit hook is a short-lived `unerr hook pre-edit` subprocess. It asks
 * the long-lived per-repo proxy "for this file + edit, which callers are at
 * risk?" over the existing UDS control channel (`unerr/blast_radius`, P0.4),
 * then degrades to a static nudge if the proxy isn't reachable.
 *
 * Contract this module guarantees to its caller:
 *   - NEVER throws. Every failure mode (no socket file, proxy down, connection
 *     refused, malformed reply, slow reply) resolves to `null`.
 *   - NEVER stalls. A hard timeout caps the whole round-trip; the socket is
 *     torn down on every exit path. Claude Code blocks on the hook process, so
 *     a hung query would freeze the user's edit — `null` on timeout instead.
 *
 * `null` means "no answer — fall back to the static nudge"; a non-null result
 * (possibly with empty `warnings`) means "the proxy answered authoritatively".
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type {
  BlastRadiusRequestParams,
  BlastRadiusResult,
} from "../proxy/blast-radius-protocol.js";
import { BLAST_RADIUS_METHOD } from "../proxy/blast-radius-protocol.js";

/** Default round-trip ceiling. The server-side compute is depth-1 (<5ms);
 *  this budget covers UDS connect + reply with wide headroom while staying far
 *  below any IDE hook timeout, so a busy proxy degrades fast rather than stalls. */
export const DEFAULT_BLAST_RADIUS_TIMEOUT_MS = 300;

/** Resolve the per-repo proxy socket path (mirrors proxy.ts `stateDir`). */
export function defaultProxySockPath(cwd: string = process.cwd()): string {
  return join(cwd, ".unerr", "state", "proxy.sock");
}

export interface BlastRadiusClientOptions {
  /** Override the socket path (tests / non-cwd repos). */
  sockPath?: string;
  /** Hard round-trip ceiling in ms. */
  timeoutMs?: number;
}

/**
 * Query the proxy for the blast radius of an in-flight edit. Resolves to the
 * proxy's result, or `null` if the proxy is unreachable / slow / malformed.
 */
export function queryBlastRadius(
  params: BlastRadiusRequestParams,
  options: BlastRadiusClientOptions = {}
): Promise<BlastRadiusResult | null> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLAST_RADIUS_TIMEOUT_MS;

  // Fast path: no socket file means no proxy — don't even attempt to connect.
  if (!existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: BlastRadiusResult | null): void => {
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
        method: BLAST_RADIUS_METHOD,
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
          result?: BlastRadiusResult;
          error?: unknown;
        };
        if (response.error || !response.result) {
          finish(null);
          return;
        }
        finish({
          warnings: response.result.warnings ?? [],
          boundary_violations: response.result.boundary_violations ?? [],
        });
      } catch {
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
