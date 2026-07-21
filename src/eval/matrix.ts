/**
 * Ship-gate eval matrix — Sprint C eval phase, §18.7 (2).
 *
 * Iterates the 10-task × 2-config matrix and aggregates per-cell summaries
 * into a MatrixReport the eval CLI (and CI) can assert against.
 *
 * The repo dimension lives in each TaskDef's `repo` field ("self" |
 * "api" | "react"); we don't multiply by it externally so the report
 * shape stays a flat list of (task, config) cells.
 *
 * Ship-gate phase does NOT require B-config to be instructed (Sprint D
 * landing). It only confirms the matrix can be enumerated, runners
 * spawned, artifacts captured, and the §18.4 metrics extracted. Pass-bar
 * checks happen in D-eval.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CONFIGS } from "./configs.js";
import { type RunOptions, loadTask, runOne } from "./runner.js";
import type { RunSummary } from "./types.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(EVAL_DIR, "tasks");

export interface MatrixReport {
  total_cells: number;
  cells: RunSummary[];
}

/** Enumerate every task JSON in eval/tasks/. Order-stable by filename. */
export function listAllTaskIds(): string[] {
  return readdirSync(TASKS_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.replace(/\.json$/, ""))
    .sort();
}

export interface RunMatrixInput {
  task_ids?: readonly string[];
  config_ids?: readonly string[];
  run_options?: RunOptions;
}

/** Run the full matrix. Returns a MatrixReport with all cells. */
export async function runMatrix(
  input: RunMatrixInput = {}
): Promise<MatrixReport> {
  const tasks = input.task_ids ?? listAllTaskIds();
  const configs = input.config_ids ?? ALL_CONFIGS.map((c) => c.id);
  const cells: RunSummary[] = [];
  for (const taskId of tasks) {
    // Validate the task is loadable before running — surfaces fixture
    // bugs immediately instead of buried in runOne's error path.
    loadTask(taskId);
    for (const configId of configs) {
      const summary = await runOne(taskId, configId, input.run_options);
      cells.push(summary);
    }
  }
  return summarizeMatrix(cells);
}

/** Pure rollup from a flat list of run summaries. */
export function summarizeMatrix(cells: readonly RunSummary[]): MatrixReport {
  return {
    total_cells: cells.length,
    cells: [...cells],
  };
}

// CLI entrypoint: `tsx src/eval/matrix.ts [--task <id>...] [--config <id>...]`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMatrix().then(
    (report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    },
    (err: unknown) => {
      process.stderr.write(`eval-matrix error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  );
}
