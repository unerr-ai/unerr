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
 *   unerr » this turn: helped <N> times (<summary>) · saved ~<K> tokens
 *           · ~<H> extra turns of room added
 *
 * Honest-zero rendering:
 *   - "nothing to help with this turn" when no events fired.
 *   - "no token savings this turn" when tokens_saved == 0.
 *   - "session length unchanged" when extra_turns == 0.
 *
 * Compressed variant (≥60 tokens):
 *   unerr » helped <N>× · ~<H> extra turns of room
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
import {
  summarizeSessionEconomy,
  totalTokensSavedInSession,
} from "../tracking/session-economy.js";
import { readTokenFlowEvents } from "../tracking/token-flow.js";
import {
  type RuntimeJoinCounts,
  computeRuntimeJoins,
  renderRuntimeJoinSegment,
} from "../tracking/runtime-joins.js";

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
  /** Fix L — cross-tier runtime joins for this turn. When present and
   *  any count is non-zero, the renderer prepends a `⚡ unerr runtime:
   *  …` segment to the footer (the third visual register, distinct from
   *  `ur|<tag>` and `unerr »`). Absent or all-zero produces exactly the
   *  legacy footer output (backwards-compatible). */
  runtimeJoins?: RuntimeJoinCounts;
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
 * `unerr » ` prefix and trailing boundary.
 */
export function renderTurnFooter(inputs: TurnFooterInputs): string {
  const {
    events,
    tokensSavedThisTurn,
    turnsOfHeadroomThisSession,
    runtimeJoins,
  } = inputs;

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

  // Fix L — cross-tier runtime joins segment. Elided when undefined or
  // all counts are zero, keeping the legacy footer shape byte-identical
  // for any turn that didn't perform a join. Prefix-positioned because
  // the join surface is the highest-leverage positioning information per
  // §12 of surface-reliability-root-cause.md.
  const joinsPart = runtimeJoins ? renderRuntimeJoinSegment(runtimeJoins) : "";

  const baseLine = `this turn: ${catchesPart} · ${savedPart} · ${headroomPart}`;
  const fullWithJoins = joinsPart ? `${joinsPart} · ${baseLine}` : baseLine;

  if (approxTokens(fullWithJoins) <= FOOTER_MAX_TOKENS) return fullWithJoins;
  // Joins-only fits → prefer joins over savings/headroom on overflow.
  if (joinsPart && approxTokens(joinsPart) <= FOOTER_MAX_TOKENS) {
    const compactBase = `helped ${events.length}× · ~${turnsOfHeadroomThisSession} extra ${turnsOfHeadroomThisSession === 1 ? "turn" : "turns"} of room`;
    const candidate = `${joinsPart} · ${compactBase}`;
    if (approxTokens(candidate) <= FOOTER_MAX_TOKENS) return candidate;
    return joinsPart;
  }
  // No joins this turn — fall back to the legacy compressed variant.
  return `helped ${events.length}× · ~${turnsOfHeadroomThisSession} extra ${turnsOfHeadroomThisSession === 1 ? "turn" : "turns"} of room`;
}

/** Session-cumulative summary, rendered as the close-out line the agent
 *  includes verbatim in its end-of-turn message. Aggregates ALL events
 *  for the session (not just this tool call) so the number is the
 *  user-meaningful "what unerr did across the whole conversation". */
export interface SessionEconomyLineInputs {
  /** Total NamedEvents across the session. */
  totalEvents: number;
  /** Sum of tokens_saved across the session. */
  totalTokensSaved: number;
  /** Compounded turn-headroom for the session. */
  headroomCompounded: number;
  /** All NamedEvents this session — used to render the "top: …" highlights
   *  segment that shows the user *where* unerr helped, not just how often.
   *  Optional for backwards compatibility with callers that only want the
   *  three-segment line. */
  events?: NamedEvent[];
  /** Named-noun input (the hot-take lift): the file path unerr's signals
   *  hit most in this session. When present, suffixed to the line as
   *  `· your context: <path>` so the receipt names something concrete
   *  from the user's own codebase — the single change with the largest
   *  effect on shareability (identifiable-victim effect, Wrapped pattern). */
  topFile?: string | null;
  /** Named-noun input — verbatim content of the top recalled note/rule
   *  this session. When present (typically along with `topNoteCreatedAt`),
   *  surfaced as `· remembered: "<content>" (you set <when>)` so the
   *  receipt proves unerr kept the user's prior thinking alive across
   *  sessions. Server-side wiring lands in a follow-up — the renderer
   *  accepts it now so the wiring is a one-line plumb. */
  topNoteContent?: string | null;
  /** Epoch ms when the top note was first stored. Pairs with
   *  `topNoteContent` to render the "(you set 3d ago)" age phrase. */
  topNoteCreatedAt?: number | null;
  /** Clock injection for relative-age formatting. Defaults to `Date.now()`
   *  in production; tests pass a fixed value so the output is stable. */
  nowMs?: number;
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
    if (e.file_path) counts.set(e.file_path, (counts.get(e.file_path) ?? 0) + 1);
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

/**
 * Render the session-cumulative economy line — the user-facing close-out
 * receipt. Framed as "your session" because the brag belongs to the
 * user's prior work (Wrapped pattern: subject = the user, not the tool).
 *
 * Form: `your session: saved <exact_tokens> tokens via <top highlights> · kept ~<N> extra turns of chat room`
 *
 * Trust-pattern choices (Stripe-style transparency):
 *   - Exact integer (`88,402`) for the measured value, not `~88k`. Precision
 *     reads as instrumentation; rounded marketing-style numbers erode trust
 *     and stop landing as screenshots.
 *   - `~` survives ONLY on the derived headroom estimate where it's honest
 *     (the C·S / (T·(T+S)) compounding is a heuristic projection, not a
 *     measurement).
 *   - `via <highlights>` decomposes the savings into the user's own prior
 *     work — falsifiable shape ("of N recalled notes …") that travels better
 *     than the aggregate alone.
 */
export function renderSessionEconomyLine(
  inputs: SessionEconomyLineInputs
): string {
  const {
    totalEvents,
    totalTokensSaved,
    headroomCompounded,
    events,
    topFile,
    topNoteContent,
    topNoteCreatedAt,
    nowMs,
  } = inputs;

  // Honest-zero short-circuit — no events, no claim. Avoids "saved 0 tokens"
  // marketing-tone artefacts that erode trust the way a generic "1 stored
  // fact loaded" does on the opening line.
  if (totalEvents === 0 && totalTokensSaved === 0) {
    return "your session: nothing to act on yet";
  }

  const highlightsPart = events ? topHighlightsPhrase(events, 3) : "";

  const headroomPart =
    headroomCompounded > 0
      ? `kept ~${headroomCompounded} extra ${headroomCompounded === 1 ? "turn" : "turns"} of chat room`
      : "";

  // Locale-formatted exact integer (88402 → "88,402"). The decimal precision
  // is what makes the line screenshotable per the RTK-on-HN reference.
  const savedExact = totalTokensSaved.toLocaleString("en-US");

  let head: string;
  if (totalTokensSaved > 0) {
    head = highlightsPart
      ? `saved ${savedExact} tokens via ${highlightsPart}`
      : `saved ${savedExact} tokens`;
  } else {
    // Events fired but no token savings — surface the highlights alone.
    head = highlightsPart
      ? highlightsPart
      : `${totalEvents} ${totalEvents === 1 ? "event" : "events"}`;
  }

  const base = `your session: ${head}`;

  // Named-noun suffixes (hot-take lift): each only appears when its source
  // value is concrete. Generic counts are forbidden — naming nothing is
  // strictly preferred to naming "files cached", per the identifiable-
  // victim effect (one concrete artefact > N anonymous aggregates).
  const tailParts: string[] = [];
  if (headroomPart) tailParts.push(headroomPart);
  if (topNoteContent && topNoteContent.trim().length > 0) {
    const createdAt = topNoteCreatedAt;
    if (typeof createdAt === "number" && createdAt > 0) {
      const age = formatRelativeAge(createdAt, nowMs ?? Date.now());
      tailParts.push(`remembered: "${topNoteContent}" (you set ${age})`);
    } else {
      tailParts.push(`remembered: "${topNoteContent}"`);
    }
  }
  if (topFile && topFile.length > 0) {
    tailParts.push(`your context: ${topFile}`);
  }

  return tailParts.length > 0 ? `${base} · ${tailParts.join(" · ")}` : base;
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
 * Form: `this turn: +<turn_tokens> tokens (<turn_highlights>) · session: <session_tokens> saved, ~<H> turns of chat room kept`
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
      `~${sessionHeadroom} ${sessionHeadroom === 1 ? "turn" : "turns"} of chat room kept`
    );
  }
  const sessionPart =
    sessionFragments.length > 0 ? `session: ${sessionFragments.join(", ")}` : "";

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

    // Per-turn slice — filter the same way the writers stamp rows.
    const turnEvents = allEvents.filter((e) => e.turn === currentTurn);
    let turnTokensSaved = 0;
    for (const e of tokenFlow) {
      if (e.session_id === sessionId && e.turn === currentTurn) {
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

    // Fix L — compute the cross-tier joins for this turn so the live
    // renderer can prefix the `⚡ unerr runtime: …` segment.
    const runtimeJoins = computeRuntimeJoins(allEvents, sessionId, turnIndex);

    return renderTurnFooter({
      events: turnEvents,
      tokensSavedThisTurn,
      turnsOfHeadroomThisSession: headroom,
      runtimeJoins,
    });
  } catch {
    return "";
  }
}
