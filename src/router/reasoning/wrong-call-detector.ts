/**
 * Sprint P2-4: Wrong-call detector.
 *
 * Heuristic detection of "wrong" tool calls — instances where the agent
 * selected the wrong tool and had to retry with a different one.
 *
 * Detection signals:
 *   1. Tool returns "no results" / empty response + agent immediately
 *      retries with a DIFFERENT tool within the same turn → first call wrong.
 *   2. Tool returns an error + agent retries different tool → first call wrong.
 *   3. Sequential calls to the same family with different tools suggest
 *      trial-and-error (weaker signal).
 *
 * This is purely observational — it reads the call trace and flags
 * patterns. No side effects, no mutations.
 */

export interface ToolCallTrace {
  readonly toolName: string;
  readonly family: string;
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly outcome: "success" | "empty" | "error" | "soft_refused";
  readonly responseTokens: number;
}

export interface WrongCallDetection {
  readonly wrongCall: ToolCallTrace;
  readonly correction: ToolCallTrace;
  readonly heuristic:
    | "empty_then_retry"
    | "error_then_retry"
    | "same_family_switch";
  readonly confidence: number;
}

export interface DetectionResult {
  readonly wrongCalls: readonly WrongCallDetection[];
  readonly totalCalls: number;
  readonly wrongCallRate: number;
}

/**
 * Detect wrong tool calls from a session trace.
 * Scans for retry patterns within the same turn or consecutive turns.
 */
export function detectWrongCalls(
  trace: readonly ToolCallTrace[]
): DetectionResult {
  if (trace.length < 2) {
    return { wrongCalls: [], totalCalls: trace.length, wrongCallRate: 0 };
  }

  const detections: WrongCallDetection[] = [];

  for (let i = 0; i < trace.length - 1; i++) {
    const current = trace[i]!;
    const next = trace[i + 1]!;

    const sameTurn = next.turnNumber === current.turnNumber;
    const consecutiveTurn = next.turnNumber === current.turnNumber + 1;
    const differentTool = next.toolName !== current.toolName;
    const quickRetry = next.timestamp - current.timestamp < 10_000;

    if (!differentTool) continue;
    if (!sameTurn && !consecutiveTurn) continue;

    if (current.outcome === "empty" && (sameTurn || quickRetry)) {
      detections.push({
        wrongCall: current,
        correction: next,
        heuristic: "empty_then_retry",
        confidence: 0.85,
      });
    } else if (current.outcome === "error" && (sameTurn || quickRetry)) {
      detections.push({
        wrongCall: current,
        correction: next,
        heuristic: "error_then_retry",
        confidence: 0.9,
      });
    } else if (
      current.family === next.family &&
      current.outcome === "success" &&
      current.responseTokens < 50 &&
      (sameTurn || quickRetry)
    ) {
      detections.push({
        wrongCall: current,
        correction: next,
        heuristic: "same_family_switch",
        confidence: 0.6,
      });
    }
  }

  const wrongCallRate = trace.length > 0 ? detections.length / trace.length : 0;

  return {
    wrongCalls: detections,
    totalCalls: trace.length,
    wrongCallRate,
  };
}

/**
 * Compute selection accuracy from a trace.
 * Accuracy = 1 - wrongCallRate (based on detected wrong calls).
 */
export function computeSelectionAccuracy(
  trace: readonly ToolCallTrace[]
): number {
  const result = detectWrongCalls(trace);
  return 1 - result.wrongCallRate;
}
