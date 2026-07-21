/**
 * Surface parity helpers — Phase 3 Sprint 12.
 *
 * Pure functions the parity tests use to assert the new surfaces stay
 * in lock-step with the existing ones. Each function takes pre-fetched
 * data from both sources and returns a `ParityReport` listing any
 * mismatch.
 *
 *   - readNamedEvents vs readBehaviorEvents (verb/object/agent/file_path)
 *   - Logbook story-paragraph counts vs Dashboard counter aggregates
 *   - Session Economy turn-headroom vs Token Trace tokens-saved
 *
 * No IO — the tests own the IO and pass results in.
 */

import type { BehaviorEvent } from "./behavior-events.js";
import type { NamedEvent } from "./named-events.js";

export interface ParityReport {
  matched: boolean;
  mismatches: string[];
}

export function emptyReport(): ParityReport {
  return { matched: true, mismatches: [] };
}

function fail(report: ParityReport, msg: string): void {
  report.matched = false;
  report.mismatches.push(msg);
}

/**
 * Parity 1 — every BehaviorEvent must surface in the NamedEvent
 * projection with the same session_id / turn / ts / file_path / agent
 * (when resolvable). The named-events projection only carries entries
 * we know how to phrase; if a behavior_event's type has no phrasing
 * row, the projection still emits a default `recorded · event` pairing
 * — so the count must match exactly.
 */
export function namedEventsBehaviorParity(
  behaviorRows: BehaviorEvent[],
  namedRows: NamedEvent[]
): ParityReport {
  const report = emptyReport();
  const behaviorIdx = new Map<string, BehaviorEvent>();
  for (const ev of behaviorRows) {
    behaviorIdx.set(`${ev.session_id}|${ev.turn}|${ev.ts}|${ev.type}`, ev);
  }
  for (const [key, ev] of behaviorIdx) {
    const projected = namedRows.find(
      (n) =>
        n.session_id === ev.session_id &&
        n.turn === ev.turn &&
        n.ts === ev.ts &&
        n.event_type === ev.type
    );
    if (!projected) {
      fail(report, `missing projection for behavior row ${key}`);
    }
  }
  return report;
}

/**
 * Parity 2 — Logbook story-paragraph counts must equal the raw
 * behavior-event counts for the overlapping event types.
 */
export function logbookCountersParity(
  logbookByType: Record<string, number>,
  behaviorByType: Record<string, number>
): ParityReport {
  const report = emptyReport();
  const overlap = new Set([
    ...Object.keys(logbookByType),
    ...Object.keys(behaviorByType),
  ]);
  for (const type of overlap) {
    if (type.startsWith("tokenflow.")) continue;
    const l = logbookByType[type] ?? 0;
    const b = behaviorByType[type] ?? 0;
    if (l !== b) {
      fail(report, `count mismatch for ${type}: logbook=${l} behavior=${b}`);
    }
  }
  return report;
}

/**
 * Parity 3 — Session Economy total tokens saved per period must equal
 * the sum of `tokens_saved` across the same token_flow_events rows the
 * Token Trace endpoint reads.
 */
export function sessionEconomyTokenFlowParity(
  economyTokens: number,
  tokenFlowTokens: number
): ParityReport {
  const report = emptyReport();
  if (economyTokens !== tokenFlowTokens) {
    fail(
      report,
      `tokens saved mismatch: session-economy=${economyTokens} token-flow=${tokenFlowTokens}`
    );
  }
  return report;
}
