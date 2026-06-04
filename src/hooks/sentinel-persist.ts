/**
 * Sentinel persistence + transcript reader (Phase-2 Sprint 7, T7.9).
 *
 * The Stop hook scrapes `unerr-save:` sentinels from the agent's closing message
 * (which it reads from the transcript the IDE points it at) and persists each
 * over the per-repo proxy socket — a subprocess→daemon hop, invisible to the
 * model's token budget. Notes route to `unerr_remember({type:"note"})`; the four
 * markers route to the matching `mark_*` tool.
 *
 * Same hard contract as the other UDS clients: NEVER throws, NEVER stalls. Every
 * failure (no socket, proxy down, bad reply) drops that save silently — it is
 * surfaced on the next turn's recall, never re-prompted this turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { defaultProxySockPath } from "./blast-radius-client.js";
import type { SentinelSave } from "./sentinel-scrape.js";

/** Per-save UDS ceiling. Saves are warm in-proxy writes; this budget covers the
 *  round-trip with headroom while staying under any IDE hook timeout. */
export const DEFAULT_PERSIST_TIMEOUT_MS = 400;

/** Per-save ceiling for the detached `unerr hook stop-persist` worker. The
 *  worker runs outside any IDE hook deadline (spawned detached + unref'd by
 *  the Stop hook), so it can afford a relaxed budget that survives a cold
 *  proxy or momentary load instead of dropping the save. */
export const STOP_PERSIST_WORKER_TIMEOUT_MS = 2000;

export interface PersistOptions {
  sockPath?: string;
  timeoutMs?: number;
}

/** Map a parsed sentinel to its proxy `tools/call` (name + arguments). */
function toToolCall(save: SentinelSave): {
  name: string;
  arguments: Record<string, unknown>;
} {
  if (save.kind === "note") {
    return {
      name: "unerr_remember",
      arguments: { type: "note", note: save.wire },
    };
  }
  const toolByOp: Record<string, string> = {
    intent: "mark_intent",
    decision: "mark_decision",
    blocker: "mark_blocker",
    resolution: "mark_resolution",
  };
  return { name: toolByOp[save.op]!, arguments: { text: save.text } };
}

/**
 * Send one `tools/call` frame to the proxy and resolve when it acks (or times
 * out). Resolves `true` on a non-error reply, `false` otherwise. Never throws.
 */
function callProxyTool(
  name: string,
  args: Record<string, unknown>,
  sockPath: string,
  timeoutMs: number
): Promise<boolean> {
  if (!existsSync(sockPath)) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connect(sockPath);

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      const frame = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`;
      try {
        socket.write(frame);
      } catch {
        finish(false);
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, nl)) as { error?: unknown };
        finish(!reply.error);
      } catch {
        finish(false);
      }
    });

    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/**
 * Persist every scraped sentinel over UDS, sequentially (writes are cheap and
 * ordering keeps the ledger readable). Returns the count actually acked. Never
 * throws. With no proxy up, returns 0 — the saves are lost this turn, which is
 * the accepted §7.6 trade-off for the hook-less / proxy-down case.
 */
export async function persistSentinels(
  saves: SentinelSave[],
  options: PersistOptions = {}
): Promise<number> {
  const sockPath = options.sockPath ?? defaultProxySockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;
  if (saves.length === 0 || !existsSync(sockPath)) return 0;

  let persisted = 0;
  for (const save of saves) {
    const { name, arguments: args } = toToolCall(save);
    // eslint-disable-next-line no-await-in-loop — sequential by design (ordered ledger writes)
    const ok = await callProxyTool(name, args, sockPath, timeoutMs);
    if (ok) persisted += 1;
  }
  return persisted;
}

/**
 * Read the agent's closing (last assistant) message text from a Claude Code
 * transcript JSONL. Returns "" on any failure or when no assistant text is
 * present (other agents may not provide a transcript path). Never throws.
 *
 * Transcript format: one JSON object per line; assistant turns carry
 * `{type:"assistant", message:{role:"assistant", content:[{type:"text",text}]}}`.
 * We scan from the end for the last such turn and concatenate its text parts.
 */
export function readClosingMessageFromTranscript(
  transcriptPath: string | undefined
): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractAssistantText(entry);
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  }
}

/** Pull concatenated text parts from an assistant transcript entry, or "". */
function extractAssistantText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const e = entry as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  const msg = e.message;
  if (!msg || msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}
