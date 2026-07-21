/**
 * Ship-gate pass-bar evaluation — §18.6.
 *
 * Takes a MatrixReport and produces a structured pass-bar verdict
 * (per-criterion + overall). Pure function — runs after `runMatrix`,
 * does not invoke any agent.
 *
 * Pass threshold (required to ship):
 *  1. Outcome — B-config uses ≤ A-config turns on ≥ 6 of N tasks.
 *
 * `evaluate()` accepts the MatrixReport for B and (optionally) A.
 */

import type { ALL_CONFIGS } from "./configs.js";
import type { MatrixReport } from "./matrix.js";

export interface PassBarInput {
  matrix_b: MatrixReport;
  /** Optional — pass to compute the cross-config turn comparison. */
  matrix_a?: MatrixReport;
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
  const configB = input.config_b_id ?? "b-instructed";
  const configA = input.config_a_id ?? "a-naive";

  const outcomeTurns = criterionOutcomeTurns(
    input.matrix_b,
    input.matrix_a,
    configB,
    configA
  );

  const criteria = [outcomeTurns];
  const overall = criteria.some((c) => c.status === "fail") ? "fail" : "pass";
  return { overall, criteria };
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
