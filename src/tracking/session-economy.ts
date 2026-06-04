/**
 * Session Economy — turn-headroom translation.
 *
 * Phase 1, Sprint 2 of the four-surface presence model. Read-only helper:
 * reads existing `token_flow_events` rows (which Token Trace and every
 * other current pane continue to read unchanged) and translates the raw
 * "tokens saved" number into the more emotionally legible unit of
 * "extra turns of headroom" — i.e., how many additional turns the user
 * effectively bought with the savings unerr produced.
 *
 * This module NEVER writes. It does not modify any schema, any existing
 * reader, or any existing aggregator. It is consumed by:
 *   - Sprint 3's `turn-footer.ts` (per-turn headroom number)
 *   - Sprint 10's Session Economy page (cumulative + per-session view)
 *
 * Math:
 *   avg_in(session)              = sum(input_tokens) / max(1, turn_count)
 *   extra_turns_bought(session)  = floor(total_saved / max(1, avg_in))
 *   turn_headroom_this_turn(t)   = floor(tokens_saved_this_turn(t) / avg_in)
 *
 * Honest-zero contract: returns 0 (not null, not "—") when the inputs
 * are zero. The renderer's job is to translate 0 into the user-facing
 * "session headroom unchanged" line; this module returns numbers.
 *
 * See: .internal/PERCEPTION_TO_PRESENCE.md §9.3 (footer math),
 * §12 Sprint 2.
 */

import {
  CONTEXT_LIMIT_TOKENS,
  DEFAULT_UNOBSERVED_OVERHEAD_TOKENS,
  computeCompoundedHeadroom,
} from "./headroom.js";
import { type TokenFlowEvent, readTokenFlowEvents } from "./token-flow.js";

/**
 * Average input-token cost of a turn for the given session.
 *
 * "Input tokens" = `tokens_without` summed across every event for the
 * session, divided by the count of distinct turns the session emitted.
 * The intuition is "how big is one turn on this agent, in tokens, on
 * average, ignoring unerr's savings."
 *
 * Returns 0 when no turns exist. The caller is responsible for the
 * divide-by-zero check via `max(1, avg)` at the call site of any ratio.
 *
 * The `lastN` parameter restricts the average to the most recent `n`
 * turns (by turn index). Defaults to all turns. Use a smaller window
 * (e.g., 10) for "rolling average" framing in the footer.
 */
export function averageInputTokensPerTurn(
  events: TokenFlowEvent[],
  sessionId: string,
  lastN?: number
): number {
  const session = events.filter((e) => e.session_id === sessionId);
  if (session.length === 0) return 0;

  // Group by turn, sum tokens_without per turn.
  const perTurn = new Map<number, number>();
  for (const e of session) {
    perTurn.set(e.turn, (perTurn.get(e.turn) ?? 0) + e.tokens_without);
  }
  if (perTurn.size === 0) return 0;

  let turnTotals = [...perTurn.entries()].sort((a, b) => a[0] - b[0]);
  if (lastN !== undefined && lastN > 0 && turnTotals.length > lastN) {
    turnTotals = turnTotals.slice(-lastN);
  }

  const sum = turnTotals.reduce((acc, [, v]) => acc + v, 0);
  return Math.floor(sum / turnTotals.length);
}

/**
 * Total tokens saved across every event in the session.
 *
 * Sum of `tokens_saved` for every `token_flow_events` row with matching
 * `session_id`. Honest-zero when the session has no savings yet.
 */
export function totalTokensSavedInSession(
  events: TokenFlowEvent[],
  sessionId: string
): number {
  let saved = 0;
  for (const e of events) {
    if (e.session_id === sessionId) saved += e.tokens_saved;
  }
  return saved;
}

/**
 * Tokens saved in a single turn of a session.
 *
 * Sum of `tokens_saved` for every event where `session_id` matches and
 * `turn` equals `turnIndex`. Honest-zero when the turn produced no
 * savings.
 */
export function tokensSavedInTurn(
  events: TokenFlowEvent[],
  sessionId: string,
  turnIndex: number
): number {
  let saved = 0;
  for (const e of events) {
    if (e.session_id === sessionId && e.turn === turnIndex) {
      saved += e.tokens_saved;
    }
  }
  return saved;
}

/**
 * Turns of headroom the session has "bought" so far.
 *
 *   extra_turns_bought = floor(total_saved / max(1, avg_in_per_turn))
 *
 * Returns 0 when avg_in is 0 or saved is ≤ 0. This is the cumulative
 * number Sprint 10's Session Economy page headlines.
 */
export function extraTurnsBought(
  events: TokenFlowEvent[],
  sessionId: string
): number {
  const avgIn = averageInputTokensPerTurn(events, sessionId);
  if (avgIn === 0) return 0;
  const saved = totalTokensSavedInSession(events, sessionId);
  if (saved <= 0) return 0;
  return Math.floor(saved / Math.max(1, avgIn));
}

/**
 * Per-turn headroom delta — turns "bought" by this specific turn.
 *
 *   headroom_this_turn = floor(tokens_saved_this_turn / max(1, avg_in_rolling))
 *
 * `lastN` controls the rolling-average window. Default 10 turns —
 * smooths out the early-session cold-start. Used by Sprint 3's footer
 * for the per-turn "+N turns headroom" line.
 */
export function turnHeadroomThisTurn(
  events: TokenFlowEvent[],
  sessionId: string,
  turnIndex: number,
  lastN = 10
): number {
  const avgIn = averageInputTokensPerTurn(events, sessionId, lastN);
  if (avgIn === 0) return 0;
  const saved = tokensSavedInTurn(events, sessionId, turnIndex);
  if (saved <= 0) return 0;
  return Math.floor(saved / Math.max(1, avgIn));
}

// ── Convenience: live read directly from the store ───────────────────

/**
 * Live per-turn headroom — reads events from the store and computes in
 * one call. Convenience wrapper for Sprint 3's turn-footer hot path.
 *
 * Returns 0 on any read error (defensive — the footer must never crash
 * the response pipeline).
 */
export function liveTurnHeadroom(
  unerrDir: string,
  sessionId: string,
  turnIndex: number,
  lastN = 10
): number {
  try {
    const events = readTokenFlowEvents(unerrDir, { session_id: sessionId });
    return turnHeadroomThisTurn(events, sessionId, turnIndex, lastN);
  } catch {
    return 0;
  }
}

/**
 * Live cumulative session headroom — reads events and computes in one
 * call. Convenience wrapper for Sprint 10's Session Economy page.
 */
export function liveExtraTurnsBought(
  unerrDir: string,
  sessionId: string
): number {
  try {
    const events = readTokenFlowEvents(unerrDir, { session_id: sessionId });
    return extraTurnsBought(events, sessionId);
  } catch {
    return 0;
  }
}

/** Snapshot of session-economy numbers for a single session, consumed
 *  by Token Trace (headroom strip + per-session detail) and the
 *  chat-pane turn footer. */
export interface SessionEconomySummary {
  session_id: string;
  /** Distinct turn indexes seen in token_flow_events for this session. */
  turn_count: number;
  /** Rolling-average input-tokens-per-turn WITHOUT unerr (all turns). */
  avg_input_tokens_per_turn: number;
  /** Sum of tokens_saved across the session. */
  total_tokens_saved: number;
  /** Legacy linear estimate: floor(total_saved / max(1, avg_in)).
   *  Retained for back-compat; new surfaces should read
   *  `headroom_compounded` instead. */
  extra_turns_bought: number;
  /** Compounded turn-headroom — models the context window filling
   *  cumulatively. floor(C/(W-S) - C/W) where W = avg_input_per_turn,
   *  S = total_saved/turn_count, C = CONTEXT_LIMIT_TOKENS. */
  headroom_compounded: number;
  /** Display-only — turns until context limit with unerr active. */
  turns_to_limit_with: number;
  /** Display-only — turns until context limit without unerr. */
  turns_to_limit_without: number;
}

/** Compute a SessionEconomySummary for one session from a pre-fetched
 *  event list. Pure — no IO. */
export function summarizeSessionEconomy(
  events: TokenFlowEvent[],
  sessionId: string
): SessionEconomySummary {
  const session = events.filter((e) => e.session_id === sessionId);
  const turnSet = new Set<number>();
  for (const e of session) turnSet.add(e.turn);

  const avgIn = averageInputTokensPerTurn(events, sessionId);
  const saved = totalTokensSavedInSession(events, sessionId);
  const avgSavedPerTurn = turnSet.size > 0 ? saved / turnSet.size : 0;
  const compounded = computeCompoundedHeadroom({
    contextLimit: CONTEXT_LIMIT_TOKENS,
    avgTurnTokensWithout: avgIn,
    avgSavedPerTurn,
    turnsObserved: turnSet.size,
    unobservedOverheadPerTurn: DEFAULT_UNOBSERVED_OVERHEAD_TOKENS,
  });
  return {
    session_id: sessionId,
    turn_count: turnSet.size,
    avg_input_tokens_per_turn: avgIn,
    total_tokens_saved: saved,
    extra_turns_bought:
      avgIn === 0 || saved <= 0 ? 0 : Math.floor(saved / Math.max(1, avgIn)),
    headroom_compounded: compounded.headroomTurns,
    turns_to_limit_with: compounded.turnsToLimitWith,
    turns_to_limit_without: compounded.turnsToLimitWithout,
  };
}

/**
 * Live compounded headroom — reads events from the store and computes in
 * one call. Companion to `liveExtraTurnsBought` (linear). Use this for
 * new surfaces; the linear version is retained for back-compat only.
 */
export function liveCompoundedHeadroom(
  unerrDir: string,
  sessionId: string
): number {
  try {
    const events = readTokenFlowEvents(unerrDir, { session_id: sessionId });
    return summarizeSessionEconomy(events, sessionId).headroom_compounded;
  } catch {
    return 0;
  }
}
