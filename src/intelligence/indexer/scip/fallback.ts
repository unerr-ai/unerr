/**
 * SCIP Graceful Degradation — handles all failure scenarios cleanly.
 *
 * - Binary not found → skip, log info, continue at Tier-2 quality
 * - Binary crashes → partial output → enrich what we have
 * - Timeout exceeded → kill process, use tree-sitter edges only
 * - Protobuf decode error → skip corrupted sections
 */

import { createModuleLogger } from "../../../utils/logger.js";
import type { IndexedEdge } from "../plugin-interface.js";
import type { EnrichedEdge } from "./merger.js";

const log = createModuleLogger("scip-fallback");

export type ScipDegradationLevel = "full" | "partial" | "unavailable";

export interface DegradationResult {
  level: ScipDegradationLevel;
  reason: string;
  edges: EnrichedEdge[];
}

/**
 * Apply graceful degradation to edges when SCIP is unavailable or failed.
 */
export function applyScipFallback(
  existingEdges: IndexedEdge[],
  reason: string,
  level: ScipDegradationLevel = "unavailable",
): DegradationResult {
  log.info(`SCIP degradation (${level}): ${reason}`);

  const edges: EnrichedEdge[] = existingEdges.map((e) => ({
    ...e,
    confidence: "structural" as const,
    scipVerified: false,
  }));

  return { level, reason, edges };
}

/**
 * Determine degradation level from error type.
 */
export function classifyScipError(error: string): ScipDegradationLevel {
  if (error.includes("not found") || error.includes("ENOENT"))
    return "unavailable";
  if (error.includes("timeout") || error.includes("ETIMEDOUT"))
    return "partial";
  if (error.includes("decode") || error.includes("protobuf")) return "partial";
  return "unavailable";
}
