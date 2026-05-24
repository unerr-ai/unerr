/**
 * Tool description token budget enforcement.
 *
 * The MCP Gateway (Layer 14) ships compressed tool descriptions on a strict
 * per-state budget. This module is the *only* authoritative source for budget
 * caps and for counting description tokens. Every other component that needs
 * to validate a description routes through here.
 *
 * Counts are BPE-accurate via `gpt-tokenizer` (cl100k_base). The same library
 * is used at CI gate time (scripts/check-tool-budget.ts) and at runtime when
 * the description provider is asked for a state that has not been validated.
 */

import { encode } from "gpt-tokenizer";

/**
 * Token caps per description-state. Values match the gateway design in
 * docs/open-cli/architecture/MCP_GATEWAY_ROUTER_PROXY.md §7.
 *
 *   tier1Active        — Tier 1 tool advertised in tools/list with full description.
 *   locked             — Placeholder for tier 2/3 tool advertised on clients that
 *                        cannot honor tools/list_changed; includes unlock hint.
 *   unlockedExtended   — Tier 2/3 tool after unlock; richer than locked, leaner
 *                        than the historical verbose format.
 */
export const BUDGETS = {
  tier1Active: 80,
  locked: 30,
  unlockedExtended: 60,
} as const;

export type BudgetKey = keyof typeof BUDGETS;

/**
 * Thrown when a description exceeds its budget. Carries enough structured
 * data for the CI gate to format a precise actionable error.
 */
export class ToolBudgetError extends Error {
  constructor(
    readonly toolName: string,
    readonly budgetKey: BudgetKey,
    readonly observed: number,
    readonly cap: number
  ) {
    super(
      `Tool "${toolName}" description exceeds ${budgetKey} budget: ${observed} > ${cap} tokens. ` +
        `Compress the description until it fits, or move the tool to a different tier.`
    );
    this.name = "ToolBudgetError";
  }
}

/**
 * BPE-accurate token count for a description string. Uses cl100k_base, which
 * is within ±5% of Claude's tokenizer across natural-language inputs of this
 * length. The CI gate and runtime validator must use this single function so
 * caps and observations are always computed identically.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Validate a description string against its budget. Throws `ToolBudgetError`
 * on overrun; returns void on pass. Pure and side-effect-free; safe to call
 * during module initialization.
 */
export function enforceBudget(
  toolName: string,
  description: string,
  key: BudgetKey
): void {
  const observed = countTokens(description);
  const cap = BUDGETS[key];
  if (observed > cap) {
    throw new ToolBudgetError(toolName, key, observed, cap);
  }
}

/**
 * Report the budget headroom for a description string. Positive value means
 * the description fits with N tokens to spare; negative means it overruns by
 * |N| tokens. Used by the CI gate to print a compact per-tool table.
 */
export function budgetHeadroom(
  description: string,
  key: BudgetKey
): { observed: number; cap: number; headroom: number } {
  const observed = countTokens(description);
  const cap = BUDGETS[key];
  return { observed, cap, headroom: cap - observed };
}
