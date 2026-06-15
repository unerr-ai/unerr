/**
 * unerr cloud — FSRS spaced-recall scheduler.
 *
 * The anti-forgetting loop (C5) surfaces "3 weeks ago you chose X over Y —
 * still remember why?" prompts. This module decides WHICH locally-stored
 * decision records are due to be asked, and HOW the next interval moves once
 * the developer answers. It is a faithful subset of the open-source FSRS
 * (Free Spaced Repetition Scheduler) algorithm, the same memory model Anki
 * uses.
 *
 * Algorithm reference (grounded, not invented):
 *   open-spaced-repetition / fsrs4anki — "The Algorithm" wiki, FSRS-5.
 *   - DECAY = -0.5, FACTOR = 0.9^(1/DECAY) - 1 = 19/81.
 *   - Retrievability after t days at stability S:
 *       R(t,S) = (1 + FACTOR · t/S)^DECAY
 *   - Interval for a target retention r:
 *       I(r,S) = (S/FACTOR) · (r^(1/DECAY) - 1)
 *   - First-review stability is the per-grade weight w[grade].
 *   - A later review nudges stability up (remembered) or resets it toward a
 *     short floor (forgot). We model the binary y/n self-report the recall
 *     prompt collects, not the full 4-grade Anki scale, so we collapse the
 *     grades to two: "remembered" → a Good-grade stability bump, "forgot" →
 *     a lapse that drops stability to the post-lapse floor.
 *
 * Everything here is PURE: same inputs → same schedule. No clock is read
 * except the `now` the caller passes, so the scheduler is fully testable and
 * the daemon's "what's due" sweep is deterministic for a given local store.
 *
 * @sem domain=cloud role=schedule
 */

/** Decay exponent of the FSRS forgetting curve (FSRS-5 default). */
const DECAY = -0.5;
/**
 * Curve factor pinned so that R(S days, S) = 0.9 — i.e. one stability-unit of
 * elapsed time leaves 90% retrievability. `0.9^(1/DECAY) - 1` = `19/81`.
 */
const FACTOR = 19 / 81;
/** One day in milliseconds — the unit stability and intervals are measured in. */
const DAY_MS = 86_400_000;

/**
 * Default target retention: schedule the next prompt for when the developer's
 * recall of the decision has decayed to ~90%. Lower = ask sooner / more often.
 */
export const DEFAULT_TARGET_RETENTION = 0.9;

/**
 * First-review stability, in days, for each self-report. A freshly recorded
 * decision starts at the "remembered" stability — the developer just made the
 * choice, so it is fresh. The values mirror the FSRS-5 initial-stability
 * weights collapsed to the two grades the y/n recall prompt collects.
 */
export const INITIAL_STABILITY_REMEMBERED = 3.0;
export const INITIAL_STABILITY_FORGOT = 0.4;

/**
 * Post-lapse stability floor (days). When the developer says "no, I don't
 * remember why", stability drops to this short interval so the prompt comes
 * back soon rather than disappearing for weeks. Mirrors FSRS's lapse handling
 * (a forgotten card's stability collapses toward a small value).
 */
const POST_LAPSE_STABILITY = 0.5;

/**
 * Multiplier applied to stability on a successful "yes, I remember" answer.
 * FSRS grows stability by a factor that shrinks as stability itself grows; a
 * flat ~2.4× is a faithful, conservative approximation for the binary report
 * (it keeps intervals expanding without the full SInc weight vector). Bounded
 * so a long-remembered decision still resurfaces within a quarter.
 */
const REMEMBERED_STABILITY_GROWTH = 2.4;
/** Hard ceiling on stability so a decision never silently stops resurfacing. */
const MAX_STABILITY_DAYS = 120;

/**
 * The mutable scheduling state we persist per decision record. `stability` is
 * the FSRS memory-strength estimate (days); `due_at_ms` is when the next
 * recall prompt should appear; `last_review_ms` anchors the elapsed-time term.
 */
export interface RecallScheduleState {
  /** FSRS stability estimate, in days. Larger = remembered longer. */
  stability: number;
  /** Epoch ms when this decision is next due to be asked. */
  due_at_ms: number;
  /** Epoch ms of the last answer (or of record creation if never answered). */
  last_review_ms: number;
  /** Count of answers collected — drives "first review vs later review". */
  reviews: number;
}

/**
 * Retrievability of a memory `elapsedMs` after its last review, given its
 * stability. 1.0 right after review, decaying along the FSRS forgetting curve.
 * Pure; exported for tests and for ranking "most-forgotten first".
 *
 * @sem domain=cloud role=schedule
 */
export function retrievability(
  stabilityDays: number,
  elapsedMs: number
): number {
  if (stabilityDays <= 0) return 0;
  const elapsedDays = Math.max(0, elapsedMs) / DAY_MS;
  return (1 + (FACTOR * elapsedDays) / stabilityDays) ** DECAY;
}

/**
 * The next interval, in whole days, that lands retrievability on
 * `targetRetention` for a memory of the given stability. Inverts the FSRS
 * forgetting curve: `I = (S/FACTOR)·(r^(1/DECAY) - 1)`. Clamped to ≥1 day so a
 * just-answered decision never re-asks the same day.
 *
 * @sem domain=cloud role=schedule
 */
export function nextIntervalDays(
  stabilityDays: number,
  targetRetention: number = DEFAULT_TARGET_RETENTION
): number {
  const r = Math.min(0.999, Math.max(0.5, targetRetention));
  const interval = (stabilityDays / FACTOR) * (r ** (1 / DECAY) - 1);
  return Math.max(1, Math.round(interval));
}

/**
 * The schedule for a brand-new decision record at `createdAtMs`. The decision
 * was just made, so it starts "remembered"; the first recall prompt is set one
 * interval out. No answer has been collected yet (`reviews: 0`).
 *
 * @sem domain=cloud role=schedule
 */
export function initialSchedule(
  createdAtMs: number,
  targetRetention: number = DEFAULT_TARGET_RETENTION
): RecallScheduleState {
  const stability = INITIAL_STABILITY_REMEMBERED;
  const intervalDays = nextIntervalDays(stability, targetRetention);
  return {
    stability,
    last_review_ms: createdAtMs,
    due_at_ms: createdAtMs + intervalDays * DAY_MS,
    reviews: 0,
  };
}

/**
 * Advance the schedule after the developer answers a recall prompt.
 * `remembered` is the y/n self-report. On "yes" stability grows (longer until
 * the next ask); on "no" it lapses to a short floor (asked again soon). The
 * new `due_at_ms` is `answeredAtMs` plus the recomputed interval.
 *
 * @sem domain=cloud role=schedule
 */
export function reviewSchedule(
  prev: RecallScheduleState,
  remembered: boolean,
  answeredAtMs: number,
  targetRetention: number = DEFAULT_TARGET_RETENTION
): RecallScheduleState {
  let stability: number;
  if (remembered) {
    // First answer uses the per-grade initial stability; later answers grow
    // the prior stability multiplicatively (bounded).
    const base =
      prev.reviews === 0 ? INITIAL_STABILITY_REMEMBERED : prev.stability;
    stability = Math.min(
      MAX_STABILITY_DAYS,
      base * REMEMBERED_STABILITY_GROWTH
    );
  } else {
    stability = POST_LAPSE_STABILITY;
  }
  const intervalDays = nextIntervalDays(stability, targetRetention);
  return {
    stability,
    last_review_ms: answeredAtMs,
    due_at_ms: answeredAtMs + intervalDays * DAY_MS,
    reviews: prev.reviews + 1,
  };
}

/**
 * Whether a decision is due to be asked at `nowMs` (its `due_at_ms` has
 * passed). The daemon's recall sweep calls this to pick the surfaced prompts.
 *
 * @sem domain=cloud role=schedule
 */
export function isDue(state: RecallScheduleState, nowMs: number): boolean {
  return nowMs >= state.due_at_ms;
}

/**
 * Order due states most-forgotten-first: the lowest current retrievability
 * comes first, so the prompt the developer is likeliest to have lost surfaces
 * before fresher ones. Ties break on the older `due_at_ms`. Pure — sorts a
 * copy, leaving the input array untouched.
 *
 * @sem domain=cloud role=schedule
 */
export function orderByForgetting<T extends { schedule: RecallScheduleState }>(
  items: readonly T[],
  nowMs: number
): T[] {
  return [...items].sort((a, b) => {
    const ra = retrievability(
      a.schedule.stability,
      nowMs - a.schedule.last_review_ms
    );
    const rb = retrievability(
      b.schedule.stability,
      nowMs - b.schedule.last_review_ms
    );
    if (ra !== rb) return ra - rb;
    return a.schedule.due_at_ms - b.schedule.due_at_ms;
  });
}
