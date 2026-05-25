/**
 * Receipt attribution extractor — Surface 4 → Surface 3 merge (§10.7).
 *
 * Pulls the per-turn provenance payload that the end-of-turn receipt
 * needs to render verbatim quotes of what was applied, captured, or
 * caught this turn. Replaces the inline `attribution:` block previously
 * emitted by `attribution-panel.ts` renderers.
 *
 * Pure data layer: no IO, deterministic, unit-testable in isolation.
 * Reads the same `NamedEvent` stream `turn-summary-handler` already
 * consumes for runtime joins — single-pass, no extra disk hits.
 *
 * Metadata-key priority mirrors `attribution-panel.ts:eventToAttributionRow`
 * (top_content → content → fact_content for fact text;
 * top_anchor_value → scope → file_path for scope) because writer-side
 * keys are not uniform across event types — `unerr_recall_notes` stamps
 * `top_content`, `unerr_remember` stamps `content`, legacy code uses
 * `fact_content`.
 */

import {
  type NamedEvent,
  makeInCurrentTurn,
} from "../tracking/named-events.js";

export interface AttributionRecall {
  /** Verbatim fact content that was surfaced. */
  content: string;
  /** Original user phrase that produced the capture (user_fed only). */
  source_quote?: string;
  /** Where the fact applies — file path, entity key, or 'project'. */
  scope?: string;
}

export interface AttributionCapture {
  /** Normalised statement that was stored. */
  content: string;
  /** Verbatim user phrase that triggered the capture. */
  source_quote?: string;
  /** Scope the new fact governs. */
  scope?: string;
}

export interface AttributionDrift {
  /** File whose drift was caught. */
  file_path: string;
}

export interface ReceiptAttribution {
  /** Recalls and convention-applied events that fired this turn. */
  recalls: AttributionRecall[];
  /** Captures (user_fed + agent_explicit) stored this turn. */
  captures: AttributionCapture[];
  /** Drift signals that the agent consumed this turn. */
  drift: AttributionDrift[];
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function recallFromEvent(event: NamedEvent): AttributionRecall | null {
  const meta = event.metadata;
  const content =
    stringOf(meta.content) ||
    stringOf(meta.top_content) ||
    stringOf(meta.fact_content);
  if (content.length === 0) return null;
  const source_quote = stringOf(meta.source_quote) || undefined;
  const scope =
    stringOf(meta.scope) ||
    stringOf(meta.top_anchor_value) ||
    event.file_path ||
    undefined;
  const row: AttributionRecall = { content };
  if (source_quote) row.source_quote = source_quote;
  if (scope) row.scope = scope;
  return row;
}

function captureFromEvent(event: NamedEvent): AttributionCapture | null {
  const meta = event.metadata;
  const content =
    stringOf(meta.content) ||
    stringOf(meta.top_content) ||
    stringOf(meta.fact_content);
  if (content.length === 0) return null;
  const source_quote = stringOf(meta.source_quote) || undefined;
  const scope = stringOf(meta.scope) || event.file_path || undefined;
  const row: AttributionCapture = { content };
  if (source_quote) row.source_quote = source_quote;
  if (scope) row.scope = scope;
  return row;
}

function driftFromEvent(event: NamedEvent): AttributionDrift | null {
  const file_path = event.file_path ?? stringOf(event.metadata.file_path);
  if (!file_path) return null;
  return { file_path };
}

const RECALL_TYPES = new Set(["fact_recalled", "convention_applied"]);
const CAPTURE_TYPES = new Set(["fact_stored_user_fed", "fact_stored_auto"]);
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
  const captures: AttributionCapture[] = [];
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
    } else if (CAPTURE_TYPES.has(e.event_type)) {
      const row = captureFromEvent(e);
      if (row) captures.push(row);
    } else if (DRIFT_TYPES.has(e.event_type)) {
      const row = driftFromEvent(e);
      if (row && !driftSeen.has(row.file_path)) {
        driftSeen.add(row.file_path);
        drift.push(row);
      }
    }
  }
  return { recalls, captures, drift };
}
