/**
 * Review UDS client (P1 — Surface A, in-flight).
 *
 * The post-edit hook is a short-lived `unerr hook post-edit` subprocess. It asks
 * the long-lived per-repo proxy "for the file I just edited, what does the review
 * engine find?" over the UDS control channel (`unerr/review_edit`), then stays
 * silent if the proxy isn't reachable.
 *
 * Same hard guarantees as `blast-radius-client.ts`:
 *   - NEVER throws — every failure mode resolves to `null`.
 *   - NEVER stalls — a hard timeout caps the round-trip; the socket is always
 *     torn down. Claude Code blocks on the hook process, so a hung query would
 *     freeze the user; `null` on timeout means "skip the review nudge".
 *
 * `null` = "no answer, emit nothing extra"; a non-null result (possibly empty
 * `findings`) = "the proxy answered authoritatively".
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import type {
  ReviewEditRequestParams,
  ReviewEditResult,
} from "../proxy/review-protocol.js";
import { REVIEW_EDIT_METHOD } from "../proxy/review-protocol.js";
import { defaultProxySockPath } from "./blast-radius-client.js";

/** Round-trip ceiling. The engine runs ~10 depth-1 checks concurrently against
 *  the warm graph (<5ms each); this budget covers UDS connect + reply with
 *  headroom while staying well under any IDE hook timeout. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 500;

export interface ReviewClientOptions {
  /** Override the socket path (tests / non-cwd repos). */
  sockPath?: string;
  /** Hard round-trip ceiling in ms. */
  timeoutMs?: number;
}

/**
 * Query the proxy to review an in-flight edit. Resolves to the proxy's result,
 * or `null` if the proxy is unreachable / slow / malformed.
 */
export function queryReviewEdit(
  params: ReviewEditRequestParams,
  options: ReviewClientOptions = {}
): Promise<ReviewEditResult | null> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

  // Fast path: no socket file means no proxy — don't even attempt to connect.
  if (!existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: ReviewEditResult | null): void => {
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
        method: REVIEW_EDIT_METHOD,
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
          result?: ReviewEditResult;
          error?: unknown;
        };
        if (response.error || !response.result) {
          finish(null);
          return;
        }
        finish({
          findings: response.result.findings ?? [],
          suppressed: response.result.suppressed ?? 0,
          evidenceBlock: response.result.evidenceBlock ?? null,
          clean: response.result.clean ?? true,
        });
      } catch {
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
