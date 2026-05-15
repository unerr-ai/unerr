/**
 * Intelligence Response Enrichment — populates the internal `meta` / `context`
 * carrier with risk, confidence, and convention data. These fields never reach
 * the wire — `buildSignalPrefix()` drains them into `ur|<tag>` prefix lines at
 * the wire boundary (MCP clients strip `_meta`/`_context` envelopes).
 *
 * P.9: Every intelligence query response carries (on the internal envelope):
 *   - meta.confidence: propagated confidence level
 *   - meta.risk_level: entity risk classification → `ur|rsk` when high
 *   - meta.resolution_ms: query execution time
 *   - context.conventions: applicable conventions → `ur|hnt` / `ur|fct` lines
 */

import { confidenceToScore } from "../intelligence/confidence-propagation.js";
import type { ConfidenceLevel } from "../intelligence/indexer/confidence.js";

export interface IntelligenceMeta {
  confidence: ConfidenceLevel;
  confidence_score: number;
  risk_level: string;
  resolution_ms: number;
  edge_sources: Record<string, number>;
}

export interface EnrichedResponse {
  content: unknown;
  _meta: IntelligenceMeta;
  _context?: Record<string, unknown>;
}

/**
 * Enrich a query response with intelligence metadata.
 */
export function enrichResponse(
  content: unknown,
  meta: {
    confidence: ConfidenceLevel;
    riskLevel: string;
    resolutionMs: number;
    edgeSources: Record<string, number>;
  },
  context?: Record<string, unknown>
): EnrichedResponse {
  const result: EnrichedResponse = {
    content,
    _meta: {
      confidence: meta.confidence,
      confidence_score: confidenceToScore(meta.confidence),
      risk_level: meta.riskLevel,
      resolution_ms: Math.round(meta.resolutionMs * 100) / 100,
      edge_sources: meta.edgeSources,
    },
  };

  if (context && Object.keys(context).length > 0) {
    result._context = context;
  }

  return result;
}
