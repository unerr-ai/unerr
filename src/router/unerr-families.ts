/**
 * Declarative registry of every unerr MCP tool's family + tier.
 *
 * The MCP router infrastructure (FamilyMaskEngine, IntentDispatcher) is
 * organised around *families* — sets of related tools that expose or mask
 * together. External-service families (pg, gh, slk, k8s, …) live in
 * `family-detector.ts`. This file is the parallel registry for unerr's
 * own tool clusters.
 *
 * Four unerr families (one per advertised-catalog cluster):
 *
 *   graph    — code-graph navigation (search, entity, refs, recon composite)
 *   file     — file protocol (outline, read, edit, write)
 *   markers  — session markers + facts op-union (unerr_track)
 *   web      — external fetch (fetch_url)
 *
 * (The former `notes` family retired with `unerr_remember`'s catalog removal,
 * 2026-06 — Layer B writes now ride hooks: user rules at UserPromptSubmit,
 * agent notes via the `unerr-save:` Stop-hook sentinel; recall is folded into
 * `unerr_context`.)
 *
 * All four are always-on (unerr is the *server*; its own tools cannot be masked
 * by intent scoring the way an external-service family can). The registry
 * exists so the router has the full picture for telemetry, dashboard
 * rendering, and any future per-family policy (rate-limits, attribution).
 *
 * Only the ADVERTISED catalog tools appear here. The names the proxy dispatches by
 * name only (unerr_remember, mark_*, record_fact, recall_facts,
 * get_conventions, the demoted graph reads, …) are not catalog members, so
 * they are deliberately absent — the bidirectional invariant below would
 * reject them.
 *
 * Invariant: every tool name in TIER_ENTRIES must appear in exactly one
 * family below. The contract-teaching / unerr-families test
 * (src/__tests__/unerr-families.test.ts) enforces this at module-load time.
 */

import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";

export type UnerrFamilyName = "graph" | "file" | "markers" | "web";

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
    tools: ["search_code", "get_references", "unerr_context"],
  },
  file: {
    name: "file",
    label: "File protocol",
    tools: ["file_outline", "file_read", "file_edit", "file_write"],
  },
  markers: {
    name: "markers",
    label: "Session markers + facts",
    tools: ["unerr_track"],
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
      `unerr-families: TIER_ENTRIES contains tools not registered to any family: ${missing.join(", ")}. Add them to src/router/unerr-families.ts.`
    );
  }
  const registered = [...UNERR_TOOL_TO_FAMILY.keys()];
  const orphaned = registered.filter((t) => !tieredTools.includes(t));
  if (orphaned.length > 0) {
    throw new Error(
      `unerr-families: registry contains tools not in TIER_ENTRIES: ${orphaned.join(", ")}. Remove from src/router/unerr-families.ts or add to TIER_ENTRIES.`
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
