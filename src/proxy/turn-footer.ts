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
 * See: .internal/PERCEPTION_TO_PRESENCE.md §9.3, §12 Sprint 3.
 */

import { openMetricsStore } from "../tracking/metrics-store.js";
import {
  type NamedEvent,
  countNamedEventsByType,
  getPhrasing,
  latestPromptBoundaryTs,
  makeInCurrentTurn,
  readNamedEvents,
} from "../tracking/named-events.js";
import {
  summarizeSessionEconomy,
  totalTokensSavedInSession,
} from "../tracking/session-economy.js";
import { readSessionRecords } from "../tracking/session-records.js";
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
  /** Descriptive phrase naming what unerr did across the SESSION
   *  (e.g. "41 recalled notes, 26 trimmed shell outputs, 17 code lookups"),
   *  pre-built by the caller with boundary noise excluded. Surfaced on
   *  QUIET turns (no per-turn savings) so the receipt always names concrete
   *  session value instead of collapsing to a bare "1 thing" line. Empty
   *  string when the session has no nameable activity. */
  sessionHighlightsPhrase: string;
  /** Sprint U TU.8 — of `turnTokensSaved`, how many tokens came from
   *  reversibility re-request reuse (`event_kind:'retrieve'` slice pull-backs)
   *  rather than raw compression. Drives the optional one-line mechanism
   *  breakdown `(Xk compress · Yk reuse)`. Optional, defaults to 0 so existing
   *  callers (and the turn-summary tests) stay valid; when 0 the line renders
   *  exactly as before (no breakdown). */
  turnRerequestSaved?: number;
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
 * Two framings, chosen by whether THIS TURN moved the needle:
 *   - Productive turn (turnTokensSaved > 0): the per-turn delta leads, the
 *     session compounding tail follows —
 *     `this turn: +<turn_tokens> tokens (<turn_highlights>) · session: <session_tokens> saved, ~<H> turns of chat room earned`
 *   - Quiet turn (turnTokensSaved === 0): a quiet turn has no per-turn delta
 *     worth a "+0 tokens" headline, and the old per-turn highlight framing
 *     ("this turn: 1 thing (no new token savings)") collapsed to a bare,
 *     value-free line. Instead lead with what unerr did across the SESSION,
 *     naming concrete activity —
 *     `session: <sessionHighlightsPhrase> · <session_tokens> saved, ~<H> turns of chat room earned`
 *
 * Honest-zero variants:
 *   - "this turn: nothing to act on yet" — turn AND session both fully empty
 *   - "this turn: no new savings" — quiet turn with no nameable session
 *     activity and no session savings/headroom to report
 *   - parenthetical turn-highlights omitted when the productive turn had no
 *     NamedEvents; session tail omitted when both session tokens AND headroom
 *     are zero
 */
export function renderHybridTurnLine(inputs: HybridTurnLineInputs): string {
  const {
    turnTokensSaved,
    turnEvents,
    sessionTokensSaved,
    sessionHeadroom,
    sessionTotalEvents,
    sessionHighlightsPhrase,
    turnRerequestSaved = 0,
  } = inputs;

  if (
    sessionTotalEvents === 0 &&
    sessionTokensSaved === 0 &&
    turnTokensSaved === 0 &&
    turnEvents.length === 0
  ) {
    return "this turn: nothing to act on yet";
  }

  // Session compounding tail — "<N> saved, ~<H> turns of chat room earned".
  // Shared by both framings; empty when the session has no savings/headroom.
  const sessionTail: string[] = [];
  if (sessionTokensSaved > 0) {
    sessionTail.push(`${formatTokenCount(sessionTokensSaved)} saved`);
  }
  if (sessionHeadroom > 0) {
    sessionTail.push(
      `~${sessionHeadroom} ${sessionHeadroom === 1 ? "turn" : "turns"} of chat room earned`
    );
  }

  // Productive turn — the per-turn delta is the headline; session tail follows.
  if (turnTokensSaved > 0) {
    const exact = turnTokensSaved.toLocaleString("en-US");

    // Sprint U TU.8 — one-line mechanism breakdown. When part of this turn's
    // savings came from reversibility reuse (a cached-slice pull-back instead
    // of a full re-deliver), split the parenthetical into compress vs reuse so
    // the user sees WHERE the tokens came from. The breakdown REPLACES the
    // event-highlights parenthetical (one parenthetical only — stays one line);
    // it renders only when BOTH a compress portion and a reuse portion are
    // non-zero, so a pure-compression or pure-reuse turn keeps the original
    // highlights framing. Numbers are concrete (no `:N` placeholders).
    const compressPortion = turnTokensSaved - turnRerequestSaved;
    const showBreakdown = turnRerequestSaved > 0 && compressPortion > 0;
    const parenthetical = showBreakdown
      ? `${formatTokenCount(compressPortion)} compress · ${formatTokenCount(turnRerequestSaved)} reuse`
      : topHighlightsPhrase(turnEvents, 2);

    const turnPart = parenthetical
      ? `this turn: +${exact} tokens (${parenthetical})`
      : `this turn: +${exact} tokens`;
    const sessionPart =
      sessionTail.length > 0 ? `session: ${sessionTail.join(", ")}` : "";
    return sessionPart ? `${turnPart} · ${sessionPart}` : turnPart;
  }

  // Quiet turn — lead with concrete SESSION activity so the receipt always
  // names value instead of collapsing to a bare per-turn line. The activity
  // phrase and the savings tail join under one `session:` prefix.
  const sessionParts: string[] = [];
  if (sessionHighlightsPhrase) sessionParts.push(sessionHighlightsPhrase);
  if (sessionTail.length > 0) sessionParts.push(sessionTail.join(", "));
  if (sessionParts.length > 0) {
    return `session: ${sessionParts.join(" · ")}`;
  }

  return "this turn: no new savings";
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
  /** Human-readable conversation label when the hook recorded one; null
   *  otherwise. Display-only — lets a client title the session economy line. */
  session_name: string | null;
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
    // Conversation label (display-only): the hook records it on the shared
    // sessions file keyed by the unerr session_id; null when unrecorded.
    const sessionName =
      readSessionRecords(unerrDir).find(
        (r) => r.unerr_session_id === sessionId
      )?.session_name ?? null;
    const totalTokensSaved = totalTokensSavedInSession(tokenFlow, sessionId);
    const headroomCompounded = summarizeSessionEconomy(
      tokenFlow,
      sessionId,
      sessionName
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

    // Sprint U TU.7/TU.9 — fold reversibility re-request savings into the same
    // line. A slice-retrieval (`event_kind:'retrieve'`) records its win on the
    // compression_events stream, NOT token_flow_events, so the loop above never
    // saw it. Add it as an extra summand (additive — never drops the shell/file/
    // wire savings already summed). compression_events carry no session_id, but
    // the metrics store is per-repo and we slice the turn by the same prompt-
    // boundary timestamp the line already uses; the store query is fidelity-
    // honest (excludes fidelity_pass = 0 rows, TU.9).
    const boundaryTs = latestPromptBoundaryTs(allEvents);
    let turnRerequestSaved = 0;
    let sessionRerequestSaved = 0;
    try {
      const store = openMetricsStore(unerrDir);
      sessionRerequestSaved = store.reversibleSavedTotal();
      // Only attributable to THIS turn when a prompt boundary exists; without
      // one (pre-hook session) we cannot bound the slice, so we leave the
      // per-turn reversibility add at 0 rather than over-counting.
      turnRerequestSaved =
        boundaryTs !== null ? store.reversibleSavedSince(boundaryTs) : 0;
    } catch {
      /* best-effort — a metrics read failure never breaks the summary line */
    }
    turnTokensSaved += turnRerequestSaved;
    const sessionTokensSaved = totalTokensSaved + sessionRerequestSaved;

    // Session activity phrase for the quiet-turn framing. Exclude
    // `user_prompt_received` — it's a turn-boundary marker, not unerr value,
    // and naming "N prompts" reads as noise next to "recalled notes" /
    // "code lookups". Top 3 keeps the line under the ~60-token budget.
    const sessionHighlightsPhrase = topHighlightsPhrase(
      allEvents.filter((e) => e.event_type !== "user_prompt_received"),
      3
    );

    const line = renderHybridTurnLine({
      turnTokensSaved,
      turnEvents,
      sessionTokensSaved,
      sessionHeadroom: headroomCompounded,
      sessionTotalEvents: allEvents.length,
      sessionHighlightsPhrase,
      turnRerequestSaved,
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
      session_name: sessionName,
      total_events: allEvents.length,
      // Augmented with session reversibility savings (TU.7) so the Stop report
      // and any downstream consumer reflect re-request wins in the cumulative.
      total_tokens_saved: sessionTokensSaved,
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
      session_name: null,
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

// The end-of-turn close-out report (`renderStopReportLive`) and its plain-
// English renderer moved to `turn-report.ts` + `receipt-renderer.ts`, where a
// single shared renderer (`renderReceiptBlock`) drives BOTH the Stop hook and
// the `unerr_turn_summary` MCP tool so their output is byte-identical across
// every agent. `renderSessionEconomyLineLive` above stays here — it is the
// data source those renderers read (and the `fallbackLine` they degrade to).
