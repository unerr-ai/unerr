/**
 * Topic-shift detection — Sprint C item 6, §11.6.
 *
 * `unerr_recall_for_prompt` returns `topic_shift: boolean`. Heuristic:
 * the agent's current prompt's likely anchors vs the last N=10 turns'
 * anchors. If Jaccard overlap < THRESHOLD, the user (or sub-task) has
 * pivoted — Surface 2 preface renders a topic-shift line.
 *
 * Pure module. The session-history table is read elsewhere; this just
 * does the math on the two anchor sets.
 *
 * Anchor representation is wire-format ("f:src/a.ts", "p:") — same
 * shape used by the recall handlers in notes-store.
 */

export const TOPIC_SHIFT_DEFAULT_WINDOW = 10;
export const TOPIC_SHIFT_DEFAULT_THRESHOLD = 0.2;

export interface TopicShiftInput {
  /** Anchors the current prompt likely touches. */
  current_anchors: readonly string[];
  /** Anchors seen over the recent window of turns, most recent last. */
  recent_anchors_by_turn: readonly (readonly string[])[];
  /** How many trailing turns count as "recent". Default 10. */
  window?: number;
  /** Jaccard overlap below which we flag a shift. Default 0.2. */
  threshold?: number;
}

export interface TopicShiftResult {
  /** True when overlap is below threshold AND a recent history exists. */
  topic_shift: boolean;
  /** Jaccard overlap between current and recent. 0 when either side is empty. */
  overlap: number;
  /** Why the flag fired (or didn't). For surface rendering & telemetry. */
  reason:
    | "no_recent_history"
    | "no_current_anchors"
    | "overlap_above_threshold"
    | "shift_below_threshold";
}

/** Compute Jaccard overlap between two anchor sets. 0 when either is empty. */
export function jaccardOverlap(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * Detect topic shift. Returns the boolean flag + the overlap value so
 * callers can render telemetry without recomputing.
 */
export function detectTopicShift(input: TopicShiftInput): TopicShiftResult {
  const window = input.window ?? TOPIC_SHIFT_DEFAULT_WINDOW;
  const threshold = input.threshold ?? TOPIC_SHIFT_DEFAULT_THRESHOLD;

  if (input.current_anchors.length === 0) {
    return {
      topic_shift: false,
      overlap: 0,
      reason: "no_current_anchors",
    };
  }
  const trailing = input.recent_anchors_by_turn.slice(-window);
  const recentFlat = trailing.flat();
  if (recentFlat.length === 0) {
    return {
      topic_shift: false,
      overlap: 0,
      reason: "no_recent_history",
    };
  }
  const overlap = jaccardOverlap(input.current_anchors, recentFlat);
  if (overlap < threshold) {
    return {
      topic_shift: true,
      overlap,
      reason: "shift_below_threshold",
    };
  }
  return {
    topic_shift: false,
    overlap,
    reason: "overlap_above_threshold",
  };
}
