/**
 * Guard Moment Formatter — formats behavioral guard outputs with
 * counterfactual framing and $0.50 gate enforcement.
 *
 * VS.4: Guard moments only fire when >$0.50 would be saved.
 * Format: "[unerr] ⚠ Prevented: {description}. Est. cost: ${amount}"
 */

import { calculateDollarSavings } from "../proxy/model-pricing.js";
import { frameGuardMoment } from "../utils/counterfactual.js";

export interface GuardMoment {
  id: string;
  description: string;
  tokensPrevented: number;
  dollarsPrevented: number;
  entityKey?: string;
  timestamp: number;
  passed: boolean;
}

const DOLLAR_GATE = 0.5;

/**
 * Evaluate whether a guard moment passes the $0.50 threshold.
 */
export function shouldFireGuard(
  tokensPrevented: number,
  modelId?: string
): boolean {
  const dollars = calculateDollarSavings(tokensPrevented, modelId);
  return dollars >= DOLLAR_GATE;
}

/**
 * Format and emit a guard moment to stderr.
 * Only fires if the $0.50 gate is passed.
 */
export function formatGuardMoment(
  description: string,
  tokensPrevented: number,
  modelId?: string,
  entityKey?: string
): GuardMoment | null {
  const dollars = calculateDollarSavings(tokensPrevented, modelId);

  if (dollars < DOLLAR_GATE) {
    return null;
  }

  const formatted = frameGuardMoment(description, dollars);
  process.stderr.write(`${formatted}\n`);

  return {
    id: `guard-${Date.now()}`,
    description,
    tokensPrevented,
    dollarsPrevented: dollars,
    entityKey,
    timestamp: Date.now(),
    passed: true,
  };
}

/**
 * Get the current dollar gate threshold.
 */
export function getDollarGate(): number {
  return DOLLAR_GATE;
}
