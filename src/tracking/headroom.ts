/**
 * Turn-headroom estimator — usage-scaled with cross-turn compounding.
 *
 * The flagship "turns earned" metric, derived per time-window
 * (today / this_week / since_install). All inputs are aggregated over
 * a single window's `token_flow_events`; three windows = three
 * independent applications of the same formula.
 *
 * Five invariants the metric must satisfy (a prior per-snapshot
 * formula C/(W−S) − C/W violated 1 and 2):
 *
 *   1. Monotonic across nested windows (today ≤ week ≤ since-install).
 *   2. Scales with observed turn count N — 10× usage at the same
 *      compression ratio earns 10× credit.
 *   3. Bounded above by Σs (total tokens saved); cannot fabricate.
 *   4. Captures cross-turn compounding — each saved byte's value grows
 *      with how aggressively the rest is compressed.
 *   5. Uses only data we actually log: tokens_without / tokens_saved /
 *      (session_id, turn) per event.
 *
 * Definitions for a window:
 *   N   = unique (session, turn) count
 *   Σw  = Σ tokens_without across events
 *   Σs  = Σ tokens_saved across events
 *   δ̄  = Σw / N           (avg raw per-turn content)
 *   s̄  = Σs / N           (avg per-turn saved)
 *   δ̄_eff = δ̄ − s̄        (avg with-unerr per-turn cost)
 *   r   = Σs / Σw          (compression ratio ∈ [0, 1))
 *
 * Formula (three equivalent statements):
 *
 *   turns_earned = Σs / δ̄_eff       — "saved bytes ÷ with-unerr turn cost"
 *                = N · r / (1 − r)  — "each turn earns r/(1−r) equivalents"
 *                = (N · δ̄ / δ̄_eff) − N  — "baseline turns required − N"
 *
 * THEORETICAL ANCHORS (the r/(1−r) shape is canonical, not invented):
 *
 *   • Little's Law (Little 1961, Operations Research 9): L = λ·W. For
 *     context-as-queue, expected session length = C / arrival_rate, so
 *     L_unerr / L_baseline = δ̄ / δ̄_eff = 1/(1−r). Per-session ceiling.
 *
 *   • M/M/1 effective capacity (Kendall queueing, Erlang): μ_eff =
 *     μ/(1−ρ). The /(1−ρ) divergence as utilization → 1 is the same
 *     shape as ours as r → 1.
 *
 *   • Amdahl's Law (Amdahl 1967, AFIPS): Speedup = 1/((1−p) + p/n) →
 *     1/(1−p) in the asymptote. Our capacity multiplier `1/(1−r)` is
 *     Amdahl's reciprocal form.
 *
 *   • Shannon source coding (Shannon 1948, BSTJ 27): channel rate gain
 *     under compression R is R/(1−R) extra payloads per channel-use.
 *     Same algebra; we apply it to context-window-as-channel.
 *
 *   • Belady cache theory (Belady 1966, IBM Sys J 5): byte-hours
 *     saved = bytes × residency. The /(1−r) factor in our formula IS
 *     the empirical residency multiplier — each saved byte stays out
 *     of the prompt for 1/(1−r) average future turns.
 *
 *   • LZ-class compression bounds (Ziv-Lempel 1977, IEEE Trans Inf
 *     Theory IT-23): empirical r ∈ [0.6, 0.9] on redundant token
 *     streams. Observed unerr ratios (~0.77–0.85) sit inside the
 *     LZ77/LZ78 compressibility envelope for tool-output prose.
 *
 * The /(1−r) factor is the compounding amplifier: as r → 1, marginal
 * value of each saved byte diverges. Implementation clamps δ̄_eff ≥ 1
 * token to keep the result finite.
 *
 * `turnsToLimitWith` / `turnsToLimitWithout` are the **second** headline
 * metric — "Session Reach". Per Little's Law, at this average rate, how
 * long would a single session last before hitting C?  These are
 * per-session ceilings (independent of N) and they map cleanly to
 * window-billed agents (Claude Code 5-hour quota, Copilot Pro caps)
 * where extra prompts cannot be earned but each session can stretch
 * further before context exhaustion.
 *
 * ── Dual-metric model (the two honest projections of r) ────────────
 *
 *   PROJECTION              FORMULA              SCALES WITH   BILLING MODEL
 *   ─────────────────────   ─────────────────    ───────────   ───────────────────
 *   Turns Earned            N · r/(1−r)          usage N       credit / per-call
 *                                                              (Cursor fast-req,
 *                                                              API metered spend)
 *
 *   Session Reach gain      C·r / (δ̄·δ̄_eff)      reach C/δ̄     window / quota
 *                          ≈ ⌊C/δ̄_eff⌋ − ⌊C/δ̄⌋                 (Claude Code 5h,
 *                                                              Copilot Pro caps)
 *
 * Both project the same compression ratio r onto different axes:
 *   - multiply by N (usage) → credit equivalents you didn't pay for
 *   - multiply by C/δ̄ (headroom) → per-session ceiling extension
 *
 * The two-line UI guidance: show both numbers, label them with the
 * billing model they speak to, and ship one short caption tying the
 * pair together. Neither is "the right one" in isolation — each is
 * the honest number for one half of the user base.
 */

/** Uniform context-window cap across agents.
 *  Claude 4 supports 1M (extended), Gemini 1M, Cursor varies. We treat
 *  1M as the planning ceiling so the headroom number is comparable
 *  across agents without per-agent branching. */
export const CONTEXT_LIMIT_TOKENS = 1_000_000;

/** Conservative session-mean for context cost the events table cannot see:
 *  system prompt, tool schemas in tools/list, growing conversation history,
 *  reasoning tokens, user/model text, and native Read/Edit/Grep operations
 *  the agent runs outside the unerr proxy. Subtracted in the denominator so
 *  the "+N turns earned" ratio cannot inflate by the ratio between the small
 *  sliver unerr touched and the full per-turn cost the user actually paid.
 *
 *  30k is a conservative early-session anchor. Real values run higher
 *  mid- and late-session as transcript grows. A follow-up will replace this
 *  scalar with a per-turn measurement sourced from bridge byte counts. */
export const DEFAULT_UNOBSERVED_OVERHEAD_TOKENS = 30_000;

export interface CompoundedHeadroomInput {
  contextLimit: number;
  /** Avg tokens per turn WITHOUT unerr — i.e. mean of `tokens_without` across turns. */
  avgTurnTokensWithout: number;
  /** Avg tokens unerr saved per turn — total_saved / turn_count. */
  avgSavedPerTurn: number;
  /** Total turns observed in the period (display-only). */
  turnsObserved: number;
  /** Optional unobserved per-turn overhead (system prompt + schemas +
   *  history + reasoning + native tool calls bypassing unerr). When
   *  omitted, behaves like the pre-clamp formula (U = 0) — kept optional
   *  so old test fixtures keep their exact numerics. New surfaces should
   *  pass `DEFAULT_UNOBSERVED_OVERHEAD_TOKENS`. */
  unobservedOverheadPerTurn?: number;
}

export interface CompoundedHeadroomResult {
  /** Extra turns earned compared to the no-unerr baseline. */
  headroomTurns: number;
  turnsObserved: number;
  avgTurnTokensWithout: number;
  /** Turns until context limit WITH unerr active. */
  turnsToLimitWith: number;
  /** Turns until context limit WITHOUT unerr. */
  turnsToLimitWithout: number;
}

export function computeCompoundedHeadroom(
  input: CompoundedHeadroomInput
): CompoundedHeadroomResult {
  const {
    contextLimit,
    avgTurnTokensWithout,
    avgSavedPerTurn,
    turnsObserved,
    unobservedOverheadPerTurn = 0,
  } = input;

  if (avgTurnTokensWithout <= 0 || turnsObserved <= 0) {
    return {
      headroomTurns: 0,
      turnsObserved,
      avgTurnTokensWithout,
      turnsToLimitWith: 0,
      turnsToLimitWithout: 0,
    };
  }

  // Honest per-turn cost without unerr = the slice we measured plus the
  // slice we couldn't measure (system prompt, schemas, transcript, etc.).
  // Without the overhead term the formula divides by the tiny sliver we
  // touched and inflates by the ratio of sliver-to-total-turn cost.
  const overhead = Math.max(0, unobservedOverheadPerTurn);
  const honestTurnCostWithout = avgTurnTokensWithout + overhead;

  // Per-session capacity ceilings via Little's Law: at the observed
  // arrival rates, how many turns until cumulative prompt hits C?
  // Kept for the secondary "session capacity" badge — NOT the headline.
  const turnsToLimitWithout = Math.floor(contextLimit / honestTurnCostWithout);

  if (avgSavedPerTurn <= 0) {
    return {
      headroomTurns: 0,
      turnsObserved,
      avgTurnTokensWithout,
      turnsToLimitWith: turnsToLimitWithout,
      turnsToLimitWithout,
    };
  }

  // δ̄_eff = avg with-unerr per-turn cost. Clamp to ≥1 token: s̄ ≥ δ̄
  // shouldn't occur in real telemetry (unerr cannot save more than the
  // turn cost) and would otherwise drive the formula to infinity.
  const withTurnCost = Math.max(1, honestTurnCostWithout - avgSavedPerTurn);
  const turnsToLimitWith = Math.floor(contextLimit / withTurnCost);

  // ── Flagship metric: Σs / δ̄_eff (= N · r / (1 − r)) ─────────────
  //
  // Reads as: "the tokens unerr saved you in this window, expressed
  // as additional turns at your current with-unerr per-turn cost."
  //
  // Equivalent to N · r/(1−r) where r = Σs/Σw — the canonical
  // capacity-gain ratio from Little's Law / M/M/1 / Shannon /
  // Amdahl-reciprocal forms. Linear in N (scales with usage),
  // monotonic over nested windows, bounded above by Σs.
  const totalSaved = avgSavedPerTurn * turnsObserved;
  const headroomTurns = Math.max(0, Math.floor(totalSaved / withTurnCost));

  return {
    headroomTurns,
    turnsObserved,
    avgTurnTokensWithout,
    turnsToLimitWith,
    turnsToLimitWithout,
  };
}
