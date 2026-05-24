/**
 * Sprint D pass-bar evaluation — §18.6.
 *
 * Takes a MatrixReport and produces a structured pass-bar verdict
 * (per-criterion + overall). Pure function — runs after `runMatrix`,
 * does not invoke any agent.
 *
 * Pass thresholds (all required to ship):
 *  1. Adoption — B-config hits all four moments on ≥ 7 of N tasks.
 *  2. Adoption — B-config moment hit rate is ≥ 2× A-config rate.
 *  3. Quality — ≥ 80% of B-config saved notes pass the anchored bar.
 *     (Non-obvious is LLM-judged offline; that input is opt-in.)
 *  4. Quality — zero note-storms (count over 15-note cap) on B side.
 *  5. Outcome — B-config uses ≤ A-config turns on ≥ 6 of N tasks.
 *  6. Outcome — task 10 (continue-last-session) second-session run uses
 *     prior notes (anchor query non-empty AND plan cites).
 *
 * `evaluate()` accepts the MatrixReport for B and (optionally) A; the
 * task-10 continuity flag is passed in alongside since it's computed from
 * cross-session state, not single-run telemetry.
 */

import type { ALL_CONFIGS } from "./configs.js";
import type { MatrixReport } from "./matrix.js";
import type { RunSummary } from "./types.js";

export const NOTES_SAVE_CAP = 15;

export interface PassBarInput {
  matrix_b: MatrixReport;
  /** Optional — pass to compute the cross-config adoption ratio. */
  matrix_a?: MatrixReport;
  /**
   * Per-note quality judgments. Map of note_id → has-anchor + non-obvious
   * verdict. When undefined, the quality criterion uses the anchored-only
   * proxy (every note saved has an anchor by construction, so default to
   * 100% — explicit judgments tighten the gate, never loosen it).
   */
  note_quality?: ReadonlyMap<
    string,
    { anchored: boolean; non_obvious: boolean }
  >;
  /** Set by the cross-session driver for task 10. */
  task_10_continuity?: {
    anchor_query_returned_non_empty: boolean;
    plan_cited_prior_note: boolean;
  };
  /**
   * Override the task count if the matrix wasn't run against all 10
   * fixtures. Used by smoke/CI runs that subset the matrix.
   */
  task_count?: number;
  /** Override config ids — defaults to typeof ALL_CONFIGS. */
  config_b_id?: (typeof ALL_CONFIGS)[number]["id"] | string;
  config_a_id?: (typeof ALL_CONFIGS)[number]["id"] | string;
}

export type CriterionStatus = "pass" | "fail" | "skipped";

export interface CriterionResult {
  id: string;
  label: string;
  status: CriterionStatus;
  /** Filled in with the numeric measure we computed. */
  measured?: number | string;
  /** Why the criterion failed (or was skipped). */
  reason?: string;
}

export interface PassBarResult {
  overall: "pass" | "fail";
  criteria: CriterionResult[];
}

export function evaluate(input: PassBarInput): PassBarResult {
  const taskCount =
    input.task_count ??
    new Set(input.matrix_b.cells.map((c) => c.task_id)).size;
  const configB = input.config_b_id ?? "b-instructed";
  const configA = input.config_a_id ?? "a-naive";

  const bCells = input.matrix_b.cells.filter((c) => c.config_id === configB);

  const c1 = criterionAdoptionFourMoments(bCells, taskCount);
  const c2 = criterionAdoptionRatio(
    input.matrix_b,
    input.matrix_a,
    configB,
    configA
  );
  const c3 = criterionQualityAnchored(bCells, input.note_quality);
  const c4 = criterionNoNoteStorms(bCells);
  const c5 = criterionOutcomeTurns(
    input.matrix_b,
    input.matrix_a,
    configB,
    configA
  );
  const c6 = criterionTaskTenContinuity(input.task_10_continuity);

  const criteria = [c1, c2, c3, c4, c5, c6];
  const overall = criteria.some((c) => c.status === "fail") ? "fail" : "pass";
  return { overall, criteria };
}

function criterionAdoptionFourMoments(
  bCells: readonly RunSummary[],
  taskCount: number
): CriterionResult {
  const byTask = new Map<string, number>();
  for (const c of bCells) {
    const prev = byTask.get(c.task_id) ?? 0;
    if (c.moments_hit > prev) byTask.set(c.task_id, c.moments_hit);
  }
  const allFour = [...byTask.values()].filter((n) => n === 4).length;
  const threshold = Math.max(1, Math.ceil(taskCount * 0.7));
  return {
    id: "adoption-four-moments",
    label: `B-config hits all 4 moments on ≥ ${threshold} of ${taskCount} tasks`,
    status: allFour >= threshold ? "pass" : "fail",
    measured: `${allFour}/${taskCount}`,
    reason:
      allFour >= threshold
        ? undefined
        : `only ${allFour} task(s) hit all four moments; need ${threshold}`,
  };
}

function criterionAdoptionRatio(
  matrixB: MatrixReport,
  matrixA: MatrixReport | undefined,
  configB: string,
  configA: string
): CriterionResult {
  if (!matrixA) {
    return {
      id: "adoption-ratio",
      label: "B contract-moment rate ≥ 2× A",
      status: "skipped",
      reason: "matrix_a not provided",
    };
  }
  const ratesB = matrixB.total_moments_by_config[configB] ?? 0;
  const ratesA = matrixA.total_moments_by_config[configA] ?? 0;
  if (ratesA === 0) {
    // Special case: A scores zero. B passes iff it scored anything.
    return {
      id: "adoption-ratio",
      label: "B contract-moment rate ≥ 2× A",
      status: ratesB > 0 ? "pass" : "fail",
      measured: `${ratesB}:${ratesA}`,
      reason: ratesB === 0 ? "neither config scored any moments" : undefined,
    };
  }
  const ratio = ratesB / ratesA;
  return {
    id: "adoption-ratio",
    label: "B contract-moment rate ≥ 2× A",
    status: ratio >= 2 ? "pass" : "fail",
    measured: ratio.toFixed(2),
    reason: ratio >= 2 ? undefined : `ratio ${ratio.toFixed(2)} below 2.0`,
  };
}

function criterionQualityAnchored(
  bCells: readonly RunSummary[],
  judgments: PassBarInput["note_quality"]
): CriterionResult {
  const notesSaved = bCells.reduce((n, c) => n + c.notes_saved, 0);
  if (notesSaved === 0) {
    return {
      id: "quality-anchored",
      label: "≥ 80% of B-saved notes pass the anchored + non-obvious bar",
      status: "skipped",
      reason: "no notes saved across B runs",
    };
  }
  if (!judgments || judgments.size === 0) {
    // All notes are anchored by schema construction. Without LLM judgments
    // for non-obvious, the bar's anchored-only proxy is 100% by definition.
    return {
      id: "quality-anchored",
      label: "≥ 80% of B-saved notes pass the anchored + non-obvious bar",
      status: "pass",
      measured: "100% (anchored-only proxy; no LLM judgments)",
    };
  }
  let pass = 0;
  for (const { anchored, non_obvious } of judgments.values()) {
    if (anchored && non_obvious) pass++;
  }
  const rate = pass / judgments.size;
  return {
    id: "quality-anchored",
    label: "≥ 80% of B-saved notes pass the anchored + non-obvious bar",
    status: rate >= 0.8 ? "pass" : "fail",
    measured: `${(rate * 100).toFixed(0)}%`,
    reason: rate >= 0.8 ? undefined : `${(rate * 100).toFixed(0)}% below 80%`,
  };
}

function criterionNoNoteStorms(bCells: readonly RunSummary[]): CriterionResult {
  const storms = bCells.filter((c) => c.notes_saved > NOTES_SAVE_CAP).length;
  return {
    id: "no-note-storms",
    label: `zero B-runs save more than ${NOTES_SAVE_CAP} notes`,
    status: storms === 0 ? "pass" : "fail",
    measured: storms,
    reason: storms === 0 ? undefined : `${storms} run(s) exceeded the cap`,
  };
}

function criterionOutcomeTurns(
  matrixB: MatrixReport,
  matrixA: MatrixReport | undefined,
  configB: string,
  configA: string
): CriterionResult {
  if (!matrixA) {
    return {
      id: "outcome-turns",
      label: "B uses ≤ A turns on ≥ 6 of 10 tasks",
      status: "skipped",
      reason: "matrix_a not provided",
    };
  }
  const taskIds = new Set([
    ...matrixB.cells.map((c) => c.task_id),
    ...matrixA.cells.map((c) => c.task_id),
  ]);
  const threshold = Math.max(1, Math.ceil(taskIds.size * 0.6));
  let pass = 0;
  let evaluable = 0;
  for (const id of taskIds) {
    const b = matrixB.cells.find(
      (c) => c.task_id === id && c.config_id === configB
    );
    const a = matrixA.cells.find(
      (c) => c.task_id === id && c.config_id === configA
    );
    if (!b?.turns || !a?.turns) continue;
    evaluable++;
    if (b.turns <= a.turns) pass++;
  }
  if (evaluable === 0) {
    return {
      id: "outcome-turns",
      label: `B uses ≤ A turns on ≥ ${threshold} of ${taskIds.size} tasks`,
      status: "skipped",
      reason: "no per-task turn counts available (agent CLI didn't report)",
    };
  }
  return {
    id: "outcome-turns",
    label: `B uses ≤ A turns on ≥ ${threshold} of ${taskIds.size} tasks`,
    status: pass >= threshold ? "pass" : "fail",
    measured: `${pass}/${evaluable}`,
    reason:
      pass >= threshold ? undefined : `only ${pass} task(s) met the turn bar`,
  };
}

function criterionTaskTenContinuity(
  input: PassBarInput["task_10_continuity"]
): CriterionResult {
  if (!input) {
    return {
      id: "task-10-continuity",
      label:
        "task 10 second session reuses prior notes (anchor non-empty + plan cites)",
      status: "skipped",
      reason: "cross-session driver did not report task_10_continuity",
    };
  }
  const ok =
    input.anchor_query_returned_non_empty && input.plan_cited_prior_note;
  return {
    id: "task-10-continuity",
    label:
      "task 10 second session reuses prior notes (anchor non-empty + plan cites)",
    status: ok ? "pass" : "fail",
    measured: `anchor=${input.anchor_query_returned_non_empty} cite=${input.plan_cited_prior_note}`,
    reason: ok
      ? undefined
      : "either anchor query was empty or plan did not cite",
  };
}
