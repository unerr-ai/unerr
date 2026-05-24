/**
 * Receipt block renderer — Surface 4 → Surface 3 merge (§10.7 §B).
 *
 * Pure function. Composes the 1-to-4 line end-of-turn receipt block
 * the user sees in chat. Consolidates what used to be three separate
 * surfaces (Surface 3 economy line + Surface 4a inline attribution +
 * runtime-join segment) into one ambient block.
 *
 * Layout (variable height):
 *   1   headline:        `unerr » applied 2 rules · remembered 1 new`
 *   2-3 attribution:     `        ↳ applied your rule "no console.log …"    (recall)`
 *   4   footer:          `        · saved 6.3k tokens this turn · 7.4k saved this session`
 *
 * The headline is always present. Attribution rows are capped at 2 with
 * a `+N more` overflow tail on the footer. Footer folds into the
 * headline on no-attribution turns so the single-line legacy contract
 * is preserved when nothing fired.
 *
 * Deterministic, no IO, no module-level state.
 */

import type { RuntimeJoinCounts } from "../tracking/runtime-joins.js";
import type {
  AttributionCapture,
  AttributionDrift,
  AttributionRecall,
  ReceiptAttribution,
} from "./receipt-attribution.js";

const INDENT = "        ";
const ARROW = "↳";
const MAX_ROWS = 2;
const MAX_QUOTE_CHARS = 60;
const FOLD_HEADLINE_MAX = 120;

export interface ReceiptBlockInputs {
  attribution: ReceiptAttribution;
  runtimeJoins: RuntimeJoinCounts;
  /** Tokens saved during the current turn (token_flow_events sum). */
  turnTokensSaved: number;
  /** Tokens saved across the session so far. */
  sessionTokensSaved: number;
  /**
   * Legacy single-line receipt produced by `renderSessionEconomyLineLive`.
   * Returned untouched when no attribution / joins fired — preserves
   * the pre-merge UX on quiet turns.
   */
  fallbackLine: string;
}

function truncateQuote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_QUOTE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

function pickQuote(row: AttributionRecall | AttributionCapture): string {
  if (row.source_quote && row.source_quote.length <= MAX_QUOTE_CHARS) {
    return row.source_quote.trim();
  }
  return truncateQuote(row.content);
}

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) {
    const k = abs / 1000;
    const fixed = k >= 10 ? k.toFixed(0) : k.toFixed(1);
    return `${n < 0 ? "-" : ""}${fixed.replace(/\.0$/, "")}k`;
  }
  return `${n}`;
}

function totalJoinCount(joins: RuntimeJoinCounts): number {
  return joins.three_way + joins.memory_to_graph + joins.graph_to_drift;
}

function headlineSegments(
  attribution: ReceiptAttribution,
  joins: RuntimeJoinCounts
): string[] {
  const segments: string[] = [];
  const nRecalls = attribution.recalls.length;
  const nCaptures = attribution.captures.length;
  const nDrift = attribution.drift.length;
  const kJoins = totalJoinCount(joins);
  if (nRecalls > 0) {
    segments.push(`applied ${nRecalls} ${nRecalls === 1 ? "rule" : "rules"}`);
  }
  if (nCaptures > 0) {
    segments.push(
      `remembered ${nCaptures} new ${nCaptures === 1 ? "rule" : "rules"}`
    );
  }
  if (kJoins > 0) {
    segments.push(
      `joined ${kJoins} graph ${kJoins === 1 ? "node" : "nodes"}`
    );
  }
  if (nDrift > 0) {
    segments.push(
      `caught drift on ${nDrift} ${nDrift === 1 ? "file" : "files"}`
    );
  }
  return segments;
}

function recallRow(r: AttributionRecall): string {
  const quote = pickQuote(r);
  return `${INDENT}${ARROW} applied your rule "${quote}"  (recall)`;
}

function captureRow(c: AttributionCapture): string {
  const quote = pickQuote(c);
  return `${INDENT}${ARROW} remembered "${quote}"  (capture)`;
}

function driftRow(d: AttributionDrift): string {
  return `${INDENT}${ARROW} caught drift: ${d.file_path}  (drift)`;
}

function buildAttributionRows(attribution: ReceiptAttribution): {
  rows: string[];
  overflow: number;
} {
  const candidates: string[] = [];
  const firstRecall = attribution.recalls[0];
  if (firstRecall) candidates.push(recallRow(firstRecall));
  const firstCapture = attribution.captures[0];
  if (firstCapture) candidates.push(captureRow(firstCapture));
  const firstDrift = attribution.drift[0];
  if (firstDrift) candidates.push(driftRow(firstDrift));
  const remaining =
    attribution.recalls.length +
    attribution.captures.length +
    attribution.drift.length -
    candidates.length;
  if (candidates.length <= MAX_ROWS) {
    return { rows: candidates, overflow: remaining };
  }
  return {
    rows: candidates.slice(0, MAX_ROWS),
    overflow: remaining + (candidates.length - MAX_ROWS),
  };
}

function buildFooter(
  turnTokensSaved: number,
  sessionTokensSaved: number,
  overflow: number
): string {
  const parts: string[] = [];
  if (turnTokensSaved > 0) {
    parts.push(`saved ${formatTokens(turnTokensSaved)} tokens this turn`);
  }
  if (sessionTokensSaved > 0) {
    parts.push(`${formatTokens(sessionTokensSaved)} saved this session`);
  }
  if (overflow > 0) parts.push(`+${overflow} more`);
  if (parts.length === 0) return "";
  return `${INDENT}· ${parts.join(" · ")}`;
}

/**
 * Render the per-turn receipt block. Returns 1 to 4 lines.
 *
 * Behaviour:
 *   - Empty attribution + zero joins → `[fallbackLine]` (legacy preserved).
 *   - Otherwise → headline (always), 0-2 attribution rows, optional footer.
 *   - When no attribution rows fire and the combined headline + footer
 *     fits within `FOLD_HEADLINE_MAX`, they collapse into a single
 *     line so the no-attribution shape stays compact.
 */
export function renderReceiptBlock(inputs: ReceiptBlockInputs): string[] {
  const { attribution, runtimeJoins, turnTokensSaved, sessionTokensSaved } =
    inputs;
  const hasAttribution =
    attribution.recalls.length +
      attribution.captures.length +
      attribution.drift.length >
    0;
  const hasJoins = totalJoinCount(runtimeJoins) > 0;
  if (!hasAttribution && !hasJoins) {
    return [inputs.fallbackLine];
  }

  const segments = headlineSegments(attribution, runtimeJoins);
  const headlineCore =
    segments.length === 1
      ? `${segments[0]} this turn`
      : segments.join(" · ");
  const headline = `unerr » ${headlineCore}`;

  const { rows, overflow } = buildAttributionRows(attribution);
  const footer = buildFooter(turnTokensSaved, sessionTokensSaved, overflow);

  if (rows.length === 0 && footer.length > 0) {
    const footerInline = footer.slice(INDENT.length);
    const combined = `${headline} ${footerInline}`;
    if (combined.length <= FOLD_HEADLINE_MAX) return [combined];
  }

  const out: string[] = [headline, ...rows];
  if (footer.length > 0) out.push(footer);
  return out;
}
