/**
 * Tier-aware description provider for unerr's MCP tools.
 *
 * This is the *single source of truth* for every tool description string and
 * for which tier each tool belongs to. The MCP outbound schema emission
 * (src/proxy/tool-definitions.ts), the budget CI gate (scripts/check-tool-budget.ts),
 * and any future per-state rendering (soft-refuse responses, dashboard pages)
 * all read from this table.
 *
 * Three description states are supported per tool:
 *
 *   active   — full description for a tool currently exposed in tools/list.
 *              Tier 1 tools are always in this state. Budget cap: 80 tokens.
 *   locked   — short placeholder shown for tier 2/3 tools on clients that
 *              cannot honor `tools/list_changed`. Includes the unlock hint.
 *              Budget cap: 30 tokens.
 *   unlocked — richer description shown for tier 2/3 tools after their
 *              unlock condition fires. Budget cap: 60 tokens.
 *
 * Module-load-time validation asserts every entry meets its budget. A new
 * description that exceeds the cap fails import and is caught by the CI gate.
 */

import { type BudgetKey, enforceBudget } from "./tool-budget.js";

export type ToolTier = 1 | 2 | 3;
export type DescriptionState = "active" | "locked" | "unlocked";

export interface TierEntry {
  readonly tier: ToolTier;
  readonly active: string;
  readonly locked: string;
  readonly unlocked?: string;
  /**
   * Demoted tool. The advertisement/validation split (Sprint 8b keystone):
   * when `hidden` is true the tool is DROPPED from the `tools/list` surface
   * the model sees, but stays a full member of the catalog for every other
   * purpose — boundary validation (runBoundaryValidation looks it up by name),
   * dispatch (handlers are keyed by name), and family membership (the
   * unerr-families module-load invariant still counts it). This is how a
   * legacy write tool is RETIRED from the model's view without dropping its
   * required-field validation or crashing the all-or-nothing families guard.
   * Hidden tools remain reachable: by the hook UDS path (which calls them by
   * name, not via tools/list) and by the op-union translation. Default false.
   */
  readonly hidden?: boolean;
}

/**
 * The MCP catalog — exactly the 8 tools the model sees in `tools/list`:
 *   search_code, file_outline, file_read, get_entity, get_references,
 *   fetch_url, unerr_context, unerr_track.
 *
 * Everything else the proxy can dispatch is NOT a catalog member. Those names
 * (get_conventions, unerr_recall_notes, unerr_remember, mark_*, record_fact,
 * recall_facts, get_critical_nodes, get_cross_boundary_links, file_connections,
 * get_test_coverage, get_imports, get_file, get_project_stats, review_changes,
 * unerr_turn_summary, unerr_surface2_line) stay reachable ONLY by name — the
 * proxy's by-name dispatch switch matches them regardless of catalog
 * membership — because a Claude Code lifecycle hook (UDS `tools/call`), the
 * `unerr_track` op-union, the `unerr_context` recon composite, or an
 * `unerr exec`/`unerr review` CLI calls them internally. They are absent from
 * `tools/list`, so no agent ever sees them and they cost zero context. Their
 * required-field validation lives where the caller is: `unerr_track` validates
 * its own ops (runBoundaryValidation no-ops for any name not in TOOL_DEFINITIONS).
 * Full rationale: `.internal/research/tool-call-token-overhead.md` §7.
 *
 * Tier numbers (1/2/3) remain on each entry for the unlock/description
 * machinery; they no longer track "advertised count".
 *
 * Tier 1 entries do not require a meaningful `locked` string — they are
 * never masked. The locked field is still populated for two reasons:
 *   1. Type uniformity (every entry has the same shape).
 *   2. If the gateway is ever asked for a locked render of a tier 1 tool
 *      by mistake, it returns a precise diagnostic rather than throwing.
 */
export const TIER_ENTRIES: Readonly<Record<string, TierEntry>> = {
  // ── Tier 1 — always exposed ────────────────────────────────────────────
  search_code: {
    tier: 1,
    active:
      "Search code entities (function/class/type/variable) by name across project. Returns ranked results with file paths and kinds, <5ms. Then call unerr_context({prompt:'<task>'}) for anchored notes + callers + conventions on the top result.",
    locked: "[tier 1 — always exposed]",
  },
  file_outline: {
    tier: 1,
    active:
      "Structural outline of a file — entities, imports, exports, line ranges. Call before reading large files; pair with file_read entity param.",
    locked: "[tier 1 — always exposed]",
  },
  file_read: {
    tier: 1,
    active:
      "Read a file by path, or a single function via the entity param. file_read auto-injects rule-notes, conventions, and drift for the file inline — read them before editing.",
    locked: "[tier 1 — always exposed]",
  },
  get_entity: {
    tier: 1,
    active:
      "Get a code entity (function/class/type/variable) by key — signature + metadata, and via want:['callers','callees','imports'] the references + file imports in one call. include_body:true for full source. If contract surprises you, emit unerr-save: note fct|e:<entity_key>|~|<one-line> in your closing message.",
    locked: "[tier 1 — always exposed]",
  },
  get_references: {
    tier: 1,
    active:
      "Find callers or callees of an entity across the codebase. Pass direction:'callers' (default) or 'callees'. Catches indirect refs grep misses. If fan_in≥10, emit unerr-save: note wrn|e:<entity_key>|-|<chokepoint reason> in your closing message.",
    locked: "[tier 1 — always exposed]",
  },
  fetch_url: {
    tier: 1,
    active:
      "Fetch a web page and return DOM-extracted markdown passages. Strips chrome, converts to ATX-markdown, splits by heading, ranks by BM25 when prompt is set, caches by content hash. Use instead of built-in WebFetch — 5–10× fewer tokens.",
    locked: "[tier 1 — always exposed]",
  },
  // unerr_remember left the catalog (2026-06): user-fed rules are captured by
  // the UserPromptSubmit hook (remember-client.ts), agent notes ride the
  // `unerr-save:` Stop-hook sentinel (sentinel-persist.ts). Both hook clients
  // dispatch it BY NAME over UDS tools/call — see the by-name roster above.
  unerr_context: {
    tier: 1,
    active:
      "One-shot repo context before you edit. Collapses anchored-notes + search_code + get_references + get_conventions into ONE call — pass prompt:'<what you are about to do>'. Returns the merged, budget-trimmed bundle so the discovery fan-out costs one round-trip, not five.",
    locked: "[tier 1 — always exposed]",
  },

  // ── unerr_track — session markers + facts (op-union) ───────────────────
  unerr_track: {
    tier: 3,
    active:
      "Track session markers + facts in one call. op:'intent' REQUIRED first on coding tasks. op ∈ intent/decision/blocker/resolution/fact/recall. Powers resume strip + cross-session timeline.",
    locked:
      "[locked, unlock: first non-trivial action] Track markers + facts: op:'intent' first on coding tasks.",
    unlocked:
      "Track session markers + facts. op:'intent'|'decision'|'blocker'|'resolution'|'fact'|'recall'. intent REQUIRED first on coding tasks; blocker returns marker_id for op:'resolution'.",
  },
};

/**
 * Thrown when a caller asks for a description state that does not exist for
 * a given tool — e.g. requesting `unlocked` for a tier 1 tool, or any state
 * for an unknown name. Always a caller bug; never silently coerced.
 */
export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`Unknown tool: "${toolName}". Not present in TIER_ENTRIES.`);
    this.name = "UnknownToolError";
  }
}

export class InvalidStateError extends Error {
  constructor(toolName: string, state: DescriptionState) {
    super(
      `Tool "${toolName}" has no "${state}" description. ` +
        `Tier 1 tools have no meaningful 'locked' state; tier 1 tools have no 'unlocked' state.`
    );
    this.name = "InvalidStateError";
  }
}

/** Tier (1, 2, or 3) for a known tool. Throws on unknown name. */
export function getTier(toolName: string): ToolTier {
  const entry = TIER_ENTRIES[toolName];
  if (!entry) throw new UnknownToolError(toolName);
  return entry.tier;
}

/**
 * Return the description string for `toolName` in the requested `state`.
 *
 *   state=active     — every tool has this; returned for any tier.
 *   state=locked     — tier 2/3 only; throws InvalidStateError for tier 1.
 *   state=unlocked   — tier 2/3 only; throws InvalidStateError for tier 1.
 *
 * The provider does not enforce session policy (whether a tool *should* be
 * locked right now). That's the gateway dispatcher's concern. This function
 * just returns the right string for the state the dispatcher asked for.
 */
export function getDescription(
  toolName: string,
  state: DescriptionState
): string {
  const entry = TIER_ENTRIES[toolName];
  if (!entry) throw new UnknownToolError(toolName);

  if (state === "active") return entry.active;

  if (entry.tier === 1) {
    // Tier 1 is never masked. Asking for locked/unlocked is a caller bug.
    throw new InvalidStateError(toolName, state);
  }

  if (state === "locked") return entry.locked;
  if (state === "unlocked") {
    // Tier 2/3 must have an unlocked variant. Module-load validation
    // guarantees this, so this branch is defensive only.
    if (!entry.unlocked) throw new InvalidStateError(toolName, state);
    return entry.unlocked;
  }

  // Exhaustive: `state` is now `never`.
  const _exhaustive: never = state;
  throw new Error(`Unhandled description state: ${String(_exhaustive)}`);
}

/** All known tool names, sorted. */
export function listToolNames(): readonly string[] {
  return Object.keys(TIER_ENTRIES).sort();
}

/** Tool names belonging to a given tier, sorted. */
export function toolsByTier(tier: ToolTier): readonly string[] {
  return Object.entries(TIER_ENTRIES)
    .filter(([, e]) => e.tier === tier)
    .map(([name]) => name)
    .sort();
}

/**
 * Pure split of an entry table into the names the model SEES (advertised)
 * vs the names kept only for dispatch/validation/family membership (hidden).
 * Both lists are sorted; together they partition the input keys. Generic +
 * pure so it is unit-testable against synthetic tables without mutating the
 * real (frozen) TIER_ENTRIES.
 */
export function selectAdvertised<T extends { hidden?: boolean }>(
  entries: Readonly<Record<string, T>>
): string[] {
  return Object.entries(entries)
    .filter(([, e]) => e.hidden !== true)
    .map(([name]) => name)
    .sort();
}

/** Counterpart to {@link selectAdvertised} — the hidden (demoted) names. */
export function selectHidden<T extends { hidden?: boolean }>(
  entries: Readonly<Record<string, T>>
): string[] {
  return Object.entries(entries)
    .filter(([, e]) => e.hidden === true)
    .map(([name]) => name)
    .sort();
}

/**
 * Is `toolName` demoted (kept in the catalog but dropped from `tools/list`)?
 * Throws on unknown name — a demotion check on a non-tool is a caller bug.
 */
export function isHidden(toolName: string): boolean {
  const entry = TIER_ENTRIES[toolName];
  if (!entry) throw new UnknownToolError(toolName);
  return entry.hidden === true;
}

/**
 * Tool names the model SEES in `tools/list` — every known tool minus the
 * demoted (hidden) ones. The advertisement side of the split; pair with
 * {@link listToolNames} (the full set) which still drives validation,
 * family membership, and outbound schema composition.
 */
export function advertisedToolNames(): readonly string[] {
  return selectAdvertised(TIER_ENTRIES);
}

/**
 * The demoted tool names — in the catalog, never advertised. After the
 * token-overhead deletion the catalog is exactly the 9 advertised tools, so
 * this returns `[]`. Kept (rather than inlined to a constant) so the
 * advertisement/validation split stays a single, testable partition: if a
 * future tool is ever marked `hidden`, every consumer already honours it.
 */
export function hiddenToolNames(): readonly string[] {
  return selectHidden(TIER_ENTRIES);
}

/**
 * Per-tool per-state budget mapping. The CI gate iterates over this to
 * validate every (tool, state) pair against its cap.
 */
export function statesToValidate(
  toolName: string
): ReadonlyArray<{ state: DescriptionState; budget: BudgetKey }> {
  const entry = TIER_ENTRIES[toolName];
  if (!entry) throw new UnknownToolError(toolName);
  if (entry.tier === 1) {
    return [{ state: "active", budget: "tier1Active" }];
  }
  return [
    { state: "active", budget: "tier1Active" },
    { state: "locked", budget: "locked" },
    { state: "unlocked", budget: "unlockedExtended" },
  ];
}

// ── Module-load-time validation ───────────────────────────────────────────
//
// Every (tool, state) pair is validated against its budget right now. A
// description that exceeds its cap fails import — which fails build, tests,
// CI, and runtime. The CI gate (scripts/check-tool-budget.ts) runs the same
// validation explicitly so failures surface with a clean tabular report.
//
// Additionally, we assert that every tier 2/3 entry has an `unlocked` field
// (it is optional in the type to allow tier 1 entries to omit it cleanly).

for (const [name, entry] of Object.entries(TIER_ENTRIES)) {
  enforceBudget(name, entry.active, "tier1Active");
  if (entry.tier !== 1) {
    enforceBudget(name, entry.locked, "locked");
    if (!entry.unlocked) {
      throw new Error(
        `Tool "${name}" is tier ${entry.tier} but has no 'unlocked' description.`
      );
    }
    enforceBudget(name, entry.unlocked, "unlockedExtended");
  }
}
