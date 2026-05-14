/**
 * Model Pricing Table + Dollar Savings Calculator.
 *
 * T.2: Per-model input/output token pricing (USD per million tokens).
 * T.3: Dollar savings = tokens_saved × input_rate (we save on agent input).
 *
 * All pricing is input-side (tokens we prevent the agent from consuming).
 */

export interface ModelRate {
  id: string;
  name: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_RATES: ModelRate[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    inputPerMillion: 15,
    outputPerMillion: 75,
  },
  {
    id: "claude-haiku-4-20250506",
    name: "Claude Haiku 4",
    inputPerMillion: 0.8,
    outputPerMillion: 4,
  },
  { id: "gpt-4o", name: "GPT-4o", inputPerMillion: 2.5, outputPerMillion: 10 },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
  },
  {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    inputPerMillion: 1.25,
    outputPerMillion: 5,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
];

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Get the pricing rate for a model. Returns default (Sonnet) for unknown models.
 */
export function getModelRate(modelId?: string): ModelRate {
  const id = modelId ?? DEFAULT_MODEL;
  return MODEL_RATES.find((m) => m.id === id) ?? MODEL_RATES[0]!;
}

/**
 * Calculate dollar savings from tokens saved.
 * Savings are on input tokens (what the agent would have consumed).
 */
export function calculateDollarSavings(
  tokensSaved: number,
  modelId?: string,
): number {
  const rate = getModelRate(modelId);
  return (tokensSaved * rate.inputPerMillion) / 1_000_000;
}

/**
 * Format dollar amount for display.
 */
export function formatDollars(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  if (amount >= 0.001) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

/**
 * Format a complete savings summary string.
 */
export function formatSavingsSummary(
  tokensSaved: number,
  modelId?: string,
): string {
  const dollars = calculateDollarSavings(tokensSaved, modelId);
  const rate = getModelRate(modelId);
  const tokensStr =
    tokensSaved >= 1000
      ? `${(tokensSaved / 1000).toFixed(1)}K`
      : String(tokensSaved);
  return `${tokensStr} tokens saved (${formatDollars(dollars)} at ${rate.name} rates)`;
}

/**
 * Get all supported models.
 */
export function getAllModelRates(): ModelRate[] {
  return [...MODEL_RATES];
}
