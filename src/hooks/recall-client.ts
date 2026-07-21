/**
 * Trace-recall UDS client (Phase-2 Sprint 7; Phase 3 active-memory strip).
 *
 * The anchored-note half of this client (queryRecallNotes / parseRecallReply /
 * RecalledNote / renderRecallBlock) is removed — anchored-note recall is being
 * retired (NotesStore deletion lands in a later phase). Trace recall (past
 * incident journal entries keyed on symptom similarity) is unaffected: the
 * UserPromptSubmit hook fetches matching traces from the warm proxy over UDS
 * and injects them as `ur|fct` lines (prompt-hooks.ts formatTraceLine).
 *
 * Same hard contract as blast-radius-client: NEVER throws, NEVER stalls. Every
 * failure mode (no socket, proxy down, slow/malformed reply, empty recall)
 * resolves to `null`.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { defaultProxySockPath } from "./blast-radius-client.js";

/** Round-trip ceiling. Recall is a warm in-proxy query (<5ms); this budget
 *  covers UDS connect + reply with headroom while staying well under any IDE
 *  hook timeout, so a busy proxy degrades fast rather than freezing the turn. */
export const DEFAULT_RECALL_TIMEOUT_MS = 400;

export interface RecallClientOptions {
  sockPath?: string;
  timeoutMs?: number;
}

/** One recalled trace row, as `unerr_recall_traces` returns it. */
export interface RecalledTrace {
  situation: string;
  dead_ends: string;
  unlock: string;
  anchor: string;
  /** ms epoch when the resolution was recorded; 0 when the row predates it.
   *  Drives the journal date-stamp on the injected line. */
  resolved_at: number;
}

/**
 * Query the proxy for trajectory traces matching a verbatim prompt (Cap A-2).
 * Resolves to the trace array (possibly empty) or `null` when the proxy is
 * unreachable / slow / malformed. Never throws; always time-boxed.
 */
export function queryRecallTraces(
  prompt: string,
  limit: number,
  options: RecallClientOptions = {}
): Promise<RecalledTrace[] | null> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;

  if (!prompt || !existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: RecalledTrace[] | null): void => {
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
        id: 2,
        method: "tools/call",
        params: {
          name: "unerr_recall_traces",
          arguments: { prompt, limit },
        },
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
      if (nl === -1) return;
      finish(parseRecallTracesReply(buffer.slice(0, nl)));
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/**
 * Parse one JSON-RPC reply line for `unerr_recall_traces`. Returns `null` on
 * any shape mismatch. Exported for tests.
 */
export function parseRecallTracesReply(line: string): RecalledTrace[] | null {
  try {
    const response = JSON.parse(line) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (response.error || !response.result?.content?.[0]?.text) return null;
    const inner = JSON.parse(response.result.content[0].text!) as {
      ok?: boolean;
      data?: { traces?: unknown };
    };
    if (!inner.ok || !Array.isArray(inner.data?.traces)) return null;
    return (inner.data.traces as unknown[])
      .filter(
        (t): t is RecalledTrace =>
          !!t &&
          typeof (t as RecalledTrace).situation === "string" &&
          typeof (t as RecalledTrace).unlock === "string"
      )
      .map((t) => ({
        situation: String(t.situation ?? ""),
        dead_ends: String(t.dead_ends ?? ""),
        unlock: String(t.unlock ?? ""),
        anchor: String(t.anchor ?? ""),
        resolved_at:
          typeof t.resolved_at === "number" && Number.isFinite(t.resolved_at)
            ? t.resolved_at
            : 0,
      }));
  } catch {
    return null;
  }
}
