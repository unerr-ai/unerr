/**
 * Guard Moment Formatter — formats behavioral guard outputs with
 * counterfactual framing and token-savings gate enforcement.
 *
 * VS.4: Guard moments only fire when the token gate would be passed.
 * Format: "[unerr] ⚠ Prevented: {description}. Without unerr, ~{N} tokens..."
 */

import { frameGuardMoment } from "../utils/counterfactual.js";

export interface GuardMoment {
  id: string;
  description: string;
  tokensPrevented: number;
  entityKey?: string;
  timestamp: number;
  passed: boolean;
}

const TOKEN_GATE = 1_000;

/**
 * Evaluate whether a guard moment passes the token-savings threshold.
 */
export function shouldFireGuard(tokensPrevented: number): boolean {
  return tokensPrevented >= TOKEN_GATE;
}

/**
 * Format and emit a guard moment to stderr.
 * Only fires if the token gate is passed.
 */
export function formatGuardMoment(
  description: string,
  tokensPrevented: number,
  entityKey?: string
): GuardMoment | null {
  if (tokensPrevented < TOKEN_GATE) {
    return null;
  }

  const formatted = frameGuardMoment(description, tokensPrevented);
  process.stderr.write(`${formatted}\n`);

  return {
    id: `guard-${Date.now()}`,
    description,
    tokensPrevented,
    entityKey,
    timestamp: Date.now(),
    passed: true,
  };
}

/**
 * Get the current token gate threshold.
 */
export function getTokenGate(): number {
  return TOKEN_GATE;
}
