/**
 * Fix J — read-side projection for `user_prompt_received` rows.
 *
 * The capture-side writer lives at `src/hooks/prompt-capture.ts`; this
 * module is the read counterpart that every server route uses to attach
 * a verbatim prompt to a `{session_id, turn}` pair. Three trace pages
 * (Token Flow / Reasoning Quality / Logbook) join on this same shape.
 *
 * READ-time redaction policy:
 *   - If `capture_prompts: true` was set at write time, the verbatim
 *     prompt was stored. The reader still runs it through `redactPrompt`
 *     before returning — so a user who flipped the flag mid-session can
 *     stop persisting NEW prompts immediately while still seeing safer
 *     versions of older trace rows.
 *   - If `capture_prompts: false` at write time, `prompt` is `null` and
 *     only operational metadata (`length`, `classified_as`) is returned.
 */

import {
  type BehaviorEventType,
  readBehaviorEvents,
} from "./behavior-events.js";
import { redactPrompt } from "../hooks/prompt-capture.js";

/** Per-turn prompt payload joined into Token Flow / Reasoning Quality /
 *  Logbook responses. Null `prompt` means content capture was opted out;
 *  callers should render the "(prompt not captured — enable in config)"
 *  hint row in that case. */
export interface PromptForTurn {
  session_id: string;
  turn: number;
  /** Verbatim prompt (redacted at READ time) or null when opted out. */
  prompt: string | null;
  /** Character length of the original message — always populated, even
   *  when content capture is off. */
  length: number;
  /** Verb-cluster classification (bug | build | refactor | fix | …) — null
   *  when the message didn't match any cluster. */
  classified_as: string | null;
  /** ISO timestamp the hook fired. */
  ts: string;
}

const EVENT_TYPE: BehaviorEventType = "user_prompt_received";

/** Read the captured prompt for one `{session_id, turn}` pair.
 *  Returns null when no row exists (e.g. agent does not emit
 *  UserPromptSubmit hook payloads, or capture happened before the hook
 *  landed). */
export function getPromptForTurn(
  unerrDir: string,
  sessionId: string,
  turn: number
): PromptForTurn | null {
  try {
    const rows = readBehaviorEvents(unerrDir, {
      session_id: sessionId,
      type: EVENT_TYPE,
    });
    // Find the most-recent row matching this turn. The hook writes
    // `turn: 0` because it fires BEFORE the proxy opens a turn; the join
    // happens by session_id + temporal proximity. Production: the
    // turn-resolver in named-events.ts re-anchors rows to the next
    // tool-call turn. For the trace projection we just take the latest
    // captured row when the requested turn is 0.
    let best: (typeof rows)[number] | null = null;
    for (const r of rows) {
      if (r.turn === turn) {
        best = r;
      }
    }
    if (!best && turn > 0) {
      // Fallback: most-recent capture in this session, used by Token
      // Flow and Reasoning Quality when their per-turn aggregation key
      // (the agent's tool-call turn counter) doesn't match the hook
      // capture turn (0).
      best = rows[rows.length - 1] ?? null;
    }
    if (!best) return null;
    const detail = (best.detail ?? {}) as {
      prompt?: string | null;
      length?: number;
      classified_as?: string | null;
    };
    const verbatim = typeof detail.prompt === "string" ? detail.prompt : null;
    return {
      session_id: best.session_id,
      turn: best.turn,
      prompt: verbatim ? redactPrompt(verbatim) : null,
      length: typeof detail.length === "number" ? detail.length : 0,
      classified_as:
        typeof detail.classified_as === "string" ? detail.classified_as : null,
      ts: best.ts,
    };
  } catch {
    return null;
  }
}

/** Bulk lookup for a session — returns every captured prompt as an array
 *  ordered by `ts ascending`. Used by Token Flow / Reasoning Quality
 *  pages to populate the per-turn header in their existing timelines. */
export function getPromptsForSession(
  unerrDir: string,
  sessionId: string
): PromptForTurn[] {
  try {
    const rows = readBehaviorEvents(unerrDir, {
      session_id: sessionId,
      type: EVENT_TYPE,
    });
    return rows.map((r) => {
      const detail = (r.detail ?? {}) as {
        prompt?: string | null;
        length?: number;
        classified_as?: string | null;
      };
      const verbatim = typeof detail.prompt === "string" ? detail.prompt : null;
      return {
        session_id: r.session_id,
        turn: r.turn,
        prompt: verbatim ? redactPrompt(verbatim) : null,
        length: typeof detail.length === "number" ? detail.length : 0,
        classified_as:
          typeof detail.classified_as === "string"
            ? detail.classified_as
            : null,
        ts: r.ts,
      };
    });
  } catch {
    return [];
  }
}
