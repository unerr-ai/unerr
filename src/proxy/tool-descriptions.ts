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
 * Call `await validateAllToolDescriptions()` once (proxy startup, the CI
 * gate, or a test's setup) to assert every entry meets its budget. A new
 * description that exceeds the cap throws and is caught by the CI gate.
 */

import { type BudgetKey, enforceBudget, warmTokenizer } from "./tool-budget.js";

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
 * The MCP catalog — the tools the model sees in `tools/list`:
 *   search_code, file_read, file_edit, get_references, fetch_url.
 *
 * `file_outline` is demoted (`hidden: true`, 2026-07): its structural view is
 * now a mode of file_read (`file_read({file_path, outline:true})`), so its own
 * schema no longer rides `tools/list`. It stays a full catalog member (tier 1,
 * dispatchable by name, validated, family-tagged) and `buildFileOutline`
 * remains a direct internal import.
 *
 * `get_references` moved to tier 2 (2026-07): the everyday "who calls this"
 * need is served by file_read entity mode (top-10 callers) and the file_edit
 * response's at-risk-caller line, so get_references is the deep escalation —
 * it stays advertised but shows a locked placeholder until an edit is attempted
 * or a fan_in ≥ 5 entity is observed (see UNLOCK_CONDITIONS in tool-tiers.ts).
 *
 * `unerr_track` and the mark_* marker tools were removed entirely (2026-07).
 *
 * Everything else the proxy can dispatch is NOT a catalog member. Those names
 * (get_entity, get_conventions, unerr_context, get_imports,
 * unerr_turn_summary) stay reachable ONLY by name — the
 * proxy's by-name dispatch switch matches them regardless of catalog
 * membership — because a Claude Code lifecycle hook (UDS `tools/call`), a
 * task-shaped `search_code` (which re-targets to the `unerr_context` recon
 * composite), or an `unerr exec`/`unerr review` CLI calls them internally.
 * They are absent from `tools/list`, so no agent ever sees them and they cost
 * zero context. Their required-field validation lives where the caller is
 * (runBoundaryValidation no-ops for any name not in TOOL_DEFINITIONS).
 * Full rationale: `.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md` §10.
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
      "Find code by name OR task. A bare symbol ('QueryRouter.dispatch') → ranked matches, <5ms. A task phrase ('where is retry handled') → a recon bundle: focus body + callers (blast radius) + entities + conventions in ONE call, skipping the fan-out. detail:true → ONE entity profile; include_body adds source; want:['callers','callees','imports'] attaches refs.",
    locked: "[tier 1 — always exposed]",
  },
  // file_outline demoted (`hidden: true`, 2026-07): its structural view is now
  // a mode of file_read (`file_read({file_path, outline:true})`), which calls
  // `buildFileOutline` internally. It stays a full catalog member (tier 1,
  // dispatch, validation, family) — only dropped from the `tools/list` surface.
  file_outline: {
    tier: 1,
    hidden: true,
    active:
      "Structural outline of a file — entities, imports, exports, line ranges. Call before reading large files; pair with file_read entity param.",
    locked: "[tier 1 — always exposed]",
  },
  file_read: {
    tier: 1,
    active:
      "Read a file as plain numbered lines: {file_path} = whole file (budget-capped); {file_path, offset, limit} = a line range; {file_path, outline:true} = structural view. Large file or one function — pass {file_path, entity:'<name>'} for body + callers only.",
    locked: "[tier 1 — always exposed]",
  },
  file_edit: {
    tier: 1,
    active:
      "Change a file — the unerr edit/write path, no built-in Read needed first. Pass old_string+new_string for an exact replacement (unique unless replace_all:true), or content to create/overwrite the whole file. Pass base_hash from the file_read you based the edit on to reject if the file changed.",
    locked: "[tier 1 — always exposed]",
  },
  // get_entity merged into search_code({detail:true}) 2026-06 — executor
  // retained in QueryRouter, dispatched by name only (see roster above).
  // get_references moved to tier 2 (2026-07): the everyday "who calls this" is
  // served by file_read entity mode (top-10 callers) + the file_edit at-risk-
  // caller line, so get_references is the deep escalation — advertised, but
  // locked until an edit is attempted, a fan_in ≥ 5 entity is observed, OR a
  // file_read completes (read-only sessions unlock too)
  // (UNLOCK_CONDITIONS.get_references =
  // C.or(C.editOrWrite(), C.fanIn(5), C.firstRead())).
  get_references: {
    tier: 2,
    active:
      "Find callers or callees of an entity across the codebase. Pass direction:'callers' (default) or 'callees'. Catches indirect refs grep misses.",
    locked:
      "[locked, unlock: edit, read, or fan_in ≥5] deep caller/callee graph beyond file_read's top-10 callers.",
    unlocked:
      "Full caller or callee list for an entity. direction:'callers' (default) or 'callees'. include_text_occurrences:true adds string/config/comment hits for a rename. Catches indirect refs grep misses.",
  },
  fetch_url: {
    tier: 1,
    active:
      "Fetch one page (url) or many (urls:[...], parallel + ranked across pages, ONE roundtrip) → DOM-extracted markdown passages. Strips chrome, splits by heading, BM25-ranks when prompt set, caches by hash. Pass a search's result URLs as urls:[...]. Replaces WebFetch — 5–10× fewer tokens.",
    locked: "[tier 1 — always exposed]",
  },
  // unerr_remember left the catalog (2026-06) and the handler was removed
  // entirely (2026-07): user rules are no longer captured.
  // unerr_context merged into search_code (2026-06): a task-shaped search_code
  // query now returns the recon bundle. The handler (handleUnerrContextProxy)
  // is retained and dispatched BY NAME over UDS for the recall path and the
  // `unerr recon` CLI — same de-advertise pattern as get_entity/unerr_remember.
  // unerr_track and the mark_* marker tools were removed entirely — no catalog entry,
  // no dispatch, no family membership.
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
      `Tool "${toolName}" has no "${state}" description. Tier 1 tools have no meaningful 'locked' state; tier 1 tools have no 'unlocked' state.`
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
 * The demoted tool names — in the catalog, never advertised. Currently
 * `["file_outline"]` (folded into file_read outline mode, demoted 2026-07).
 * Kept (rather than inlined to a constant) so the advertisement/validation
 * split stays a single, testable partition: any future tool marked `hidden`
 * is honoured by every consumer automatically.
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

// ── Explicit validation ────────────────────────────────────────────────────
//
// Every (tool, state) pair is validated against its budget. A description
// that exceeds its cap throws — callers are the proxy startup path, the CI
// gate (scripts/check-tool-budget.ts), and any test that used to rely on
// module-load-time validation. Not run at import time: `warmTokenizer()`
// loads `gpt-tokenizer`, which must not pay its cost on every `unerr`
// invocation, only when validation is actually requested.
//
// Additionally, we assert that every tier 2/3 entry has an `unlocked` field
// (it is optional in the type to allow tier 1 entries to omit it cleanly).

export async function validateAllToolDescriptions(): Promise<void> {
  await warmTokenizer();
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
}
