/**
 * Task Token Display — formats tokens-per-task for session summary.
 *
 * T.12: Consumes intent-level grouping data and produces formatted display.
 * Shows top 3 most expensive tasks with entity lists and efficiency.
 */

import { calculateDollarSavings, formatDollars } from "./model-pricing.js";

export interface TaskCostSummary {
  taskDescription: string;
  toolCalls: number;
  tokensConsumed: number;
  tokensSaved: number;
  dollarCost: number;
  efficiency: number;
  entities: string[];
}

export interface TaskDisplayResult {
  tasks: TaskCostSummary[];
  totalCalls: number;
  totalSaved: number;
  totalWithout: number;
  formattedLines: string[];
}

/**
 * Build task cost summaries from intent group data.
 */
export function buildTaskCostSummaries(
  intentGroups: Array<{
    intentId: string;
    prompt?: string;
    toolCalls: number;
    tokensConsumed: number;
    tokensSaved: number;
    entitiesModified: string[];
    outcome: string;
  }>,
  modelId?: string
): TaskDisplayResult {
  const tasks: TaskCostSummary[] = intentGroups
    .filter((g) => g.toolCalls > 0)
    .map((g) => {
      const total = g.tokensConsumed + g.tokensSaved;
      const efficiency =
        total > 0 ? Math.round((g.tokensSaved / total) * 100) : 0;
      return {
        taskDescription: g.prompt ?? `Task ${g.intentId}`,
        toolCalls: g.toolCalls,
        tokensConsumed: g.tokensConsumed,
        tokensSaved: g.tokensSaved,
        dollarCost: calculateDollarSavings(g.tokensConsumed, modelId),
        efficiency,
        entities: g.entitiesModified,
      };
    })
    .sort((a, b) => b.tokensConsumed - a.tokensConsumed);

  const top3 = tasks.slice(0, 3);
  const totalCalls = tasks.reduce((s, t) => s + t.toolCalls, 0);
  const totalSaved = tasks.reduce((s, t) => s + t.tokensSaved, 0);
  const totalWithout = tasks.reduce(
    (s, t) => s + t.tokensConsumed + t.tokensSaved,
    0
  );

  const formattedLines = [
    "Tasks this session:",
    ...top3.map(
      (t, i) =>
        `  ${i + 1}. "${t.taskDescription.slice(0, 50)}" — ${t.toolCalls} calls, ${formatDollars(t.dollarCost)} (${t.efficiency}% optimized)`
    ),
    `  Total: ${totalCalls} calls, ${formatDollars(calculateDollarSavings(totalSaved, modelId))} saved (${formatDollars(calculateDollarSavings(totalWithout, modelId))} without unerr)`,
  ];

  return { tasks, totalCalls, totalSaved, totalWithout, formattedLines };
}
