/**
 * Tool description token budget enforcement.
 *
 * The MCP Gateway (Layer 14) ships compressed tool descriptions on a strict
 * per-state budget. This module is the *only* authoritative source for budget
 * caps and for counting description tokens. Every other component that needs
 * to validate a description routes through here.
 *
 * Counts are BPE-accurate via `gpt-tokenizer` (cl100k_base), loaded lazily —
 * `gpt-tokenizer` is a heavy dependency that must not load on every `unerr`
 * invocation, only when a token count is actually needed. Call
 * `await warmTokenizer()` once (proxy startup, the CI gate in
 * scripts/check-tool-budget.ts, or a test's `beforeAll`) before any
 * synchronous `countTokens`/`enforceBudget`/`budgetHeadroom` call.
 */

/** Cached BPE encoder — populated by {@link warmTokenizer}, undefined until then. */
let _encode: ((text: string) => number[]) | undefined;

/**
 * Load and cache the real BPE encoder. Idempotent — safe to call repeatedly
 * or from multiple call sites; only the first call pays the `gpt-tokenizer`
 * import cost. Must resolve before any synchronous counting call below.
 */
export async function warmTokenizer(): Promise<void> {
  if (!_encode) {
    _encode = (await import("gpt-tokenizer")).encode;
  }
}

/**
 * Token caps per description-state.
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
 * Per-tool budget exceptions. A tool that legitimately carries more than its
 * tier's shared cap gets an explicit, documented entry here — never raise the
 * shared `BUDGETS` cap for everyone. `search_code` absorbed the `unerr_context`
 * recon composite (2026-06): its description teaches BOTH a bare-symbol lookup
 * AND a task-shaped recon bundle in one string, so its active cap is 100.
 */
export const PER_TOOL_BUDGET_OVERRIDE: Readonly<
  Record<string, Partial<Record<BudgetKey, number>>>
> = {
  search_code: { tier1Active: 100 },
};

/**
 * Effective cap for a tool+state: the per-tool override when present, else the
 * tier default. The single place that resolves a cap, so enforcement, headroom,
 * and the CI gate can never disagree.
 */
export function budgetCapFor(toolName: string, key: BudgetKey): number {
  return PER_TOOL_BUDGET_OVERRIDE[toolName]?.[key] ?? BUDGETS[key];
}

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
      `Tool "${toolName}" description exceeds ${budgetKey} budget: ${observed} > ${cap} tokens. Compress the description until it fits, or move the tool to a different tier.`
    );
    this.name = "ToolBudgetError";
  }
}

/**
 * BPE-accurate token count for a description string. Uses cl100k_base, which
 * is within ±5% of Claude's tokenizer across natural-language inputs of this
 * length. The CI gate and runtime validator must use this single function so
 * caps and observations are always computed identically.
 *
 * Throws if {@link warmTokenizer} has not resolved yet — a loud failure so a
 * stray un-warmed caller is caught immediately rather than silently miscounting.
 */
export function countTokens(text: string): number {
  if (!_encode) {
    throw new Error(
      "countTokens() called before warmTokenizer() resolved — await warmTokenizer() (or await validateAllToolDescriptions()) first."
    );
  }
  return _encode(text).length;
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
  const cap = budgetCapFor(toolName, key);
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
  key: BudgetKey,
  toolName?: string
): { observed: number; cap: number; headroom: number } {
  const observed = countTokens(description);
  const cap = toolName ? budgetCapFor(toolName, key) : BUDGETS[key];
  return { observed, cap, headroom: cap - observed };
}
