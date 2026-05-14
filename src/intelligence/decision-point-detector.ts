/**
 * Decision Point Detector — determines decision level from tool call context.
 *
 * Part of Layer B of the Three-Layer Experience System.
 * Controls how many signals to surface based on what the agent is doing:
 * - high: pre-edit (5 signals, burst mode)
 * - medium: understanding (3 signals, default)
 * - low: exploring (2 signals, minimal)
 */

import type { SessionContext } from "./session-context.js";

export type DecisionLevel = "high" | "medium" | "low";

/** Tools that indicate exploration (low stakes) */
const EXPLORATION_TOOLS = new Set([
  "file_outline",
  "get_project_stats",
  "get_conventions",
  "get_critical_nodes",
  "get_cross_boundary_links",
]);

/** Tools that indicate understanding phase (medium stakes) */
const UNDERSTANDING_TOOLS = new Set([
  "get_references",
  "get_imports",
  "get_callers",
  "get_callees",
  "search_code",
  "file_connections",
  "get_test_coverage",
]);

/** Tools that can be pre-edit (high stakes when combined with session history) */
const PRE_EDIT_TOOLS = new Set([
  "file_read",
  "get_entity",
  "get_function",
  "get_file",
]);

export class DecisionPointDetector {
  /**
   * Determine decision level from tool call context.
   *
   * high: pre-edit — file_read/get_entity on an entity previously explored
   *       via get_references, or entity with active corrections/drift.
   * medium: understanding — get_references, get_imports, search_code
   * low: exploring — file_outline, get_project_stats, get_conventions
   */
  detect(
    toolName: string,
    args: Record<string, unknown>,
    sessionContext: SessionContext,
  ): DecisionLevel {
    // Exploration tools are always low
    if (EXPLORATION_TOOLS.has(toolName)) {
      return "low";
    }

    // Understanding tools are medium
    if (UNDERSTANDING_TOOLS.has(toolName)) {
      return "medium";
    }

    // Pre-edit tools: check session history for high-stakes signals
    if (PRE_EDIT_TOOLS.has(toolName)) {
      const entityKey = (args.key as string) ?? (args.name as string);
      if (entityKey && sessionContext.hasHistory(entityKey)) {
        // Entity was previously queried — agent is likely about to edit
        return "high";
      }

      // Even without history, file_read with purpose='edit' is high
      if (args.purpose === "edit") {
        return "high";
      }

      // file_read/get_entity without prior exploration is medium
      return "medium";
    }

    // Default: medium for unknown tools
    return "medium";
  }

  /**
   * Get max signals count for a decision level.
   */
  getMaxSignals(level: DecisionLevel): number {
    switch (level) {
      case "high":
        return 5;
      case "medium":
        return 3;
      case "low":
        return 2;
    }
  }
}

/** Singleton instance */
let _detector: DecisionPointDetector | null = null;

export function getDecisionPointDetector(): DecisionPointDetector {
  if (!_detector) _detector = new DecisionPointDetector();
  return _detector;
}
