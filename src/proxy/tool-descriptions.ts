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
  /**
   * Conditionally hidden — agent-aware advertisement (Sprint 7 keystone).
   * When set, the tool is dropped from `tools/list` ONLY for agents whose
   * hook profile possesses the named capability (a hook injects the same
   * payload at zero round-trip), and KEPT advertised for agents that lack it
   * (the MCP tool is their only path — no regression). Distinct from `hidden`,
   * which retires a tool for every agent because a non-hook replacement
   * (op-union, merged read) covers all of them.
   *
   * The capability key matches `HookCapabilities` in agent-registry.ts; a
   * local string union avoids a module-graph edge from tool-descriptions →
   * agent-registry. The advertisement filter (proxy `getAdvertisedTools`)
   * resolves the requesting agent's capabilities and applies this per call.
   */
  readonly hiddenForHookCap?: HookCapKey;
}

/**
 * The hook capabilities that can RETIRE an MCP tool when present. Mirrors the
 * boolean members of `HookCapabilities` (agent-registry.ts) — `adapter` is
 * excluded because it is descriptive, not a gating capability.
 */
export type HookCapKey =
  | "promptContextInject"
  | "toolContextInject"
  | "sessionStart"
  | "stop";

/**
 * The resolved capability profile passed to the agent-aware selectors. A
 * structural subset of `HookCapabilities` (the four gating booleans), kept
 * local so this module stays decoupled from agent-registry.
 */
export type HookCapProfile = Readonly<Record<HookCapKey, boolean>>;

/**
 * Tier 1 — always exposed (12 tools).
 * Tier 2 — structurally unlocked (8 tools).
 * Tier 3 — intent-unlocked (7 tools — incl. the unerr_track op-union).
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
      "Search code entities (function/class/type/variable) by name across project. Returns ranked results with file paths and kinds, <5ms. Then call unerr_recall_notes({anchors:['e:<top_hit_key>']}) for notes on the top result.",
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
      "Read file with auto-injected conventions, facts, and drift status. Supports entity param for targeted single-function reads. Before editing, call unerr_recall_notes({anchors:['f:<file_path>']}) for rule-notes.",
    locked: "[tier 1 — always exposed]",
  },
  get_entity: {
    tier: 1,
    active:
      "Get a code entity (function/class/type/variable) by key — signature + metadata, and via want:['callers','callees','imports'] the references + file imports in one call. include_body:true for full source. If contract surprises you, call unerr_remember({type:'note', note:'fct|e:<entity_key>|~|<one-line>'}).",
    locked: "[tier 1 — always exposed]",
  },
  get_references: {
    tier: 1,
    active:
      "Find callers or callees of an entity across the codebase. Pass direction:'callers' (default) or 'callees'. Catches indirect refs grep misses. If fan_in≥10, call unerr_remember({type:'note', note:'wrn|e:<entity_key>|-|<chokepoint reason>'}).",
    locked: "[tier 1 — always exposed]",
  },
  fetch_url: {
    tier: 1,
    active:
      "Fetch a web page and return DOM-extracted markdown passages. Strips chrome, converts to ATX-markdown, splits by heading, ranks by BM25 when prompt is set, caches by content hash. Use instead of built-in WebFetch — 5–10× fewer tokens.",
    locked: "[tier 1 — always exposed]",
  },
  unerr_remember: {
    tier: 1,
    active:
      "Persist user-asserted facts ('remember', 'always', project rules). Pass source_quote + confidence (≥0.5 stored). For anchored Layer B notes pass {type:'note', note:'kind|anchor|polarity|content', session_id}.",
    locked: "[tier 1 — always exposed]",
  },
  unerr_recall_notes: {
    tier: 1,
    // Sprint 7 (T7.3): Moment-1 recall is ALSO injected automatically via the
    // UserPromptSubmit hook (prompt-hooks.ts renders the recall block into
    // additionalContext at zero round-trip) — an additive accelerator. The tool
    // is deliberately KEPT advertised (not hiddenForHookCap): the bundled skills
    // (local-pack.ts) are shared verbatim across agents and name
    // unerr_recall_notes as the Moment-1 contract + the Moment-2 anchor query,
    // and hook-less agents (Cursor/Cline) have no injection path. Hiding it for
    // hook-capable agents would break the coupling rule (instructions still name
    // it). Retire only once the skills become hook-capability-aware — the
    // agent-aware advertisement mechanism (hiddenForHookCap) is in place for it.
    active:
      "Recall anchored notes. On prompt receipt: {prompt:'<verbatim>'}. After identifying targets: {anchors:['f:src/x.ts','e:foo']}. Empty result is fine.",
    locked: "[tier 1 — always exposed]",
  },
  get_project_stats: {
    tier: 1,
    active:
      "Project-wide stats — entity/edge counts, language breakdown, community count, health grade. Call before search_code for orientation in an unfamiliar repo.",
    locked: "[tier 1 — always exposed]",
  },
  unerr_turn_summary: {
    tier: 1,
    // Sprint 7 (T7.2): the close-out economy line is ALSO emitted automatically
    // via the Stop hook (stop-hooks.ts computeTurnSummaryLine → user-facing
    // systemMessage) at zero round-trip — an additive accelerator. The tool is
    // deliberately KEPT advertised (not hiddenForHookCap): the bundled skills
    // (local-pack.ts) are shared verbatim across agents and name
    // unerr_turn_summary as the required end-of-turn close-out, and hook-less
    // agents (Cursor/Cline have no Stop-with-systemMessage) have no emission
    // path. Hiding it for Stop-capable agents would break the coupling rule
    // (instructions still name it). Retire only once the skills become
    // hook-capability-aware — the mechanism (hiddenForHookCap) is in place.
    active:
      "REQUIRED at end of every coding turn — call ONCE before drafting your closing summary, then include the returned `line` verbatim in your final message. Returns {ok, line} (economy counters stay server-side for the dashboard).",
    locked: "[tier 1 — always exposed]",
  },
  unerr_surface2_line: {
    tier: 1,
    active:
      "REQUIRED at the start of every coding turn after `unerr_recall_notes` — call ONCE then paste the returned `line` verbatim, prefixed with `unerr » `, into your first user-facing response. Returns {line, suppressed_reason?} — when `line` is empty, emit nothing (do not invent prose).",
    locked: "[tier 1 — always exposed]",
  },
  unerr_context: {
    tier: 1,
    active:
      "One-shot repo context before you edit. Collapses anchored-notes + search_code + get_references + get_conventions into ONE call — pass prompt:'<what you are about to do>'. Returns the merged, budget-trimmed bundle so the discovery fan-out costs one round-trip, not five.",
    locked: "[tier 1 — always exposed]",
  },

  // ── Tier 2 — structural unlock ─────────────────────────────────────────
  get_critical_nodes: {
    tier: 2,
    active:
      "Rank entities by structural importance (fan_in + fan_out). Surfaces chokepoints to inspect before refactoring.",
    locked:
      "[locked, unlock: high blast radius] Chokepoint entities ranked by fan_in. Use get_references first.",
    unlocked:
      "Rank entities by fan_in + fan_out (chokepoints). Scope with community_id; top_n controls result count. Use before risky refactors.",
  },
  get_cross_boundary_links: {
    tier: 2,
    // Demoted (Sprint 10): an occasional structural query. file_outline shows a
    // file's imports and get_references({direction:'callees'}) its call-level
    // neighbors, so cross-boundary coupling is reachable without a hot-loop slot.
    // hidden:true drops it from tools/list while it stays a full catalog member
    // for dispatch + boundary validation + family membership. No agent-facing
    // instruction surface names it any more (exec nudge + query-router hints
    // rewritten to file_outline / get_references in Sprint 10).
    hidden: true,
    active:
      "Find edges that cross module or directory boundaries. Scope with from_path and to_path. Reveals coupling before splits.",
    locked:
      "[locked, unlock: cross-module access] Edges crossing module boundaries. Use get_references first.",
    unlocked:
      "Edges that cross module or directory boundaries. Scope with from_path and to_path. Reveals hidden coupling before splits.",
  },
  file_connections: {
    tier: 2,
    // Demoted (Sprint 10): an occasional structural query. file_outline carries
    // a file's imports; get_references({direction:'callers'}) its importers at
    // entity granularity, so the dependency neighborhood is reachable without a
    // hot-loop slot. hidden:true drops it from tools/list while it stays a full
    // catalog member for dispatch + boundary validation + family membership. No
    // agent-facing instruction surface names it any more (exec nudge, pre-write
    // hook, signal-scorer action, query-router hints rewritten in Sprint 10).
    hidden: true,
    active:
      "Files connected to a target via imports, importers, and co-change. Reveals the dependency neighborhood.",
    locked:
      "[locked, unlock: directory pattern] Dependency neighborhood of a file. Use file_outline first.",
    unlocked:
      "Files connected via imports, importers, and co-change. Returns the full dependency neighborhood. Use before move or rename.",
  },
  get_test_coverage: {
    tier: 2,
    active:
      "Find test files covering an entity, traced through the graph (direct + transitive).",
    locked:
      "[locked, unlock: test file accessed] Tests covering an entity. Use get_references first.",
    unlocked:
      "Test files covering an entity, traced through the graph. include_transitive walks callers too. Use before modifying an entity.",
  },
  get_imports: {
    tier: 2,
    // Demoted (Sprint 11, T9 merge): folded into get_entity({want:['imports']})
    // and file_outline (which returns an `imports` field). hidden:true drops it
    // from tools/list; it stays a full catalog member for dispatch + validation
    // + family membership, so any legacy/hook-less caller still resolves. No
    // agent-facing instruction surface names get_imports any more (rewritten to
    // file_outline / get_entity want in Sprint 11).
    hidden: true,
    active: "All imports for a file with resolved paths and entity types.",
    locked:
      "[locked, unlock: file with 5+ imports] Resolved imports for a file. Use file_outline first.",
    unlocked:
      "Resolved imports for a file, mapped to entity types. Use for cross-module dependency tracing.",
  },
  get_conventions: {
    tier: 2,
    // Sprint 7 (T7.4): the project's conventions are now ALSO injected
    // automatically on the first code-file read of a session via the
    // PostToolUse(Read) hook (conventions-client.ts → renderConventionsBlock) at
    // zero round-trip — covering the "write new code matching project style"
    // case without a tool call. The standalone tool is deliberately KEPT
    // advertised (not hidden): the unerr-review skill and the safe-modification
    // flow call get_conventions({file_path:'<path>'}) for per-file convention
    // breach checks, which the project-wide once-per-session injection does not
    // replace. Retiring it would drop that capability and break the skills that
    // name it (coupling rule). Revisit only if a per-file injection lands.
    active:
      "All detected code conventions with adherence rates — naming, patterns, structure.",
    locked:
      "[locked, unlock: first file read] Project code conventions. Call file_read on any file first.",
    unlocked:
      "Detected code conventions with adherence rates. Call before writing new code to match project style.",
  },
  get_file: {
    tier: 2,
    // Demoted (Sprint 9, T9.1): file_outline returns the same file-level
    // entities plus imports + exports, so get_file is a strict subset.
    // hidden:true drops it from tools/list while it stays a full catalog
    // member for dispatch + boundary validation + family membership — any
    // legacy caller (alias, hook-less agent) still resolves. Merge target is
    // the advertised survivor file_outline (see tool-mechanism-map.ts).
    hidden: true,
    active:
      "All entities in a file — functions, classes, types, exports — structured.",
    locked:
      "[locked, unlock: large-file truncation] All entities in a file. Use file_outline first.",
    unlocked:
      "All entities in a file with line ranges and kinds. Use after file_read truncates on a large file.",
  },
  review_changes: {
    tier: 2,
    // Demoted (Sprint 10): the review engine already fires automatically (the
    // commit gate + in-flight pre-edit review) and is available on demand as the
    // `unerr review` CLI command, so the manual MCP call is rarely the right path.
    // hidden:true drops it from tools/list while it stays a full catalog member
    // for dispatch + boundary validation + family membership. No agent-facing
    // instruction surface names review_changes as a tool-to-call (README catalog
    // line updated in Sprint 12).
    hidden: true,
    active:
      "Run the full review engine over staged changes (or scope:'range', range:'A..B') and return findings grouped by file/entity, each with evidence and a pasteable action. Call after edits to catch breaks before commit.",
    locked:
      "[locked, unlock: after edits] On-demand review of staged changes. Edit a file first.",
    unlocked:
      "Review staged changes (or scope:'range', range:'A..B') with the full engine — findings grouped by file/entity with evidence and a fix action.",
  },

  // ── Tier 3 — intent unlock ─────────────────────────────────────────────
  mark_intent: {
    tier: 3,
    // Demoted (Sprint 11, 6-write merge): markers ride a closing-message
    // `unerr-save: intent <…>` sentinel scraped by the Stop hook (see
    // sentinel-persist.ts, which routes the scrape to this tool over UDS).
    // hidden:true drops it from tools/list while it stays a full catalog member
    // for that dispatch + boundary validation + family membership. The advertised
    // high-fidelity escape is unerr_track({op:'intent'}). No agent-facing
    // instruction surface names mark_intent any more (rewritten in Sprint 11).
    hidden: true,
    active:
      "REQUIRED first on coding tasks (implement/fix/refactor/build). 1 terse sentence. Skip only for read-only questions. Powers resume strip.",
    locked:
      "[locked, unlock: first non-trivial action] REQUIRED first on coding tasks. 1 terse sentence.",
    unlocked:
      "REQUIRED first on coding tasks. 1 terse sentence. One per task; powers turn titles + cross-session resume.",
  },
  mark_decision: {
    tier: 3,
    // Demoted (Sprint 11, 6-write merge): rides a `unerr-save: decision <…>`
    // sentinel; advertised escape is unerr_track({op:'decision'}). See mark_intent
    // note above. Stays a full catalog member for dispatch + validation + family.
    hidden: true,
    active:
      "Record a deliberate choice between alternatives (1-2 sentences, ≤1400 chars). Optional list of considered alternatives.",
    locked:
      "[locked, unlock: after mark_intent] Record a deliberate choice between alternatives.",
    unlocked:
      "Record a deliberate choice (1-2 sentences, ≤1400 chars). Optional alternatives list (≤5, each ≤80 chars). Surfaces in timeline.",
  },
  mark_blocker: {
    tier: 3,
    // Demoted (Sprint 11, 6-write merge): rides a `unerr-save: blocker <…>`
    // sentinel. When the resolution needs the returned marker_id, use the
    // advertised escape unerr_track({op:'blocker'}). See mark_intent note above.
    hidden: true,
    active:
      "Record an unresolved obstacle (1-2 sentences, ≤1400 chars). Returned marker_id is required by mark_resolution when fixed.",
    locked:
      "[locked, unlock: after mark_intent] Record an unresolved obstacle.",
    unlocked:
      "Record an obstacle (1-2 sentences, ≤1400 chars). Returned marker_id must be passed to mark_resolution when fixed. Surfaces in resume.",
  },
  mark_resolution: {
    tier: 3,
    // Demoted (Sprint 11, 6-write merge): rides a `unerr-save: resolution <…>`
    // sentinel; advertised escape is unerr_track({op:'resolution', blocker_ref:'<marker_id>', text:'<fix>'}).
    // See mark_intent note above. Stays dispatchable for the sentinel-persist UDS path.
    hidden: true,
    active:
      "Resolve a prior blocker. blocker_ref is the marker_id from mark_blocker; text describes the fix.",
    locked: "[locked, unlock: after mark_blocker] Resolve a prior blocker.",
    unlocked:
      "Resolve a prior blocker. blocker_ref is the marker_id from mark_blocker. Text (1-3 sentences, ≤1400 chars) describes the fix.",
  },
  recall_facts: {
    tier: 3,
    // Demoted (Sprint 11, 6-write merge): folded into unerr_track({op:'recall'}),
    // which routes to recall_facts's handler (see OP_TO_TOOL in unerr-track.ts).
    // Facts also reach the agent passively via ur|fct lines + the unerr_context
    // recon bundle. hidden:true drops it from tools/list while it stays a full
    // catalog member for dispatch + validation + family membership. No agent-
    // facing instruction surface names recall_facts any more (rewritten to
    // unerr_track({op:'recall'}) / ur|fct in Sprint 11).
    hidden: true,
    active:
      "Recall stored facts for a file, entity, or 'project' scope with decay-adjusted confidence.",
    locked:
      "[locked, unlock: editing prior-modified file] Recall stored facts.",
    unlocked:
      "Recall stored facts for a scope with decay-adjusted confidence. fact_type filters; rotation:'decay' rotates top-N across calls.",
  },
  record_fact: {
    tier: 3,
    // Demoted (Sprint 11, 6-write merge): folded into unerr_track({op:'fact'}),
    // which routes to record_fact's handler (see OP_TO_TOOL in unerr-track.ts).
    // hidden:true drops it from tools/list while it stays a full catalog member
    // for dispatch + boundary validation + family membership — any legacy/hook-
    // less caller still resolves. No agent-facing instruction surface names
    // record_fact any more (rewritten to unerr_track({op:'fact'}) in Sprint 11);
    // unerr_remember stays advertised for user-sourced facts.
    hidden: true,
    active:
      "Record a fact (procedural/semantic/negative/convention) scoped to a file, entity, or project. Persists cross-session.",
    locked:
      "[locked, unlock: after mark_decision] Record a project fact cross-session.",
    unlocked:
      "Record a fact: procedural, semantic, negative, or convention. scope = file path, entity key, or 'project'. Persists cross-session.",
  },
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

/** The demoted tool names — in the catalog, never advertised. */
export function hiddenToolNames(): readonly string[] {
  return selectHidden(TIER_ENTRIES);
}

/**
 * Agent-aware hidden set (Sprint 7 keystone). Returns the names dropped from
 * `tools/list` for an agent with capability profile `caps`: the unconditional
 * `hidden` tools PLUS every `hiddenForHookCap` tool whose gating capability the
 * agent possesses. A hook-less agent (all caps false) gets back exactly the
 * unconditional set — its MCP fallbacks stay advertised, so no regression.
 * Pure + generic for unit testing against synthetic tables.
 */
export function selectHiddenForCaps<
  T extends { hidden?: boolean; hiddenForHookCap?: HookCapKey },
>(entries: Readonly<Record<string, T>>, caps: HookCapProfile): string[] {
  return Object.entries(entries)
    .filter(
      ([, e]) =>
        e.hidden === true ||
        (e.hiddenForHookCap !== undefined && caps[e.hiddenForHookCap] === true)
    )
    .map(([name]) => name)
    .sort();
}

/**
 * Advertised names for an agent with capability profile `caps` — the full
 * catalog minus {@link selectHiddenForCaps}. The agent-aware advertisement
 * surface; pair with {@link listToolNames} (the full, validation-driving set).
 */
export function advertisedToolNamesForCaps(
  caps: HookCapProfile
): readonly string[] {
  const hidden = new Set(selectHiddenForCaps(TIER_ENTRIES, caps));
  return Object.keys(TIER_ENTRIES)
    .filter((name) => !hidden.has(name))
    .sort();
}

/** The agent-aware demoted set for capability profile `caps`. */
export function hiddenToolNamesForCaps(
  caps: HookCapProfile
): readonly string[] {
  return selectHiddenForCaps(TIER_ENTRIES, caps);
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
