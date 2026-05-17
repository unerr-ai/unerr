/**
 * Sprint P2-5: Association detector.
 *
 * Scans a session trace for temporal patterns where a signal
 * (ur|<tag>, entity reference, file access, family nudge) precedes
 * a tool call within a configurable turn window.
 *
 * Detection logic:
 *   - Signal emitted at turn T
 *   - Tool call at turn T+N (N ≤ MAX_GAP_TURNS)
 *   - Tool call family matches the signal's family context
 *   - Gap time ≤ MAX_GAP_MS (prevents stale associations)
 *
 * The detector is pure — it takes a trace and returns detections.
 * No side effects, no persistence.
 */

import type {
  AssociationRecord,
  TriggerSignal,
  SubsequentCall,
  OutcomeQuality,
} from "./types.js";
import { scoreOutcomeQuality } from "./quality.js";

const MAX_GAP_TURNS = 3;
const MAX_GAP_MS = 30_000;

let idCounter = 0;

function generateId(): string {
  return `assoc_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export interface DetectorInput {
  readonly sessionId: string;
  readonly signals: readonly TriggerSignal[];
  readonly calls: readonly SubsequentCall[];
  readonly editAfterCalls?: ReadonlySet<number>;
}

/**
 * Detect associations between signals and subsequent tool calls.
 *
 * For each signal, finds the first matching tool call within the
 * turn window. A match requires:
 *   1. Call happens AFTER the signal (turnNumber > signal.turnNumber)
 *   2. Turn gap ≤ MAX_GAP_TURNS
 *   3. Time gap ≤ MAX_GAP_MS
 *   4. Family match (if signal has family context)
 */
export function detectAssociations(input: DetectorInput): readonly AssociationRecord[] {
  const { sessionId, signals, calls, editAfterCalls } = input;
  const associations: AssociationRecord[] = [];
  const usedCalls = new Set<number>();

  for (const signal of signals) {
    for (let i = 0; i < calls.length; i++) {
      if (usedCalls.has(i)) continue;

      const call = calls[i]!;
      const turnGap = call.turnNumber - signal.turnNumber;
      const timeGap = call.timestamp - signal.timestamp;

      if (turnGap <= 0) continue;
      if (turnGap > MAX_GAP_TURNS) continue;
      if (timeGap > MAX_GAP_MS) continue;
      if (timeGap < 0) continue;

      if (signal.family && signal.family !== call.family) continue;

      const hasEditAfter = editAfterCalls?.has(i) ?? false;
      const quality = scoreOutcomeQuality(call, hasEditAfter);

      associations.push({
        id: generateId(),
        ts: new Date(call.timestamp).toISOString(),
        sessionId,
        triggerSignal: signal,
        subsequentCall: call,
        gapTurns: turnGap,
        gapMs: timeGap,
        outcomeQuality: quality,
      });

      usedCalls.add(i);
      break;
    }
  }

  return associations;
}

/**
 * Extract trigger signals from a stream of ur|<tag> events.
 * Maps each tag event to a TriggerSignal with type classification.
 */
export function extractSignalsFromUrTags(
  tags: readonly { tag: string; turnNumber: number; timestamp: number; entityName?: string; filePath?: string; family?: string }[],
): readonly TriggerSignal[] {
  return tags.map((t) => ({
    type: "ur_tag" as const,
    tag: t.tag,
    entityName: t.entityName,
    filePath: t.filePath,
    family: t.family,
    turnNumber: t.turnNumber,
    timestamp: t.timestamp,
  }));
}

/**
 * Extract trigger signals from family nudge emissions.
 */
export function extractSignalsFromNudges(
  nudges: readonly { family: string; turnNumber: number; timestamp: number }[],
): readonly TriggerSignal[] {
  return nudges.map((n) => ({
    type: "family_nudge" as const,
    family: n.family,
    turnNumber: n.turnNumber,
    timestamp: n.timestamp,
  }));
}
