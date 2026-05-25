/**
 * Close-out receipt renderer + shared presence formatting helpers.
 *
 * The live close-out surface is the hybrid per-turn / session receipt the
 * agent pastes verbatim at end-of-turn via the `unerr_turn_summary` MCP
 * tool:
 *   - `renderSessionEconomyLineLive` — reads `behavior_events` +
 *     `token_flow_events` off disk, slices per-turn vs. session-cumulative,
 *     and renders via `renderHybridTurnLine`.
 *   - `renderHybridTurnLine` — pure renderer for that line.
 *
 * This module also owns the small formatting helpers reused by the
 * Surface-2 opening line (`context-preface.ts`, `loaded-note-line.ts`,
 * `surface2-line-handler.ts`): `formatTokenCount`, `formatRelativeAge`,
 * `topFileFromEvents`, `topHighlightsPhrase`.
 *
 * The legacy per-response footer (`renderTurnFooter` / `renderTurnFooterLive`
 * / `renderSessionEconomyLine`) was removed when the agent-pull
 * `unerr_turn_summary` model replaced the footer that previously rode every
 * MCP tool reply — see `turn-summary-handler.ts`.
 *
 * Cross-client rendering: plain text only — no ANSI codes, no markdown
 * blockquotes, no emoji.
 *
 * See: docs/open-cli/PERCEPTION_TO_PRESENCE.md §9.3, §12 Sprint 3.
 */

import {
  type NamedEvent,
  countNamedEventsByType,
  getPhrasing,
  makeInCurrentTurn,
  readNamedEvents,
} from "../tracking/named-events.js";
import {
  summarizeSessionEconomy,
  totalTokensSavedInSession,
} from "../tracking/session-economy.js";
import { readTokenFlowEvents } from "../tracking/token-flow.js";

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
 * Format a millisecond age delta as a short human phrase suitable for the
 * "(you set …)" segment. Tuned for the receipt context — agents/devs
 * rarely care about sub-minute precision on a fact-age display.
 *
 *   500 → "just now"
 *   90_000 → "1m ago"
 *   3 * 86400_000 → "3d ago"
 *   400 * 86400_000 → "1y ago"
 */
export function formatRelativeAge(createdAt: number, now: number): string {
  const dMs = Math.max(0, now - createdAt);
  const sec = Math.floor(dMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Pick the file path with the most NamedEvents this session. Returns null
 * when no event carries a `file_path` (session-level events like
 * `cache_hit` set it to null). Used to fill the `topFile` named-noun slot
 * in the receipt lines — the single concrete artefact that lifts the
 * line from generic ("13 lookups") to shareable ("your context:
 * src/proxy/bridge.ts").
 */
export function topFileFromEvents(events: NamedEvent[]): string | null {
  if (events.length === 0) return null;
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.file_path)
      counts.set(e.file_path, (counts.get(e.file_path) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let topFile = "";
  let topCount = 0;
  for (const [file, count] of counts) {
    if (count > topCount) {
      topFile = file;
      topCount = count;
    }
  }
  return topFile;
}

/** Top-N highlights phrase. Used by the session close-out line so the
 *  user sees concretely *where* unerr helped (e.g. "12 code lookups,
 *  8 compact reads, 4 remembered notes") in addition to the raw count
 *  and token-savings number. Returns "" when no events. */
export function topHighlightsPhrase(
  events: NamedEvent[],
  topN: number
): string {
  if (events.length === 0) return "";
  const counts = countNamedEventsByType(events);
  const entries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  const parts: string[] = [];
  for (const [eventType, count] of entries) {
    const { object, plural } = getPhrasing(eventType);
    parts.push(`${count} ${count === 1 ? object : plural}`);
  }
  return parts.join(", ");
}

/** Inputs for the hybrid receipt — combines per-turn delta with session totals. */
export interface HybridTurnLineInputs {
  /** Tokens saved THIS TURN only. */
  turnTokensSaved: number;
  /** NamedEvents emitted THIS TURN only — drives the per-turn highlights tag. */
  turnEvents: NamedEvent[];
  /** Cumulative tokens saved across the whole session (compounding story). */
  sessionTokensSaved: number;
  /** Compounded turn-headroom for the session. */
  sessionHeadroom: number;
  /** Total session events — used to honor honest-zero rules. */
  sessionTotalEvents: number;
}

/**
 * Render the hybrid close-out receipt — per-turn delta + session compounding.
 *
 * Form: `this turn: +<turn_tokens> tokens (<turn_highlights>) · session: <session_tokens> saved, ~<H> turns of chat room earned`
 *
 * Per-turn portion uses the exact integer (instrumentation trust pattern);
 * the session portion rounds via formatTokenCount so the compounding line
 * stays compact ("100k saved" vs "100,175 tokens saved").
 *
 * Honest-zero variants:
 *   - "this turn: nothing to act on yet" — both turn AND session empty
 *   - "this turn: no new savings · session: …" — turn empty, session non-empty
 *   - parenthetical highlights omitted when the turn had no NamedEvents
 *   - session tail omitted when both session tokens AND headroom are zero
 */
export function renderHybridTurnLine(inputs: HybridTurnLineInputs): string {
  const {
    turnTokensSaved,
    turnEvents,
    sessionTokensSaved,
    sessionHeadroom,
    sessionTotalEvents,
  } = inputs;

  if (
    sessionTotalEvents === 0 &&
    sessionTokensSaved === 0 &&
    turnTokensSaved === 0 &&
    turnEvents.length === 0
  ) {
    return "this turn: nothing to act on yet";
  }

  let turnPart: string;
  if (turnTokensSaved > 0) {
    const turnHighlights = topHighlightsPhrase(turnEvents, 2);
    const exact = turnTokensSaved.toLocaleString("en-US");
    turnPart = turnHighlights
      ? `this turn: +${exact} tokens (${turnHighlights})`
      : `this turn: +${exact} tokens`;
  } else if (turnEvents.length > 0) {
    const turnHighlights = topHighlightsPhrase(turnEvents, 2);
    turnPart = `this turn: ${turnHighlights} (no new token savings)`;
  } else {
    turnPart = "this turn: no new savings";
  }

  const sessionFragments: string[] = [];
  if (sessionTokensSaved > 0) {
    sessionFragments.push(`${formatTokenCount(sessionTokensSaved)} saved`);
  }
  if (sessionHeadroom > 0) {
    sessionFragments.push(
      `~${sessionHeadroom} ${sessionHeadroom === 1 ? "turn" : "turns"} of chat room earned`
    );
  }
  const sessionPart =
    sessionFragments.length > 0
      ? `session: ${sessionFragments.join(", ")}`
      : "";

  return sessionPart ? `${turnPart} · ${sessionPart}` : turnPart;
}

/**
 * Live render the hybrid turn+session economy line — reads events from
 * disk, slices per-turn vs. session-cumulative, returns the rendered
 * string and a structured breakdown. Powers the `unerr_turn_summary` MCP
 * tool. Returns honest-zero shape on any read error so the tool never
 * breaks the response pipeline.
 *
 * `currentTurn` is the canonical turn-segmenter index used by every
 * writer in the proxy — passed by the dispatch site so the per-turn
 * slice matches what the writers stamped on rows.
 */
export function renderSessionEconomyLineLive(
  unerrDir: string,
  sessionId: string,
  currentTurn: number
): {
  line: string;
  total_events: number;
  total_tokens_saved: number;
  headroom_compounded: number;
  /** Per-turn structured payload — clients can render their own framing
   *  without re-parsing the prose line. */
  current_turn: number;
  turn_events: number;
  turn_tokens_saved: number;
  /** Top-N event-type breakdown (count desc) for the SESSION. */
  highlights: Array<{ event_type: string; count: number; phrasing: string }>;
  /** Top-N event-type breakdown (count desc) for the CURRENT TURN only. */
  turn_highlights: Array<{
    event_type: string;
    count: number;
    phrasing: string;
  }>;
} {
  try {
    const allEvents = readNamedEvents(unerrDir, { session_id: sessionId });
    const tokenFlow = readTokenFlowEvents(unerrDir, { session_id: sessionId });
    const totalTokensSaved = totalTokensSavedInSession(tokenFlow, sessionId);
    const headroomCompounded = summarizeSessionEconomy(
      tokenFlow,
      sessionId
    ).headroom_compounded;

    // Per-turn slice — bound to the conversational turn via the
    // user_prompt_received boundary (accurate), falling back to the
    // segmenter `turn` match for pre-hook sessions. See wrn on
    // renderSessionEconomyLineLive: the segmenter index fragments one
    // conversational turn into many, so the old `e.turn === currentTurn`
    // filter undercounted (caught the final sliver only).
    const inCurrentTurn = makeInCurrentTurn(allEvents, currentTurn);
    const turnEvents = allEvents.filter((e) => inCurrentTurn(e.ts, e.turn));
    let turnTokensSaved = 0;
    for (const e of tokenFlow) {
      if (e.session_id === sessionId && inCurrentTurn(e.ts, e.turn)) {
        turnTokensSaved += e.tokens_saved;
      }
    }

    const line = renderHybridTurnLine({
      turnTokensSaved,
      turnEvents,
      sessionTokensSaved: totalTokensSaved,
      sessionHeadroom: headroomCompounded,
      sessionTotalEvents: allEvents.length,
    });

    const mkHighlights = (counts: Record<string, number>) =>
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([event_type, count]) => {
          const { object, plural } = getPhrasing(event_type);
          return {
            event_type,
            count,
            phrasing: count === 1 ? object : plural,
          };
        });

    return {
      line,
      total_events: allEvents.length,
      total_tokens_saved: totalTokensSaved,
      headroom_compounded: headroomCompounded,
      current_turn: currentTurn,
      turn_events: turnEvents.length,
      turn_tokens_saved: turnTokensSaved,
      highlights: mkHighlights(countNamedEventsByType(allEvents)),
      turn_highlights: mkHighlights(countNamedEventsByType(turnEvents)),
    };
  } catch {
    return {
      line: "",
      total_events: 0,
      total_tokens_saved: 0,
      headroom_compounded: 0,
      current_turn: currentTurn,
      turn_events: 0,
      turn_tokens_saved: 0,
      highlights: [],
      turn_highlights: [],
    };
  }
}
