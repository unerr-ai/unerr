/**
 * Turn Footer — Surface 3 of the four-surface presence model.
 *
 * Renders a ≤60-token user-prose footer summarizing what unerr did this
 * turn. Lives in `content[].text` of the final tool response of a turn,
 * via the `buildUserBlock()` channel in `response-envelope.ts`. The
 * agent is instructed (FORBIDDEN row in `instruction-writer.ts`) to not
 * echo or act on this — it's telemetry for the human.
 *
 * Phase 1 contract — additive only. This module:
 *   - reads existing `behavior_events` + `token_flow_events` rows via
 *     the Sprint 1 `named-events.ts` projection (no schema change);
 *   - calls Sprint 2 `session-economy.ts` for the turn-headroom number;
 *   - never modifies any existing row, writer, or reader.
 *
 * Anatomy of the footer (single line, ≤60 tokens):
 *
 *   unerr · this turn: helped <N> times (<summary>) · saved ~<K> tokens
 *           · ~<H> extra turns of room added
 *
 * Honest-zero rendering:
 *   - "nothing to help with this turn" when no events fired.
 *   - "no token savings this turn" when tokens_saved == 0.
 *   - "session length unchanged" when extra_turns == 0.
 *
 * Compressed variant (≥60 tokens):
 *   unerr · helped <N>× · ~<H> extra turns of room
 *
 * Cross-client rendering: plain text only — no ANSI codes, no markdown
 * blockquotes, no emoji.
 *
 * See: docs/open-cli/PERCEPTION_TO_PRESENCE.md §9.3 (footer), §12 Sprint 3.
 */

import {
  type NamedEvent,
  countNamedEventsByType,
  getPhrasing,
  readNamedEvents,
} from "../tracking/named-events.js";
import { summarizeSessionEconomy } from "../tracking/session-economy.js";
import { readTokenFlowEvents } from "../tracking/token-flow.js";

/** Inputs the footer renderer needs. Pure data; no IO inside `render*`. */
export interface TurnFooterInputs {
  /** NamedEvents emitted in this turn only. */
  events: NamedEvent[];
  /** Tokens saved in this turn (sum across mechanisms). */
  tokensSavedThisTurn: number;
  /** Compounded session-cumulative headroom — turns earned over the
   *  whole session via the C·S / (T·(T+S)) compounded formula. The
   *  footer's "~N extra turns of room added" framing is
   *  inherently cumulative, so we surface the session number, not a
   *  per-turn linear delta. */
  turnsOfHeadroomThisSession: number;
}

/** Token budget for the full footer line (BPE estimate, char/4). */
const FOOTER_MAX_TOKENS = 60;

/** char/4 cheap token estimator — matches `token-estimator.ts` heuristic. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Format a token count into a short human string.
 *   1_499 → "1.5k", 12_345 → "12k", 1_234_567 → "1.2M".
 * The renderer uses these to keep the footer under 60 tokens.
 */
export function formatTokenCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(n);
  if (abs < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Summarize a turn's NamedEvents into a comma-separated phrase suitable
 * for inline embedding in the footer line.
 *
 *   [stale_edit_prevented, stale_edit_prevented, full_read_avoided]
 *     → "2 stale edits, 1 file read"
 *
 * Returns the empty string when there are no events. The renderer
 * supplies the surrounding parentheses + count prefix.
 */
export function summarizeEvents(events: NamedEvent[]): string {
  if (events.length === 0) return "";
  const counts = countNamedEventsByType(events);
  const parts: string[] = [];
  for (const [eventType, count] of Object.entries(counts).sort(
    (a, b) => b[1] - a[1]
  )) {
    const { object, plural } = getPhrasing(eventType);
    parts.push(`${count} ${count === 1 ? object : plural}`);
  }
  return parts.join(", ");
}

/**
 * Render the full footer line from precomputed inputs. Pure function —
 * no IO. The data-fetch wrapper below (`renderTurnFooterLive`) is the
 * one Sprint 3 actually wires into `buildUserBlock()`.
 *
 * Always returns a single line (no embedded newlines). The line is
 * meant to be passed to `buildUserBlock([line])`, which adds the
 * `unerr · ` prefix and trailing boundary.
 */
export function renderTurnFooter(inputs: TurnFooterInputs): string {
  const { events, tokensSavedThisTurn, turnsOfHeadroomThisSession } = inputs;

  const catchesPart =
    events.length > 0
      ? `helped ${events.length} ${events.length === 1 ? "time" : "times"} (${summarizeEvents(events)})`
      : "nothing to help with this turn";

  const savedPart =
    tokensSavedThisTurn > 0
      ? `saved ~${formatTokenCount(tokensSavedThisTurn)} tokens`
      : "no token savings this turn";

  const headroomPart =
    turnsOfHeadroomThisSession > 0
      ? `~${turnsOfHeadroomThisSession} extra ${turnsOfHeadroomThisSession === 1 ? "turn" : "turns"} of room added`
      : "session length unchanged";

  const full = `this turn: ${catchesPart} · ${savedPart} · ${headroomPart}`;
  if (approxTokens(full) <= FOOTER_MAX_TOKENS) return full;

  // Compressed variant — drop savedPart (least specific) and reduce
  // catches to the bare count.
  return `helped ${events.length}× · ~${turnsOfHeadroomThisSession} extra ${turnsOfHeadroomThisSession === 1 ? "turn" : "turns"} of room`;
}

/**
 * Read the data needed for this turn's footer and render it. Returns a
 * single line ready for `buildUserBlock([line])`. On any IO error
 * returns the empty string so the response pipeline is never broken.
 */
export function renderTurnFooterLive(
  unerrDir: string,
  sessionId: string,
  turnIndex: number
): string {
  try {
    const allEvents = readNamedEvents(unerrDir, { session_id: sessionId });
    const turnEvents = allEvents.filter((e) => e.turn === turnIndex);

    const tokenFlow = readTokenFlowEvents(unerrDir, { session_id: sessionId });
    let tokensSavedThisTurn = 0;
    for (const e of tokenFlow) {
      if (e.session_id === sessionId && e.turn === turnIndex) {
        tokensSavedThisTurn += e.tokens_saved;
      }
    }

    const headroom = summarizeSessionEconomy(
      tokenFlow,
      sessionId
    ).headroom_compounded;

    return renderTurnFooter({
      events: turnEvents,
      tokensSavedThisTurn,
      turnsOfHeadroomThisSession: headroom,
    });
  } catch {
    return "";
  }
}
