/**
 * Recall-notes UDS client (Phase-2 Sprint 7).
 *
 * The UserPromptSubmit hook is a short-lived `unerr hook prompt-submit`
 * subprocess. Today it only NUDGES the agent to call `unerr_recall_notes` —
 * one model round-trip every coding turn. This client lets the hook fetch the
 * recalled notes ITSELF over the existing per-repo proxy socket (a
 * subprocess→daemon hop, invisible to the model's token budget) and inject them
 * straight into the prompt via additionalContext. Zero model round-trip.
 *
 * It reuses the proxy's already-tested MCP `tools/call` path (proxy.ts) — no
 * new server-side handler — by sending a single `tools/call` frame for
 * `unerr_recall_notes` and parsing the reply.
 *
 * Same hard contract as blast-radius-client: NEVER throws, NEVER stalls. Every
 * failure mode (no socket, proxy down, slow/malformed reply, empty recall)
 * resolves to `null`, and `null` means "fall back to the static nudge".
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { orderNotes } from "../proxy/prefix-order.js";
import { defaultProxySockPath } from "./blast-radius-client.js";

/** Round-trip ceiling. Recall is a warm in-proxy query (<5ms); this budget
 *  covers UDS connect + reply with headroom while staying well under any IDE
 *  hook timeout, so a busy proxy degrades fast rather than freezing the turn. */
export const DEFAULT_RECALL_TIMEOUT_MS = 400;

/** One recalled note, as `unerr_recall_notes` returns it. */
export interface RecalledNote {
  kind: string;
  anchor: string;
  polarity: string;
  content: string;
}

export interface RecallClientOptions {
  sockPath?: string;
  timeoutMs?: number;
}

/**
 * Query the proxy for anchored notes matching a verbatim prompt. Resolves to
 * the notes array (possibly empty) when the proxy answers, or `null` when the
 * proxy is unreachable / slow / malformed.
 */
export function queryRecallNotes(
  prompt: string,
  options: RecallClientOptions = {}
): Promise<RecalledNote[] | null> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;

  if (!prompt || !existsSync(sockPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";

    const socket = connect(sockPath);

    const finish = (value: RecalledNote[] | null): void => {
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
        method: "tools/call",
        params: {
          name: "unerr_recall_notes",
          arguments: { prompt },
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
      if (nl === -1) return; // wait for a complete line
      finish(parseRecallReply(buffer.slice(0, nl)));
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/**
 * Parse one JSON-RPC reply line into the notes array. Returns `null` on any
 * shape mismatch so the caller falls back to the nudge. Exported for tests.
 */
export function parseRecallReply(line: string): RecalledNote[] | null {
  try {
    const response = JSON.parse(line) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (response.error || !response.result?.content?.[0]?.text) return null;

    // The MCP tool text is itself JSON: {ok, data:{notes:[…]}, hint}.
    const inner = JSON.parse(response.result.content[0].text!) as {
      data?: { notes?: unknown };
      notes?: unknown;
    };
    const notes = (inner.data?.notes ?? inner.notes) as unknown;
    if (!Array.isArray(notes)) return null;

    return notes
      .filter(
        (n): n is RecalledNote =>
          !!n &&
          typeof (n as RecalledNote).content === "string" &&
          typeof (n as RecalledNote).anchor === "string"
      )
      .map((n) => ({
        kind: String(n.kind ?? "note"),
        anchor: String(n.anchor),
        polarity: String(n.polarity ?? "~"),
        content: String(n.content),
      }));
  } catch {
    return null;
  }
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

/**
 * Render recalled notes into a compact additionalContext block, or `null` when
 * there are none (caller then keeps the static nudge so the four-moment
 * contract still shows on note-less turns). Plain-language header leads with
 * "unerr" per the de-jargon convention; each note keeps its DSL anchor so the
 * agent can cite it (Moment 3).
 */
export function renderRecallBlock(notes: RecalledNote[]): string | null {
  if (notes.length === 0) return null;
  // T2.3 — the SET of notes is per-prompt (legitimately dynamic), but for a
  // given set the byte order must be stable so the injected block doesn't bust
  // the provider prompt cache turn to turn. The proxy/UDS reply order has no
  // stability guarantee; orderNotes imposes a total order (anchor → kind →
  // content) so identical recalled sets serialize identically.
  const ordered = orderNotes(notes);
  const header =
    ordered.length === 1
      ? "unerr recalled 1 note anchored to what you're about to touch — apply it before editing:"
      : `unerr recalled ${ordered.length} notes anchored to what you're about to touch — apply them before editing:`;
  const lines = ordered.map(
    (n) => `  • [${n.kind} ${n.anchor} ${n.polarity}] ${n.content}`
  );
  return `${header}\n${lines.join("\n")}`;
}
