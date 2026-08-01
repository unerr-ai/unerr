/**
 * Compaction hooks (cost lever 3) — tell the proxy when the agent's context was
 * compacted or cleared, so file-body dedup stops claiming the agent still holds
 * a body the harness evicted.
 *
 * Two entry points, deliberately both:
 *   - `PostCompact` (`unerr hook post-compact`) — the precise signal. Fires
 *     right after Claude Code finishes compacting, with matcher `manual|auto`.
 *     This alone is SUFFICIENT on a current Claude Code.
 *   - `SessionStart` with source `compact` / `clear` (`unerr hook session-start`,
 *     already registered with matcher `startup|resume|clear|compact`) — the
 *     FALLBACK for Claude Code builds that predate `PostCompact`, and the only
 *     path that reports a `/clear`. Kept even though PostCompact suffices,
 *     because a missed flush is the one failure that can hand the agent a
 *     pointer to content it no longer has.
 *
 * Both paths hit the same UDS method and the flush is idempotent: whichever
 * fires first drops the entries, the other acks `dropped: 0`.
 *
 * Fail-open everywhere: no proxy, no socket, slow or malformed reply ⇒ the hook
 * still prints valid JSON and the session proceeds. Dedup then keeps its
 * unsignalled 5-turn window, i.e. today's behaviour.
 */

import type { CompactionTrigger } from "../proxy/compaction-protocol.js";
import { notifyCompaction } from "./compaction-client.js";

/** What the hook payload said happened to the context. */
export interface CompactionSignal {
  trigger: CompactionTrigger;
  /** The agent's own conversation id (`session_id`), or null when absent. */
  sessionId: string | null;
}

function readSessionId(payload: Record<string, unknown>): string | null {
  const raw = payload.session_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Read a compaction signal out of a `SessionStart` payload. Returns null for the
 * start modes that do NOT invalidate delivered bodies (`startup`, `resume`,
 * `fork`) — a resume replays the transcript, so what the agent held it still
 * holds.
 */
export function readSessionStartSignal(
  stdinJson: string
): CompactionSignal | null {
  try {
    const payload = JSON.parse(stdinJson) as Record<string, unknown>;
    const source = payload.source;
    if (source !== "compact" && source !== "clear") return null;
    return { trigger: source, sessionId: readSessionId(payload) };
  } catch {
    return null;
  }
}

/**
 * Read a compaction signal out of a `PostCompact` payload. Claude Code's
 * `trigger` there is `manual` | `auto` (WHO started the compaction); both mean
 * the same thing to dedup, so both normalize to `compact`.
 */
export function readPostCompactSignal(
  stdinJson: string
): CompactionSignal | null {
  try {
    const payload = JSON.parse(stdinJson) as Record<string, unknown>;
    return { trigger: "compact", sessionId: readSessionId(payload) };
  } catch {
    return null;
  }
}

/**
 * Send the flush and wait for the ack. Awaited by the caller BEFORE it returns
 * its hook output, which is what orders the flush ahead of the next tool call:
 * Claude Code blocks on the hook process, so by the time the agent can call a
 * tool the proxy has already dropped the invalidated entries.
 *
 * Returns the number of entries dropped, or null when the proxy never answered.
 */
export async function signalCompaction(
  signal: CompactionSignal
): Promise<number | null> {
  try {
    const ack = await notifyCompaction({
      session_id: signal.sessionId,
      trigger: signal.trigger,
    });
    return ack ? ack.dropped : null;
  } catch {
    // notifyCompaction never throws by contract; belt-and-braces so a hook can
    // never fail because of the flush.
    return null;
  }
}

/**
 * `unerr hook post-compact` — Claude Code `PostCompact`. Flushes body dedup and
 * prints `{}`: PostCompact has no decision control and its stderr is shown to
 * the user, so this hook stays silent on success.
 */
export async function runPostCompactHookAsync(
  stdinJson: string
): Promise<string> {
  const signal = readPostCompactSignal(stdinJson);
  if (signal) await signalCompaction(signal);
  return "{}";
}
