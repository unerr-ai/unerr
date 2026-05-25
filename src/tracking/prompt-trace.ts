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

import { redactPrompt } from "../hooks/prompt-capture.js";
import {
  type BehaviorEventType,
  readBehaviorEvents,
} from "./behavior-events.js";

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

/**
 * Best-effort assignment of captured prompts to timeline turns by timestamp,
 * for the Activity landing view (logbook-page-redesign §5). The captured
 * `user_prompt_received` row is keyed by an integer turn, but timeline turns
 * are keyed by a hex `turn_id` with only `started_at`/`ended_at` — so we
 * bridge by time, not by key.
 *
 * A prompt initiates a turn: the `UserPromptSubmit` hook fires just before
 * the proxy opens the turn, so a prompt's `ts` sits at or just before its
 * turn's `started_at`. We walk turns oldest-first and give each turn the
 * earliest prompt that arrived after the previous turn ended and no later
 * than this turn ended (the prompt that kicked it off). Returns a map of
 * `turn_id → prompt`; turns with no matching capture are simply absent.
 */
export function matchPromptsToTurns(
  turns: ReadonlyArray<{
    turn_id: string;
    started_at: number;
    ended_at: number;
  }>,
  prompts: ReadonlyArray<PromptForTurn>
): Map<string, PromptForTurn> {
  const byStart = [...turns].sort((a, b) => a.started_at - b.started_at);
  const byTs = prompts
    .map((p) => ({ p, ms: Date.parse(p.ts) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);
  const out = new Map<string, PromptForTurn>();
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const t of byStart) {
    for (const { p, ms } of byTs) {
      if (ms > prevEnd && ms <= t.ended_at) {
        out.set(t.turn_id, p);
        break; // earliest in the window = the initiating prompt
      }
    }
    prevEnd = t.ended_at;
  }
  return out;
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
