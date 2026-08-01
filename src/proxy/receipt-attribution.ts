/**
 * Receipt attribution extractor — Surface 4 → Surface 3 merge (§10.7).
 *
 * Pulls the per-turn provenance payload the end-of-turn receipt needs: how
 * many dated incidents `unerr_recall_traces` resurfaced this turn from the
 * timeline store, and which files drift was caught on. Replaces the inline
 * `attribution:` block previously emitted by `attribution-panel.ts` renderers.
 *
 * Pure data layer: no IO, deterministic, unit-testable in isolation.
 * Reads the same `NamedEvent` stream `turn-summary-handler` already
 * consumes for runtime joins — single-pass, no extra disk hits.
 */

import {
  type NamedEvent,
  makeInCurrentTurn,
} from "../tracking/named-events.js";

export interface AttributionRecall {
  /** Population of dated incidents `trace_recalled` surfaced this turn. */
  count: number;
}

export interface AttributionDrift {
  /** File whose drift was caught. */
  file_path: string;
}

export interface ReceiptAttribution {
  /** `trace_recalled` events that fired this turn (dated incidents resurfaced
   *  from the timeline store). */
  recalls: AttributionRecall[];
  /** Drift signals that the agent consumed this turn. */
  drift: AttributionDrift[];
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function recallFromEvent(event: NamedEvent): AttributionRecall | null {
  const count = numberOf(event.metadata.count);
  if (count <= 0) return null;
  return { count };
}

function driftFromEvent(event: NamedEvent): AttributionDrift | null {
  const file_path = event.file_path ?? stringOf(event.metadata.file_path);
  if (!file_path) return null;
  return { file_path };
}

const RECALL_TYPES = new Set(["trace_recalled"]);
const DRIFT_TYPES = new Set(["drift_consumed"]);

/**
 * Extract the per-turn attribution payload from the session's event
 * stream. Filters to `currentTurn`, classifies by event type, and
 * normalises each row to the shape `renderReceiptBlock` expects.
 *
 * Returns empty arrays when nothing fired this turn — the renderer
 * uses that to fall through to the legacy single-line receipt.
 */
export function extractReceiptAttribution(
  events: readonly NamedEvent[],
  currentTurn: number
): ReceiptAttribution {
  const recalls: AttributionRecall[] = [];
  const drift: AttributionDrift[] = [];
  const driftSeen = new Set<string>();
  // Bind to the conversational turn via the prompt boundary (accurate),
  // falling back to the segmenter `turn` match for pre-hook sessions —
  // mirrors the slice in renderSessionEconomyLineLive so the attribution
  // rows and the per-turn token number describe the same window.
  const inCurrentTurn = makeInCurrentTurn(events, currentTurn);
  for (const e of events) {
    if (!inCurrentTurn(e.ts, e.turn)) continue;
    if (RECALL_TYPES.has(e.event_type)) {
      const row = recallFromEvent(e);
      if (row) recalls.push(row);
    } else if (DRIFT_TYPES.has(e.event_type)) {
      const row = driftFromEvent(e);
      if (row && !driftSeen.has(row.file_path)) {
        driftSeen.add(row.file_path);
        drift.push(row);
      }
    }
  }
  return { recalls, drift };
}
