/**
 * Declarative registry of every unerr MCP tool's family + tier.
 *
 * The MCP router infrastructure (FamilyMaskEngine, IntentDispatcher) is
 * organised around *families* — sets of related tools that expose or mask
 * together. External-service families (pg, gh, slk, k8s, …) live in
 * `family-detector.ts`. This file is the parallel registry for unerr's
 * own tool clusters.
 *
 * Six unerr families:
 *
 *   graph    — code-graph navigation (search, refs, structure, conventions)
 *   file     — file-protocol reads (outline, read, get_file)
 *   notes    — active-cognition Layer B (recall_notes, remember as overloaded write)
 *   fact     — legacy fact store (recall_facts, record_fact)
 *   markers  — session-narrative markers (intent, decision, blocker, resolution)
 *   web      — external fetch (fetch_url)
 *
 * All six are always-on (unerr is the *server*; its own tools cannot be masked
 * by intent scoring the way an external-service family can). The registry
 * exists so the router has the full picture for telemetry, dashboard
 * rendering, and any future per-family policy (rate-limits, attribution).
 *
 * Invariant: every tool name in TIER_ENTRIES must appear in exactly one
 * family below. The contract-teaching / unerr-families test
 * (src/__tests__/unerr-families.test.ts) enforces this at module-load time.
 */

import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";
import { NOTES_FAMILY_NAME } from "./notes-family.js";

export type UnerrFamilyName =
  | "graph"
  | "file"
  | "notes"
  | "fact"
  | "markers"
  | "web";

export interface UnerrFamilyEntry {
  readonly name: UnerrFamilyName;
  readonly label: string;
  /** Tool names (must match TIER_ENTRIES keys). */
  readonly tools: readonly string[];
}

export const UNERR_FAMILIES: Readonly<
  Record<UnerrFamilyName, UnerrFamilyEntry>
> = {
  graph: {
    name: "graph",
    label: "Code graph navigation",
    tools: [
      "search_code",
      "get_entity",
      "get_references",
      "get_imports",
      "get_conventions",
      "get_critical_nodes",
      "get_cross_boundary_links",
      "file_connections",
      "get_test_coverage",
      "get_project_stats",
      "review_changes",
    ],
  },
  file: {
    name: "file",
    label: "File protocol",
    tools: ["file_outline", "file_read", "get_file"],
  },
  notes: {
    name: NOTES_FAMILY_NAME,
    label: "Active-cognition notes",
    tools: ["unerr_recall_notes", "unerr_remember"],
  },
  fact: {
    name: "fact",
    label: "Legacy facts",
    tools: ["recall_facts", "record_fact"],
  },
  markers: {
    name: "markers",
    label: "Session markers",
    tools: [
      "mark_intent",
      "mark_decision",
      "mark_blocker",
      "mark_resolution",
      "unerr_turn_summary",
      "unerr_surface2_line",
    ],
  },
  web: {
    name: "web",
    label: "Web fetch",
    tools: ["fetch_url"],
  },
};

/** Reverse lookup: tool name → family name. Built once at module load. */
export const UNERR_TOOL_TO_FAMILY: ReadonlyMap<string, UnerrFamilyName> =
  (() => {
    const m = new Map<string, UnerrFamilyName>();
    for (const family of Object.values(UNERR_FAMILIES)) {
      for (const tool of family.tools) {
        if (m.has(tool)) {
          throw new Error(
            `unerr-families: tool "${tool}" registered to multiple families ` +
              `("${m.get(tool)}" and "${family.name}"). Each tool must belong to exactly one family.`
          );
        }
        m.set(tool, family.name);
      }
    }
    return m;
  })();

/** Every unerr family name (always-on set for FamilyMaskEngine). */
export const UNERR_FAMILY_NAMES: ReadonlySet<UnerrFamilyName> = new Set(
  Object.keys(UNERR_FAMILIES) as UnerrFamilyName[]
);

/**
 * Module-load assertion: every tool in TIER_ENTRIES must belong to exactly
 * one unerr family. Catches drift between tool-descriptions.ts (the source
 * of truth for what ships) and this registry (the source of truth for
 * router family membership).
 */
(() => {
  const tieredTools = Object.keys(TIER_ENTRIES);
  const missing: string[] = [];
  for (const t of tieredTools) {
    if (!UNERR_TOOL_TO_FAMILY.has(t)) missing.push(t);
  }
  if (missing.length > 0) {
    throw new Error(
      `unerr-families: TIER_ENTRIES contains tools not registered to any family: ${missing.join(", ")}. ` +
        `Add them to src/router/unerr-families.ts.`
    );
  }
  const registered = [...UNERR_TOOL_TO_FAMILY.keys()];
  const orphaned = registered.filter((t) => !tieredTools.includes(t));
  if (orphaned.length > 0) {
    throw new Error(
      `unerr-families: registry contains tools not in TIER_ENTRIES: ${orphaned.join(", ")}. ` +
        `Remove from src/router/unerr-families.ts or add to TIER_ENTRIES.`
    );
  }
})();

/** Extend an always-on set with every unerr family. Used when constructing
 *  FamilyMaskEngine so unerr's own tools are never masked by intent scoring. */
export function withAllUnerrAlwaysOn(
  existingAlwaysOn: ReadonlySet<string>
): Set<string> {
  return new Set([...existingAlwaysOn, ...UNERR_FAMILY_NAMES]);
}

/** Extend a known-families set with every unerr family. */
export function withAllUnerrKnown(
  existingKnown: ReadonlySet<string>
): Set<string> {
  return new Set([...existingKnown, ...UNERR_FAMILY_NAMES]);
}
