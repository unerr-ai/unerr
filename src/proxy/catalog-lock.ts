/**
 * Tool-catalog lock — the advertised `tools/list` payload is a CONSTANT.
 *
 * WHY THIS EXISTS
 *
 * The tool schemas an MCP server advertises sit immediately after the system
 * prompt in the provider's cache prefix. Prompt caching is exact-prefix: change
 * one byte in the `tools` block and every token after it is re-billed as a
 * cache WRITE. Measured on one real session (`.internal/docs/04-telemetry-
 * insights/04-WHERE-TOKENS-CAN-BE-REDUCED.md` §5): an 87-second gap — far too
 * short to be cache TTL expiry — rebuilt 199,122 tokens of context and cost
 * $1.24. Nine cache-write events of >=30k tokens were 65.7% of that session's
 * whole cache-write bill. The rule that came out of it: anything that mutates
 * the system prompt or the tool list mid-session costs one full context
 * rewrite.
 *
 * Before this module, unerr had THREE different answers to `tools/list`:
 *
 *   A. bridge (`bridge-catalog.ts`, pre-connect + 3s timeout fallback)
 *        → ADVERTISED_TOOL_DEFINITIONS, name-sorted, "active" descriptions.
 *   B. proxy UDS handler (`proxy.ts`, the path a bridged IDE actually hits)
 *        → getAdvertisedTools(); equals A today, but grows by 4 or 8 entries
 *          whenever the deep-dive project state is not "none".
 *   C. proxy stdio handler (`proxy.ts`, standalone mode)
 *        → the same list run through `renderToolsListForExposure` (tier-2
 *          `get_references` renders its LOCKED placeholder until an edit or a
 *          read unlocks it, then flips to the active text mid-session) and
 *          then through `reorderToolsByCluster`, whose order is a function of
 *          how many times each cluster has been called THIS SESSION.
 *
 * A and C disagree on both order and on the `get_references` description, and
 * C disagrees with itself after the third tool call. Every one of those
 * disagreements is a full-prefix rewrite for whoever re-lists.
 *
 * THE GUARD
 *
 * `lockAdvertisedCatalog` is the single choke point every `tools/list`
 * emission goes through. It always returns {@link CANONICAL_TOOLS} — the same
 * frozen array the bridge serves — so the wire answer is a pure function of
 * module-load state. When the caller's candidate list differs, the difference
 * is REFUSED (canonical is served anyway) and named on stderr once per distinct
 * drift signature.
 *
 * Stateless on purpose. A per-session "pin the first answer" cache was
 * considered and rejected: (1) one proxy process serves many IDE sessions
 * across bridge reconnects and warm restarts, so "the session" has no single
 * boundary on the proxy side; (2) the bridge can never observe a value the
 * proxy pinned, so pinning cannot fix the bridge/proxy split at all; (3) a
 * mutable pin is itself a thing that can go stale and become a new churn
 * source. A constant cannot drift.
 *
 * Size is NOT enforced here. At runtime there is nothing useful to do about an
 * oversized catalog except refuse to serve, which is worse than serving. The
 * bound is a build-time gate — see `src/__tests__/tool-catalog-lock.test.ts`.
 */

import { createHash } from "node:crypto";
import { startupLog } from "../utils/startup-log.js";
import {
  ADVERTISED_TOOL_DEFINITIONS,
  type ToolDefinition,
} from "./tool-definitions.js";

/**
 * Number of tools unerr advertises. Pinned, not derived — a 6th tool must be a
 * deliberate edit here and in `tool-descriptions.ts`, never a side effect.
 */
export const MAX_ADVERTISED_TOOLS = 5;

/**
 * Ceiling on `JSON.stringify(CANONICAL_TOOLS).length`. Today: 9,323 chars
 * (~2,331 tokens).
 *
 * WHY A BOUND EXISTS AT ALL: Claude Code auto-defers an MCP server's tool
 * schemas behind its Tool Search bridge once they exceed roughly 10% of the
 * context window — ~20,000 tokens (~80,000 chars) on a 200k window. A deferred
 * schema is not in the prefix at session start; it loads MID-SESSION on first
 * use, which is exactly the mutation class this module exists to prevent. The
 * earlier `alwaysLoad` fix cut unerr's session tax from +75% to +15% precisely
 * by stopping mid-session tool loading; crossing the defer line would undo it.
 *
 * 12,000 leaves ~29% room to retune the five existing descriptions while
 * staying an order of magnitude under the defer line. It is a tripwire, not a
 * target: hitting it means someone added surface, and that needs a decision,
 * not a bumped constant.
 */
export const MAX_CATALOG_SERIALIZED_CHARS = 12_000;

/** Deep-freeze so no caller can mutate the canonical answer in place. */
function freezeCatalog(
  tools: readonly ToolDefinition[]
): readonly ToolDefinition[] {
  for (const tool of tools) {
    Object.freeze(tool.inputSchema);
    Object.freeze(tool.annotations);
    Object.freeze(tool);
  }
  return Object.freeze([...tools]);
}

/**
 * The one advertised catalog. Identical object graph to the array
 * `bridge-catalog.ts` serves, so bridge and proxy agree by construction rather
 * than by coincidence.
 */
export const CANONICAL_TOOLS: readonly ToolDefinition[] = freezeCatalog(
  ADVERTISED_TOOL_DEFINITIONS
);

/** Serialized form — the bytes that land in the cache prefix. */
export const CANONICAL_TOOLS_JSON: string = JSON.stringify(CANONICAL_TOOLS);

/** Serialized length in characters. Compared against MAX_CATALOG_SERIALIZED_CHARS in CI. */
export const CANONICAL_TOOLS_CHARS: number = CANONICAL_TOOLS_JSON.length;

/** Short content hash — printed in drift warnings so two logs can be compared. */
export const CANONICAL_TOOLS_SHA256: string = createHash("sha256")
  .update(CANONICAL_TOOLS_JSON, "utf8")
  .digest("hex")
  .slice(0, 16);

/**
 * Shape the lock compares. `inputSchema` / `annotations` are typed `unknown`
 * because the lock only round-trips them through `JSON.stringify` — it reports
 * that they changed, never what they mean.
 */
export interface CatalogEntryLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
}

/**
 * Name every way `candidate` differs from {@link CANONICAL_TOOLS}, or null when
 * it is byte-identical. Concrete names only — a drift report that says "the
 * catalog changed" is not actionable.
 */
export function describeCatalogDrift(
  candidate: readonly CatalogEntryLike[]
): string | null {
  if (JSON.stringify(candidate) === CANONICAL_TOOLS_JSON) return null;

  const canonicalNames = CANONICAL_TOOLS.map((t) => t.name);
  const candidateNames = candidate.map((t) => t.name);
  const canonicalSet = new Set(canonicalNames);
  const candidateSet = new Set(candidateNames);

  const parts: string[] = [];

  const added = candidateNames.filter((n) => !canonicalSet.has(n));
  if (added.length > 0) parts.push(`added: ${added.join(", ")}`);

  const removed = canonicalNames.filter((n) => !candidateSet.has(n));
  if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`);

  if (
    added.length === 0 &&
    removed.length === 0 &&
    candidateNames.join(",") !== canonicalNames.join(",")
  ) {
    parts.push(
      `reordered: ${candidateNames.join(",")} != ${canonicalNames.join(",")}`
    );
  }

  const byName = new Map(CANONICAL_TOOLS.map((t) => [t.name, t]));
  const retexted = candidate
    .filter((t) => {
      const canonical = byName.get(t.name);
      return canonical !== undefined && canonical.description !== t.description;
    })
    .map((t) => t.name);
  if (retexted.length > 0) {
    parts.push(`description changed: ${retexted.join(", ")}`);
  }

  if (parts.length === 0) {
    // Same names, same order, same descriptions — the difference is in
    // inputSchema or annotations. Still a prefix-busting byte change.
    parts.push("inputSchema/annotations changed");
  }

  return parts.join("; ");
}

/**
 * Distinct drift signatures already reported this process. Logging-only — it
 * has no effect on the bytes returned, so the lock stays a pure function of
 * module-load state. Capped so a pathological caller cannot grow it without
 * bound.
 */
const reportedDrift = new Set<string>();
const MAX_REPORTED_DRIFT_SIGNATURES = 8;

/**
 * Return the catalog to put on the wire.
 *
 * Always {@link CANONICAL_TOOLS}. When `candidate` differs, the difference is
 * refused and named once per distinct signature via `startupLog.warn`
 * (stderr + `.unerr/logs/events.jsonl`; stdout stays JSON-RPC only).
 */
export function lockAdvertisedCatalog(
  candidate: readonly CatalogEntryLike[]
): ToolDefinition[] {
  const drift = describeCatalogDrift(candidate);
  if (drift !== null && !reportedDrift.has(drift)) {
    if (reportedDrift.size < MAX_REPORTED_DRIFT_SIGNATURES) {
      reportedDrift.add(drift);
    }
    startupLog.warn(
      `tools/list drift refused — served the pinned ${MAX_ADVERTISED_TOOLS}-tool catalog (sha ${CANONICAL_TOOLS_SHA256}) instead. ${drift}`
    );
  }
  return [...CANONICAL_TOOLS];
}

/** Test hook: clear the per-process drift-report dedup. */
export function resetCatalogDriftReporting(): void {
  reportedDrift.clear();
}
