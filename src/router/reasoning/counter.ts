/**
 * Sprint P2-4: Prevented-wrong-call counter + retry-saved metric.
 *
 * Tracks two key metrics:
 *
 * 1. **Prevented wrong calls**: When the router soft-refuses a tool and
 *    the agent takes the suggested alternative → success = 1 prevented.
 *    This measures tools the agent WOULD have called incorrectly but
 *    the router redirected to the right tool.
 *
 * 2. **Retries saved**: Total tool retries this session vs baseline.
 *    Lower retries = the router is guiding the agent correctly.
 *
 * Both counters are pure accumulators — they only increment, never reset
 * within a session.
 */

import type { ToolCallTrace } from "./wrong-call-detector.js";

export interface PreventedCall {
  readonly refusedTool: string;
  readonly suggestedAlternative: string;
  readonly agentUsed: string;
  readonly wasSuccess: boolean;
  readonly turnNumber: number;
  readonly timestamp: number;
}

export interface CounterSnapshot {
  readonly preventedWrongCalls: number;
  readonly totalSoftRefuses: number;
  readonly alternativesTaken: number;
  readonly alternativesSucceeded: number;
  readonly retriesSaved: number;
  readonly totalRetries: number;
  readonly baselineRetries: number;
}

export class ReasoningCounter {
  private prevented: PreventedCall[] = [];
  private softRefuseCount = 0;
  private retryCount = 0;
  private baselineRetryCount = 0;
  private lastRefusedTool: string | null = null;
  private lastSuggestedAlt: string | null = null;
  private lastRefuseTurn = -1;

  /**
   * Record a soft-refuse event (tool was gated).
   */
  recordSoftRefuse(toolName: string, suggestedAlternative: string, turnNumber: number): void {
    this.softRefuseCount++;
    this.lastRefusedTool = toolName;
    this.lastSuggestedAlt = suggestedAlternative;
    this.lastRefuseTurn = turnNumber;
  }

  /**
   * Record the next tool call after a soft-refuse.
   * If the agent used the suggested alternative and it succeeded,
   * count it as a prevented wrong call.
   */
  recordFollowUp(toolName: string, success: boolean, turnNumber: number): void {
    if (
      this.lastRefusedTool !== null &&
      (turnNumber === this.lastRefuseTurn || turnNumber === this.lastRefuseTurn + 1)
    ) {
      const tookAlternative = toolName === this.lastSuggestedAlt;
      this.prevented.push({
        refusedTool: this.lastRefusedTool,
        suggestedAlternative: this.lastSuggestedAlt!,
        agentUsed: toolName,
        wasSuccess: success,
        turnNumber,
        timestamp: Date.now(),
      });

      this.lastRefusedTool = null;
      this.lastSuggestedAlt = null;
      this.lastRefuseTurn = -1;
    }
  }

  /**
   * Record a retry (same logical intent, different tool).
   */
  recordRetry(): void {
    this.retryCount++;
  }

  /**
   * Set the baseline retry count (from historical unrouted sessions).
   */
  setBaselineRetries(count: number): void {
    this.baselineRetryCount = count;
  }

  /**
   * Get the current counter snapshot.
   */
  getSnapshot(): CounterSnapshot {
    const alternativesTaken = this.prevented.filter(
      (p) => p.agentUsed === p.suggestedAlternative,
    ).length;
    const alternativesSucceeded = this.prevented.filter(
      (p) => p.agentUsed === p.suggestedAlternative && p.wasSuccess,
    ).length;

    return {
      preventedWrongCalls: alternativesSucceeded,
      totalSoftRefuses: this.softRefuseCount,
      alternativesTaken,
      alternativesSucceeded,
      retriesSaved: Math.max(0, this.baselineRetryCount - this.retryCount),
      totalRetries: this.retryCount,
      baselineRetries: this.baselineRetryCount,
    };
  }

  /**
   * Get all prevented call records (for telemetry/dashboard).
   */
  getPreventedCalls(): readonly PreventedCall[] {
    return this.prevented;
  }
}

/**
 * Count retries in a trace: a retry is when the next call has a different
 * tool name but the same family and happens within the same/next turn.
 */
export function countRetries(trace: readonly ToolCallTrace[]): number {
  let retries = 0;
  for (let i = 1; i < trace.length; i++) {
    const prev = trace[i - 1]!;
    const curr = trace[i]!;
    if (
      curr.family === prev.family &&
      curr.toolName !== prev.toolName &&
      (curr.turnNumber === prev.turnNumber || curr.turnNumber === prev.turnNumber + 1)
    ) {
      retries++;
    }
  }
  return retries;
}
