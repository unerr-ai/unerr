/**
 * The `ReviewChecker` contract (docs/reviewer-architecture.md §4.1).
 *
 * Sibling to the `Behavior` contract (`src/behaviors/framework.ts`): a checker
 * is a pluggable, individually toggleable unit that the `ReviewEngine`
 * dispatches uniformly. Tier-1 checkers are thin adapters over graph queries
 * that already exist (blast-radius, cascade-guard, evaluateRules, drift); the
 * engine unifies them rather than reinventing them.
 */

import type { ReviewContext, ReviewFinding, Severity } from "./types.js";

export interface ReviewChecker {
  /** Stable id — e.g. "breaking_callers", "duplicate_logic". Used by config + dedup. */
  readonly id: string;
  /** 1 = deterministic graph fact; 2 = needs host-model synthesis (evidence block). */
  readonly tier: 1 | 2;
  /** Severity assigned when this checker can't compute a more specific one. */
  readonly defaultSeverity: Severity;
  /**
   * Run the check over one change set. MUST be side-effect free and stay within
   * the <5ms Tier-1 budget (no model on the hot path). Return `[]` when clean.
   * Throwing is tolerated by the engine (isolated per checker) but discouraged —
   * prefer returning `[]` and degrading gracefully when inputs are absent.
   */
  check(ctx: ReviewContext): Promise<ReviewFinding[]>;
}

/**
 * Optional base for checkers that want config-driven enablement plumbed in.
 * Checkers may also implement `ReviewChecker` directly — this is convenience,
 * not a requirement (mirrors how behaviors extend the `Behavior` abstract but
 * the dispatcher only depends on the interface shape).
 */
export abstract class BaseChecker implements ReviewChecker {
  abstract readonly id: string;
  abstract readonly tier: 1 | 2;
  abstract readonly defaultSeverity: Severity;
  abstract check(ctx: ReviewContext): Promise<ReviewFinding[]>;
}
