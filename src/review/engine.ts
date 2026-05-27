/**
 * `ReviewEngine` — the single source of truth for review findings
 * (docs/reviewer-architecture.md §4). Mirrors `BehaviorDispatcher`
 * (`src/behaviors/framework.ts`): register pluggable units, dispatch them
 * uniformly, collect their output.
 *
 * `run(ctx)` dispatches every enabled checker, collects findings, applies §9
 * severity gating + dedup, and returns a `ReviewReport`. A checker that throws
 * is isolated — its error is recorded, the rest of the report still ships.
 * Findings are produced identically whether the caller is the in-flight hook,
 * the commit gate, or the on-demand command.
 */

import type { ReviewChecker } from "./checker.js";
import { gateFindings } from "./gating.js";
import type { ReviewContext, ReviewFinding, ReviewReport } from "./types.js";

export interface RunOptions {
  /**
   * Override the severity floor for this run (e.g. in-flight passes "medium",
   * the commit gate passes "high"). Defaults to `ctx.config.minSeverity`.
   */
  minSeverity?: ReviewContext["config"]["minSeverity"];
}

export class ReviewEngine {
  private readonly checkers: ReviewChecker[] = [];

  /** Register a checker. Duplicate ids are rejected to keep dedup keys stable. */
  register(checker: ReviewChecker): this {
    if (this.checkers.some((c) => c.id === checker.id)) {
      throw new Error(`ReviewEngine: duplicate checker id "${checker.id}"`);
    }
    this.checkers.push(checker);
    return this;
  }

  /** Register many checkers in one call. */
  registerAll(checkers: ReviewChecker[]): this {
    for (const c of checkers) this.register(c);
    return this;
  }

  getRegisteredCheckers(): ReadonlyArray<ReviewChecker> {
    return this.checkers;
  }

  /** A checker is enabled unless `ctx.config.checkers[id]` is explicitly `false` (opt-out). */
  private isEnabled(checker: ReviewChecker, ctx: ReviewContext): boolean {
    return ctx.config.checkers[checker.id] !== false;
  }

  /**
   * Dispatch all enabled checkers over `ctx`, gate + dedup, and return a report.
   * Per-checker errors are caught and recorded — one bad checker never aborts
   * the pass. Checkers run concurrently; the engine stays off the model hot path.
   */
  async run(ctx: ReviewContext, opts: RunOptions = {}): Promise<ReviewReport> {
    const startedAt = Date.now();
    const floor = opts.minSeverity ?? ctx.config.minSeverity;

    const enabled = this.checkers.filter((c) => this.isEnabled(c, ctx));
    const checkersRun: string[] = [];
    const checkersErrored: ReviewReport["checkersErrored"] = [];

    const settled = await Promise.all(
      enabled.map(async (checker): Promise<ReviewFinding[]> => {
        try {
          const findings = await checker.check(ctx);
          checkersRun.push(checker.id);
          return findings;
        } catch (err) {
          checkersErrored.push({
            checkerId: checker.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })
    );

    const raw = settled.flat();
    const { kept, suppressed } = gateFindings(raw, floor);

    return {
      findings: kept,
      suppressed,
      checkersRun,
      checkersErrored,
      durationMs: Date.now() - startedAt,
      clean: kept.length === 0,
    };
  }
}
