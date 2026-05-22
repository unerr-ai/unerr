/**
 * Engagement Telemetry — Phase 3 Sprint 12.
 *
 * Local-only signals for the four-surface presence model. Records the
 * data we need to know which surfaces land for the user without
 * sending anything off-machine. Every measurement is derived from
 * existing tables (`named_events`, `behavior_events`, `token_flow_events`)
 * and the per-session metrics store — no new schema, no external POSTs.
 *
 * Signals (per §12 Sprint 12):
 *   - follow-up turn latency after Surface 2 preface / Surface 3 footer
 *     emission (proxy for "user read it before continuing")
 *   - confirmation answer rate (Sprint 6 `pending_confirmation` →
 *     resolved vs expired)
 *   - ambient-marker fallback rate (fraction of turns where the
 *     preface/footer collapsed to `unerr · ⋯`)
 *   - enforcement correlation (Sprint 8 `ur|fct` line emitted, agent's
 *     next-turn behavior matched the stored fact)
 *   - user-fed retention (facts surviving N days vs edited/deleted)
 *
 * Pure — no IO. Callers pass the named-event projection in; readers may
 * compose this over any time window.
 */

import type { NamedEvent } from "./named-events.js";

// ── Per-surface engagement ───────────────────────────────────────────

export interface FollowupLatencyStats {
  /** Number of turns measured. */
  samples: number;
  /** Median time-to-next-turn in ms. */
  median_ms: number;
  /** p90 time-to-next-turn in ms. */
  p90_ms: number;
}

/**
 * Compute the inter-turn latency distribution from a named-event stream.
 * Uses `tokenflow.*` and behavior events keyed by `(session_id, turn)`
 * to find the first event of each turn; the delta between consecutive
 * turns' first events approximates "how long the user took to read the
 * previous turn's preface/footer before sending the next prompt."
 *
 * Sessions are processed independently — cross-session deltas are NOT
 * mixed in (different agents, different IDEs, would skew the median).
 */
export function followupLatency(events: NamedEvent[]): FollowupLatencyStats {
  const firstTsByTurn = new Map<string, number>();
  for (const ev of events) {
    const key = `${ev.session_id}|${ev.turn}`;
    const ts = Date.parse(ev.ts);
    if (Number.isNaN(ts)) continue;
    const prev = firstTsByTurn.get(key);
    if (prev === undefined || ts < prev) firstTsByTurn.set(key, ts);
  }

  // Group by session, sort by turn, compute deltas between consecutive turns.
  const bySession = new Map<string, Array<[number, number]>>();
  for (const [key, ts] of firstTsByTurn) {
    const [session, turnStr] = key.split("|");
    if (!session || !turnStr) continue;
    const turn = Number(turnStr);
    if (!Number.isFinite(turn)) continue;
    const arr = bySession.get(session) ?? [];
    arr.push([turn, ts]);
    bySession.set(session, arr);
  }

  const deltas: number[] = [];
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!;
      const cur = arr[i]!;
      const delta = cur[1] - prev[1];
      if (delta >= 0) deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    return { samples: 0, median_ms: 0, p90_ms: 0 };
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] ?? 0;
  const p90 = deltas[Math.floor(deltas.length * 0.9)] ?? 0;
  return { samples: deltas.length, median_ms: median, p90_ms: p90 };
}

// ── Confirmation engagement ──────────────────────────────────────────

export interface ConfirmationStats {
  registered: number;
  resolved: number;
  expired: number;
  answer_rate: number;
}

/**
 * Confirmation engagement from named events. We track `fact_stored_user_fed`
 * (carries `ambiguity_flag` in metadata when registered) and
 * `confirmation_expired` (Sprint 6's sweep emission). Confirmations that
 * are neither answered nor expired remain pending — they're counted as
 * "registered" only.
 */
export function confirmationStats(events: NamedEvent[]): ConfirmationStats {
  let registered = 0;
  let expired = 0;
  let resolved = 0;
  for (const ev of events) {
    if (ev.event_type === "fact_stored_user_fed") {
      const ambig = (ev.metadata as { ambiguity_flag?: boolean })
        .ambiguity_flag;
      if (ambig === true) registered++;
    }
    if (ev.event_type === "confirmation_expired") expired++;
    // Heuristic: any fact_recalled on a previously ambiguity-flagged fact_id
    // would indicate the user re-engaged — captured by reinforcement_count
    // delta but that requires a join, so we approximate with the ratio.
    // `resolved = registered - expired - pending`. Pending is unknowable
    // from the event stream alone; we treat resolved ≥ registered - expired.
    if (ev.event_type === "fact_recalled") {
      const source = (ev.metadata as { source?: string }).source;
      if (source === "user_fed") resolved++;
    }
  }
  const answered = Math.max(0, Math.min(resolved, registered - expired));
  const answer_rate =
    registered === 0 ? 0 : Math.round((answered / registered) * 1000) / 1000;
  return { registered, expired, resolved: answered, answer_rate };
}

// ── Ambient-marker fallback rate ─────────────────────────────────────

export interface AmbientFallbackStats {
  total_turns: number;
  ambient_turns: number;
  fallback_rate: number;
}

/**
 * Ambient-marker fallback = turns where the preface/footer collapsed to
 * the `unerr · ⋯` ambient marker because there was nothing to report.
 * The proxy emits a `behavior_events` row with type
 * `presence_ambient_marker` for those turns. We project that here.
 */
export function ambientFallback(events: NamedEvent[]): AmbientFallbackStats {
  const turns = new Set<string>();
  let ambient = 0;
  for (const ev of events) {
    const key = `${ev.session_id}|${ev.turn}`;
    turns.add(key);
    if (ev.event_type === "presence_ambient_marker") ambient++;
  }
  const total = turns.size;
  const rate = total === 0 ? 0 : Math.round((ambient / total) * 1000) / 1000;
  return { total_turns: total, ambient_turns: ambient, fallback_rate: rate };
}

// ── Enforcement correlation ──────────────────────────────────────────

export interface EnforcementCorrelation {
  enforced: number;
  followed: number;
  correlation: number;
}

/**
 * Enforcement correlation — Sprint 8 emits `ur|fct` lines via
 * `convention_applied` / `caller_check_enforced`. We approximate
 * "agent's next-turn behavior matched the stored fact" by checking that
 * the next turn in the same session emitted at least one
 * `fact_recalled`, `convention_applied`, or `caller_check_enforced`
 * event — i.e., the agent acted on stored knowledge rather than ignoring
 * the surfaced fact.
 */
export function enforcementCorrelation(
  events: NamedEvent[]
): EnforcementCorrelation {
  const bySession = new Map<string, NamedEvent[]>();
  for (const ev of events) {
    if (!bySession.has(ev.session_id)) bySession.set(ev.session_id, []);
    bySession.get(ev.session_id)!.push(ev);
  }
  let enforced = 0;
  let followed = 0;
  const followEvents = new Set([
    "fact_recalled",
    "convention_applied",
    "caller_check_enforced",
  ]);
  for (const arr of bySession.values()) {
    arr.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i]!;
      const isEnforcement =
        ev.event_type === "convention_applied" ||
        ev.event_type === "caller_check_enforced";
      if (!isEnforcement) continue;
      enforced++;
      for (let j = i + 1; j < arr.length; j++) {
        const next = arr[j]!;
        if (next.turn <= ev.turn) continue;
        if (followEvents.has(next.event_type)) {
          followed++;
          break;
        }
        if (next.turn > ev.turn + 1) break;
      }
    }
  }
  return {
    enforced,
    followed,
    correlation:
      enforced === 0 ? 0 : Math.round((followed / enforced) * 1000) / 1000,
  };
}

// ── User-fed retention ───────────────────────────────────────────────

export interface UserFedRetention {
  stored: number;
  retained: number;
  edited_or_disabled: number;
  retention_rate: number;
}

/**
 * Compute user-fed retention from a list of (fact_id, stored, surviving)
 * tuples. Caller supplies which facts are still active vs disabled —
 * this module does not query CozoDB.
 */
export function userFedRetention(
  facts: Array<{ disabled: boolean; effective_confidence: number }>
): UserFedRetention {
  const stored = facts.length;
  let retained = 0;
  let edited = 0;
  for (const f of facts) {
    if (f.disabled || f.effective_confidence < 0.05) edited++;
    else retained++;
  }
  return {
    stored,
    retained,
    edited_or_disabled: edited,
    retention_rate:
      stored === 0 ? 0 : Math.round((retained / stored) * 1000) / 1000,
  };
}

// ── Combined report ──────────────────────────────────────────────────

export interface EngagementReport {
  followup_latency: FollowupLatencyStats;
  confirmation: ConfirmationStats;
  ambient: AmbientFallbackStats;
  enforcement: EnforcementCorrelation;
  user_fed_retention: UserFedRetention;
}

/**
 * One-shot report — useful for the dashboard's Sprint 12 surface and the
 * Sprint 15 release-prep checklist.
 */
export function renderEngagementReport(
  events: NamedEvent[],
  userFedFacts: Array<{ disabled: boolean; effective_confidence: number }>
): EngagementReport {
  return {
    followup_latency: followupLatency(events),
    confirmation: confirmationStats(events),
    ambient: ambientFallback(events),
    enforcement: enforcementCorrelation(events),
    user_fed_retention: userFedRetention(userFedFacts),
  };
}
