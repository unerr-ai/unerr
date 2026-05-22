/**
 * Tier and decay computation for Layer B notes.
 *
 * Decay score:
 *   score = (1 + reinforcement_count) / ln(turns_since_last_seen + e)
 *         - 0.5 * contradiction_count
 *         - (anchor_missing ? 0.5 * weeks_since_missing : 0)
 *
 * Tier assignment (top-K by score, computed across active notes only):
 *   hot   — top 20%
 *   warm  — next 50%
 *   cold  — bottom 30%
 *
 * Small-population rule: if active notes < MIN_POPULATION_FOR_TIERS, all
 * active are "hot" — small populations don't benefit from stratification
 * and would unfairly demote useful notes.
 *
 * Inactive notes (superseded or polarity-flipped) always tier "cold" and
 * are excluded from the active-percentile denominator.
 *
 * Pure module — no DB, no IO. The recomputeTiers DB driver lives elsewhere.
 *
 * See ACTIVE_COGNITION_REASON_LAYER.md §11.4.
 */

export type NoteTier = "hot" | "warm" | "cold";

export interface NoteDecayInput {
  note_id: string;
  reinforcement_count: number;
  contradiction_count: number;
  /** Session-turn index when this note was last surfaced or reinforced. */
  last_seen_turn: number;
  inactive: boolean;
  anchor_missing: boolean;
  /** Epoch ms when the anchor was first detected missing. 0 if not missing. */
  anchor_missing_since_ms: number;
}

export interface DecayResult {
  note_id: string;
  decay_score: number;
}

export interface TierResult {
  note_id: string;
  tier: NoteTier;
}

const HOT_PCT = 0.2;
const WARM_PCT = 0.7; // hot 0.20 + warm 0.50 cumulative
const MIN_POPULATION_FOR_TIERS = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Compute decay score for one note. Pure function. */
export function computeDecayScore(
  input: NoteDecayInput,
  currentTurn: number,
  nowMs: number,
): number {
  const turnsSinceLastSeen = Math.max(0, currentTurn - input.last_seen_turn);
  const baseScore =
    (1 + input.reinforcement_count) / Math.log(turnsSinceLastSeen + Math.E);
  const contradictionPenalty = 0.5 * input.contradiction_count;

  let missingPenalty = 0;
  if (input.anchor_missing && input.anchor_missing_since_ms > 0) {
    const weeksMissing = (nowMs - input.anchor_missing_since_ms) / WEEK_MS;
    missingPenalty = 0.5 * Math.max(0, weeksMissing);
  }
  return baseScore - contradictionPenalty - missingPenalty;
}

/** Compute decay scores for a batch of notes; preserves input order. */
export function computeDecayScores(
  notes: readonly NoteDecayInput[],
  currentTurn: number,
  nowMs: number,
): DecayResult[] {
  return notes.map((n) => ({
    note_id: n.note_id,
    decay_score: computeDecayScore(n, currentTurn, nowMs),
  }));
}

/**
 * Assign tiers from decay scores. Inactive notes always cold and excluded
 * from the active-percentile denominator. Small populations skip
 * stratification entirely.
 */
export function assignTiers(
  notes: readonly NoteDecayInput[],
  currentTurn: number,
  nowMs: number,
): TierResult[] {
  const active = notes.filter((n) => !n.inactive);
  const inactive = notes.filter((n) => n.inactive);

  if (active.length < MIN_POPULATION_FOR_TIERS) {
    return [
      ...active.map(
        (n) => ({ note_id: n.note_id, tier: "hot" }) as TierResult,
      ),
      ...inactive.map(
        (n) => ({ note_id: n.note_id, tier: "cold" }) as TierResult,
      ),
    ];
  }

  const scored = computeDecayScores(active, currentTurn, nowMs)
    .slice()
    .sort((a, b) => b.decay_score - a.decay_score);

  const hotCutoff = Math.ceil(scored.length * HOT_PCT);
  const warmCutoff = Math.ceil(scored.length * WARM_PCT);

  const result: TierResult[] = [];
  scored.forEach((s, i) => {
    let tier: NoteTier;
    if (i < hotCutoff) tier = "hot";
    else if (i < warmCutoff) tier = "warm";
    else tier = "cold";
    result.push({ note_id: s.note_id, tier });
  });
  for (const n of inactive) {
    result.push({ note_id: n.note_id, tier: "cold" });
  }
  return result;
}
