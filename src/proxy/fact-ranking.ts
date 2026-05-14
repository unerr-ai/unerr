/**
 * Composite fact ranking — used by both recall_facts handlers (mcp-server.ts +
 * proxy.ts) so they stay in lock-step.
 *
 * Score = effective_confidence × (1 + log2(1 + reinforcements) × 0.3) × type_weight
 *
 * type_weight values codify "how anti-drift is this kind of fact":
 *   negative   1.5  (highest — anti-pattern, prevents future failure)
 *   convention 1.4  (project standard, must follow)
 *   semantic   1.2  (architecture / design context)
 *   procedural 1.0  (hot-file, modification pattern — useful but lower priority)
 *   episodic   0.8  (session history, lowest — interesting but rarely actionable)
 */

const TYPE_WEIGHT: Record<string, number> = {
  negative: 1.5,
  convention: 1.4,
  semantic: 1.2,
  procedural: 1.0,
  episodic: 0.8,
};

/**
 * Per-type rotation decay coefficient: how aggressively a fact's effective
 * rank drops with each show. Tuned so the *importance* gradient mirrors
 * TYPE_WEIGHT but inverted — anti-patterns must keep surfacing even after
 * being shown (low decay), episodic noise should age out quickly.
 *
 * effective_score = composite_score / (1 + shows × decay)
 */
const TYPE_DECAY: Record<string, number> = {
  negative: 0.3, // must-know — repeat slowly
  convention: 0.4,
  semantic: 0.5,
  procedural: 0.6,
  episodic: 0.8, // session history — fade fast
};

export function factTypeWeight(type: string): number {
  return TYPE_WEIGHT[type] ?? 1.0;
}

export function factTypeDecay(type: string): number {
  return TYPE_DECAY[type] ?? 0.5;
}

export interface RankableFact {
  fact_type: string;
  effective_confidence: number;
  reinforcement_count: number;
}

export function factScore(f: RankableFact): number {
  return (
    f.effective_confidence *
    (1 + Math.log2(1 + f.reinforcement_count) * 0.3) *
    factTypeWeight(f.fact_type)
  );
}

/** Sort facts by composite score descending (does not mutate input). */
export function rankFacts<T extends RankableFact>(facts: T[]): T[] {
  return [...facts].sort((a, b) => factScore(b) - factScore(a));
}

/**
 * Cross-channel dedup window: a fact surfaced via `ur|fct` (smuggle channel)
 * gets a temporary score penalty so explicit `recall_facts` calls right after
 * don't dominate top slots with the same fact.
 *
 * Penalty decays linearly from `RECENT_SHOW_PENALTY_MIN` (immediately after a
 * show) up to 1.0 at the edge of `RECENT_SHOW_WINDOW_MS`.
 */
export const RECENT_SHOW_WINDOW_MS = 5 * 60 * 1000;
export const RECENT_SHOW_PENALTY_MIN = 0.3;

/** Multiplier applied when a fact's subject is in the active-session
 * recency set (gives "current task" facts a gentle nudge above strangers). */
export const ACTIVE_SUBJECT_BOOST = 1.25;

export interface FactRotationOptions {
  /** Effective (decayed, cross-session) show count for a fact_id. */
  getShowCount?: (factId: string) => number;
  /** Last-shown timestamp (ms epoch) across all sessions; 0 = never. */
  getLastShownMs?: (factId: string) => number;
  /** Subjects recently touched in this session; their facts get a small boost. */
  recentSubjects?: Set<string> | null;
  /** Override for testing — defaults to Date.now(). */
  now?: number;
}

export interface RotatableFact extends RankableFact {
  fact_id: string;
  subject?: string;
}

/**
 * Rotation-, recency-, and subject-aware ranker for recall_facts.
 *
 * - Per-type decay: anti-patterns repeat slowly, episodic noise fades fast.
 * - Cross-channel dedup: facts smuggled in the last 5 min are penalized.
 * - Active-subject boost: facts about recently-touched entities outrank strangers.
 *
 * Backward compatible: with no options, behaves like rankFacts().
 */
export function rankFactsWithRotation<T extends RotatableFact>(
  facts: T[],
  opts: FactRotationOptions = {},
): T[] {
  const {
    getShowCount,
    getLastShownMs,
    recentSubjects,
    now = Date.now(),
  } = opts;
  if (!getShowCount && !getLastShownMs && !recentSubjects) {
    return rankFacts(facts);
  }

  const scored = facts.map((f) => {
    let score = factScore(f);
    if (getShowCount) {
      const shows = getShowCount(f.fact_id);
      const decay = factTypeDecay(f.fact_type);
      score = score / (1 + shows * decay);
    }
    if (getLastShownMs) {
      const last = getLastShownMs(f.fact_id);
      if (last > 0) {
        const age = now - last;
        if (age < RECENT_SHOW_WINDOW_MS) {
          // Linear: penalty=MIN immediately after, 1.0 at window edge.
          const t = Math.max(0, age) / RECENT_SHOW_WINDOW_MS;
          const factor =
            RECENT_SHOW_PENALTY_MIN + (1 - RECENT_SHOW_PENALTY_MIN) * t;
          score *= factor;
        }
      }
    }
    if (recentSubjects && f.subject && recentSubjects.has(f.subject)) {
      score *= ACTIVE_SUBJECT_BOOST;
    }
    return { fact: f, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ fact }) => fact);
}

/**
 * Slice the ranked list to `limit` while enforcing diversity quotas so a hot
 * file doesn't dominate the top-N with five same-type, same-subject facts.
 *
 *   - max 60% of slots same fact_type
 *   - max 2 slots per subject
 *
 * Two-pass: first fills slots that satisfy both quotas; second pass relaxes
 * quotas to fill any remaining gaps so we never under-return.
 */
export function applyDiversityQuota<T extends RotatableFact>(
  ranked: T[],
  limit: number,
  opts: { maxSameTypePct?: number; maxSameSubject?: number } = {},
): T[] {
  if (ranked.length <= limit) return [...ranked];
  const { maxSameTypePct = 0.6, maxSameSubject = 2 } = opts;
  const maxSameType = Math.max(1, Math.floor(limit * maxSameTypePct));

  const result: T[] = [];
  const skipped: T[] = [];
  const typeCounts = new Map<string, number>();
  const subjectCounts = new Map<string, number>();

  for (const f of ranked) {
    if (result.length >= limit) break;
    const tc = typeCounts.get(f.fact_type) ?? 0;
    const sc = f.subject ? (subjectCounts.get(f.subject) ?? 0) : 0;
    if (tc >= maxSameType || sc >= maxSameSubject) {
      skipped.push(f);
      continue;
    }
    result.push(f);
    typeCounts.set(f.fact_type, tc + 1);
    if (f.subject) subjectCounts.set(f.subject, sc + 1);
  }
  for (const f of skipped) {
    if (result.length >= limit) break;
    result.push(f);
  }
  return result;
}

/**
 * Default visible-cap for recall_facts.
 * Override via `args.limit` (max 25 to keep wire bounded).
 */
export const DEFAULT_FACT_LIMIT = 5;
export const MAX_FACT_LIMIT = 25;

export function resolveFactLimit(argsLimit: unknown): number {
  if (typeof argsLimit !== "number" || argsLimit <= 0)
    return DEFAULT_FACT_LIMIT;
  return Math.min(Math.floor(argsLimit), MAX_FACT_LIMIT);
}
