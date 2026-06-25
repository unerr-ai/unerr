/**
 * Query Router — executes local tool calls against CozoDB graph.
 *
 * All tools are local: graph queries + rules + business context answered sub-5ms.
 *
 * Features:
 *   - Drift overlay merge: overlay entities replace/augment base graph results
 *   - Drift injection: branch context + entity drift status attach to the internal
 *     `meta.drift` carrier and surface as a `ur|ctx` prefix line on every response
 *     (MCP clients filter `_meta` envelopes, so signals must ride inline in the body)
 *   - get_business_context, get_conventions: from justifications/patterns
 */

import {
  enforceBudget,
  isStructuredContent,
} from "../proxy/budget-enforcer.js";
import {
  recordCacheRetrieve,
  resolveCacheRef,
} from "../proxy/cache-retrieve.js";
import type {
  CompressionQualityMonitor,
  ContentType,
} from "../proxy/compression-quality-monitor.js";
import type { ContextRotDetector } from "../proxy/context-rot-detector.js";
import type { EfficiencyTracker } from "../proxy/efficiency-tracker.js";
import { formatToolOutput } from "../proxy/format-encoder.js";
import {
  type EntityRiskInfo,
  compressOutput,
} from "../proxy/output-compressor.js";
import type { RouterGateway } from "../proxy/router-gateway.js";
import type { SessionDedup } from "../proxy/session-dedup.js";
import { createSessionLegendTracker } from "../proxy/session-legend.js";
import type { SessionEvents } from "../proxy/session-stats.js";
import { getSharedReversibleCache } from "../proxy/shared-cache.js";
import type { TokenCounter } from "../proxy/token-counter.js";
import type { BehaviorEventWriter } from "../tracking/behavior-events.js";
import type { BranchContext } from "../tracking/branch-context.js";
import type { DriftTracker } from "../tracking/drift-tracker.js";
import { revertEntity } from "../tracking/entity-rewind.js";
import type { PendingViolationStore } from "../tracking/pending-violations.js";
import type { PersistenceEffectivenessTracker } from "../tracking/persistence-effectiveness.js";
import { emitSavingsEvent } from "../tracking/savings-events.js";
import type { TokenFlowWriter } from "../tracking/token-flow.js";
import { formatUnknownError } from "../utils/format-error.js";
import type { BackgroundIndexer } from "./background-indexer.js";
import {
  MAX_SCAN_FILE_BYTES,
  type ScanAccumulator,
  compilePattern,
  scanFileInto,
} from "./content-search.js";
import { readEntityBodyLines } from "./entity-source.js";
import {
  type WorkspacePeerResult,
  mergeWorkspaceResults,
} from "./federation/merge.js";
import type {
  CozoGraphStore,
  DriftEntity,
  LocalEntity,
} from "./local-graph.js";
import type { evaluateRules as EvaluateRulesFn } from "./rule-evaluator.js";
import { tokenize } from "./search-index.js";
import {
  attachAnnotations,
  fetchActiveDomainTags,
  fetchVocabularyNudges,
} from "./semantic/annotation-indexer.js";
import { SessionContext } from "./session-context.js";
import type { createSessionHealthMonitor } from "./session-health-monitor.js";
import { smartTruncate, truncateResultList } from "./smart-truncate.js";
import { estimateTokens } from "./token-estimator.js";

export type ToolSource = "local";

export type ProxyMode = "local" | "parse" | "setup";

/**
 * Resolve `search_code` profile mode (`detail` / `include_body` / `want`) to the
 * internal `get_entity` executor, carrying `query` over as `key`. Shared by the
 * public `execute()` path and `executeRaw()` (the in-process recon runner) so
 * the two can never diverge — `executeLocal` dispatches purely on tool name, so
 * an un-translated `search_code{detail:true}` would hit the list search (rows,
 * no body) instead of the single-entity profile. Pure: returns the resolved
 * tool name + args, mutating nothing.
 */
function resolveProfileTool(
  toolName: string,
  args: Record<string, unknown>
): { toolName: string; args: Record<string, unknown> } {
  if (
    toolName === "search_code" &&
    (args.detail === true ||
      args.include_body === true ||
      (Array.isArray(args.want) && args.want.length > 0))
  ) {
    const next =
      args.key === undefined && args.query !== undefined
        ? { ...args, key: args.query }
        : args;
    return { toolName: "get_entity", args: next };
  }
  return { toolName, args };
}

/**
 * Tool registry: all tools run locally against CozoDB.
 */
const LOCAL_TOOLS = new Set([
  "get_function",
  "get_class",
  "get_entity", // consolidated: replaces get_function + get_class
  "get_callers",
  "get_callees",
  "get_references", // consolidated: replaces get_callers + get_callees
  "get_imports",
  "search_code",
  "get_conventions",

  // Sprint 11: Phase 22 Blueprint Deep Dive tools (disabled — no tool-definitions wired)
  // "unerr_get_plan_context",
  // "unerr_get_next_slice",
  // "unerr_check_boundary",
  // "unerr_get_design_system",
  // "unerr_get_next_task",
  // "unerr_complete_task",
  // "unerr_get_sprint_context",
  // "unerr_get_checkpoint_status",

  // Sprint FE-B: file read protocol
  "file_outline",
  "file_read",

  // Sprint FU-1: web fetch
  "fetch_url",
]);

/**
 * Pagination-capable tools that accept an optional `cache_ref` to pull a
 * withheld slice back from the reversible cache (T1.5). fetch_url is handled in
 * its own Tool.execute (it does not route through executeLocal).
 */
const CACHE_REF_TOOLS = new Set(["search_code", "get_references", "file_read"]);

/**
 * Tools whose `scope:'workspace'` fans the SAME query out to sibling repos and
 * merges results (CROSS_REPO_INTELLIGENCE Sprint 3). `search_code` only — its
 * query string is meaningful in every repo. `get_references` can't fan out a
 * raw key (keys are repo-local); it takes the Sprint 4 moniker path instead.
 * `unerr_context` federates in its own proxy handler; `file_read` uses implicit
 * path routing rather than a fan-out merge.
 */
const WORKSPACE_FANOUT_TOOLS = new Set(["search_code"]);

/**
 * Path-bearing tools eligible for implicit cross-repo routing: a path that
 * resolves outside the home repo is served by the sibling repo that owns it.
 */
const PATH_ROUTED_TOOLS = new Set(["file_read", "file_outline"]);

export interface EntityRiskMeta {
  fan_in: number;
  fan_out: number;
  risk_level: string;
  /**
   * Optional scope override for the `ur|rsk` dedup key. When a `get_references`
   * query returns a high-risk caller/callee, this is the *referenced* entity's
   * key (not the queried entity), so each new max-risk ref re-fires the signal
   * instead of being suppressed by `on_change` dedup against the queried key.
   */
  entity_key?: string;
}

export interface DriftMeta {
  /** Entity's drift status: "added" | "modified" | "deleted" | null */
  entityStatus: string | null;
  /** Current branch name */
  branch: string;
  /** Commits ahead of base */
  commitsAhead: number;
  /** Intent ID that last modified this entity */
  lastModifiedBy: string | null;
  /** Whether entity was deleted locally */
  deletedLocally?: boolean;
}

export interface AutoCheckResult {
  /** Number of rules passed */
  passed: number;
  /** Violations found */
  violations: Array<{ rule: string; message: string; file_path: string }>;
}

// ── Sprint 2: Enrichment Envelope ──────────────────────────────────

/** Machine-readable blast radius metadata carried on internal `meta`; surfaces as `ur|rsk` prefix line. */
export interface BlastRadiusMeta {
  direct_callers: number;
  direct_callees: number;
  transitive_depth2: number;
  is_chokepoint: boolean;
  /** Sprint 3.1: Affected entities with depth from N-hop traversal. */
  affected_entities?: Array<{
    key: string;
    name: string;
    file: string;
    depth: number;
  }>;
}

/** Community metadata carried on internal `meta` (Leapfrog Sprint A). */
export interface CommunityMeta {
  id: number;
  label: string;
  size: number;
  cohesion: number;
  /**
   * Layer 8 §6 (SC-D.3): the dominant domain this community votes for, with the
   * vote's purity (0–1). Present when the community carries a `community_domains`
   * row. Lets the dashboard + digests name a community by its domain instead of
   * a bare cluster ID.
   */
  domain?: string;
  domain_purity?: number;
}

/** Cross-community edge metadata carried on internal `meta` (Leapfrog Sprint A). */
export interface CrossCommunityEdgeMeta {
  entity_key: string;
  entity_name: string;
  entity_community_label: string;
  relation: string;
}

/** Convention adherence metadata carried on internal `meta`; surfaces as `ur|fct` prefix lines. */
export interface ConventionMeta {
  name: string;
  adherence_pct: number;
  rule: string;
}

/** Health context metadata carried on internal `meta`; surfaces as `ur|ctx` prefix line when degraded. */
export interface HealthContextMeta {
  contributes_to_issues: string[];
  entity_risk_level: "low" | "medium" | "high";
}

/**
 * Agent-readable context hints. Injected as `_context` on every response.
 * The AI agent uses these to provide architecturally-aware suggestions.
 *
 * Task 6.8: Field order matters — "Lost in the Middle" research shows LLMs
 * attend more to the beginning and end of context. Critical fields (blast
 * radius, violations, drift alerts) are placed first; informational fields
 * (conventions, patterns) are placed last. See `orderContextFields()`.
 */
export interface ContextHints {
  // ── NEW: Ranked signal output (Three-Layer Experience System) ──
  /** Ranked intelligence signals — replaces individual fields in _context output */
  signals?: import("./signal-scorer.js").IntelligenceSignal[];
  /** Decision point level — determines signal count and burst multipliers */
  decision_point?: import("./signal-scorer.js").DecisionLevel;
  /** Average confidence across delivered signals */
  confidence?: number;

  // ── One-time injections (not converted to signals) ──
  /** Session greeting (first MCP response only) */
  session_greeting?: string;
  /** S7.4: Structured session resume context (first response after resumed session) */
  session_resume?: {
    summary: string;
    filesModified: string[];
    incompleteEntities: string[];
  };
  /** Sprint 4: Structured session brief (replaces flat greeting + resume on first call) */
  session_brief?: import("./session-brief-builder.js").SessionBrief;
  /** Tool adoption hint — reminds agent to use unerr tools instead of built-ins (first call only) */
  tool_adoption?: { hint: string; tools_available: number };
  /** Running value counter: "unerr has caught 6 issues this session" */
  value_counter?: string;

  // ── Internal: populated during gathering, converted to signals before output ──
  /** Human-readable blast radius: "14 callers, 38 transitive dependents" */
  blast_radius?: string;
  /** Push-based rule violations detected by file watcher (Task 7.3) */
  pending_violations?: Array<{
    file: string;
    rule: string;
    message: string;
    line?: number;
  }>;
  /** Drift warning: "WARNING: modified 3 min ago, 2 callers may be affected" */
  drift_alert?: string;
  /** Leapfrog Sprint B: Learned correction warnings from shadow ledger analysis */
  corrections?: string[];
  /** Post-compaction reminder: brief summary of previously-queried entity's critical data */
  reminder?: string;
  /** Community context: cluster label, cohesion, cross-community connections */
  community?: string;
  /** Convention descriptions with adherence rates */
  conventions?: string[];
  /** Architectural issues related to this entity */
  related_issues?: string[];
  /** S7.5: Durability warnings for fragile entities */
  durability_warning?: string;
  /** S7.6: Anti-pattern warnings from negative knowledge */
  anti_patterns?: string[];
  /** Q.1: Causal bridge — recent interaction history for entity */
  history?: string[];
  /** Q.3: Learned conventions from correction patterns */
  learned_conventions?: string[];
  /** Q.1: Prompt strategy recommendations based on durability profiles */
  prompt_strategy?: string[];
  /** Sprint 1.2: Relevant facts from temporal memory (visible to agents) */
  relevant_facts?: string[];
  /** Sprint 3.2: Co-change prediction from GraphTemporalJoiner */
  co_changes?: string;
  /** Sprint 6: Hidden coupling warning from GraphTemporalJoiner */
  hidden_coupling?: string;
}

/**
 * Legacy: Order context fields by priority for optimal LLM attention.
 * Kept for backward compat with session dedup filter which operates on ContextHints.
 */
export function orderContextFields(ctx: ContextHints): ContextHints {
  const ordered: ContextHints = {};
  if (ctx.blast_radius !== undefined) ordered.blast_radius = ctx.blast_radius;
  if (ctx.pending_violations !== undefined)
    ordered.pending_violations = ctx.pending_violations;
  if (ctx.drift_alert !== undefined) ordered.drift_alert = ctx.drift_alert;
  if (ctx.durability_warning !== undefined)
    ordered.durability_warning = ctx.durability_warning;
  if (ctx.anti_patterns !== undefined)
    ordered.anti_patterns = ctx.anti_patterns;
  if (ctx.corrections !== undefined) ordered.corrections = ctx.corrections;
  if (ctx.session_resume !== undefined)
    ordered.session_resume = ctx.session_resume;
  if (ctx.reminder !== undefined) ordered.reminder = ctx.reminder;
  if (ctx.community !== undefined) ordered.community = ctx.community;
  if (ctx.conventions !== undefined) ordered.conventions = ctx.conventions;
  if (ctx.relevant_facts !== undefined)
    ordered.relevant_facts = ctx.relevant_facts;
  if (ctx.co_changes !== undefined) ordered.co_changes = ctx.co_changes;
  if (ctx.hidden_coupling !== undefined)
    ordered.hidden_coupling = ctx.hidden_coupling;
  if (ctx.related_issues !== undefined)
    ordered.related_issues = ctx.related_issues;
  if (ctx.session_greeting !== undefined)
    ordered.session_greeting = ctx.session_greeting;
  if (ctx.value_counter !== undefined)
    ordered.value_counter = ctx.value_counter;
  return ordered;
}

/**
 * Three-Layer Experience System: Assemble final _context output.
 *
 * Converts raw gathered context fields into ranked IntelligenceSignals,
 * preserving one-time injections (greeting, resume, tool_adoption, value_counter)
 * as separate fields.
 *
 * Replaces the flat 15-field dump with max N ranked signals + decision_point.
 */
export async function assembleContextOutput(
  raw: ContextHints,
  toolName: string,
  args: Record<string, unknown>,
  decisionLevel: import("./signal-scorer.js").DecisionLevel = "medium",
  sessionContext?: SessionContext
): Promise<ContextHints> {
  const { getSignalScorer, signalId } = await import("./signal-scorer.js");
  const { getSignalDedup } = await import("../proxy/signal-dedup.js");
  const { signalTag } = await import("../proxy/response-envelope.js");
  const scorer = getSignalScorer();
  const dedup = getSignalDedup();

  // Convert internal fields to signals
  let signals = scorer.contextToSignals(raw, toolName, args);

  // Apply burst multipliers for high decision points
  signals = scorer.applyBurstMultipliers(signals, decisionLevel);

  // Determine max signals based on decision level. Capped at 2 so the visible
  // signal count never exceeds the wire-level MAX_SIGNAL_LINES, even when
  // dedup would let more through.
  const maxSignals =
    decisionLevel === "high" ? 2 : decisionLevel === "medium" ? 2 : 1;

  // Tier-3 rotational decay: pass session show-counts to ranker so signals
  // that have already surfaced N times this session get deprioritized.
  const getShowCount = sessionContext
    ? (id: string) => sessionContext.getSignalShowCount(id)
    : undefined;

  // Pre-filter via the wire-level dedup table (non-mutating peek) so already-
  // suppressed signals don't waste rank slots. Mirrors how buildSignalPrefix
  // forms the wire body: `<content>` (action is rendered separately).
  const entityKey = typeof args.entity === "string" ? args.entity : null;
  const wouldEmit = (s: import("./signal-scorer.js").IntelligenceSignal) =>
    dedup.wouldEmit(signalTag(s.type), entityKey, s.content);
  const ranked = scorer.rank(signals, maxSignals, getShowCount, wouldEmit);

  // Record each emitted signal so it decays on subsequent calls.
  if (sessionContext) {
    for (const s of ranked) {
      sessionContext.recordSignalShown(signalId(s));
    }
  }

  // Compute average confidence
  const avgConfidence =
    ranked.length > 0
      ? ranked.reduce((sum, s) => sum + s.confidence, 0) / ranked.length
      : 0;

  // Build output: signals + one-time fields
  const output: ContextHints = {};

  // Signal output (always present if we have signals)
  if (ranked.length > 0) {
    output.signals = ranked;
    output.decision_point = decisionLevel;
    output.confidence = Math.round(avgConfidence * 100) / 100;
  }

  // One-time injections pass through unchanged
  if (raw.session_greeting !== undefined)
    output.session_greeting = raw.session_greeting;
  if (raw.session_resume !== undefined)
    output.session_resume = raw.session_resume;
  if (raw.tool_adoption !== undefined) output.tool_adoption = raw.tool_adoption;
  if (raw.value_counter !== undefined) output.value_counter = raw.value_counter;

  return output;
}

export interface ToolResult {
  content: unknown;
  _meta: {
    source: ToolSource;
    /** Tool call latency in milliseconds (high-resolution) */
    latency_ms: number;
    /** Current proxy operating mode */
    mode?: ProxyMode;
    /** Human-readable reason for current mode */
    mode_reason?: string;
    /** Tools that are degraded/unavailable in current mode */
    tools_degraded?: string[];
    entity_risk?: EntityRiskMeta;
    drift?: DriftMeta;
    /** Layer 8 §5.1 (SC-C.2): stale @sem/doc annotation on the focus entity. */
    comment_drift?: {
      entityKey: string;
      name: string;
      file: string;
      line: number;
    };
    /**
     * Layer 8 §6 (SC-D.3): the focus entity sits in a low-purity Louvain
     * community — the domain vote is contested, so an edit here risks eroding
     * a domain boundary. buildSignalPrefix renders it as a `ur|rsk` line.
     */
    boundary_erosion?: {
      entityKey: string;
      domain: string;
      purity: number;
      communityId: number;
    };
    auto_check?: AutoCheckResult;
    /** Sprint 2: Blast radius metadata */
    blast_radius?: BlastRadiusMeta;
    /** Sprint 2: Top conventions for this entity */
    conventions?: ConventionMeta[];
    /** Sprint 2: Health context */
    health_context?: HealthContextMeta;
    /** Leapfrog Sprint A: Community metadata for this entity */
    community?: CommunityMeta;
    /** Leapfrog Sprint A: Cross-community edges from this entity */
    cross_community_edges?: CrossCommunityEdgeMeta[];
    /** Leapfrog Sprint A: Count of cross-community edges */
    cross_community_count?: number;
    /** Leapfrog Sprint B: Correction patterns for this entity */
    corrections?: Array<{
      entity_key: string;
      error_type: string;
      confidence: number;
      occurrences: number;
    }>;
    /** Leapfrog Sprint C: Token accounting */
    tokens_used?: number;
    tokens_budget?: number;
    truncated?: boolean;
    truncation_level?:
      | "full"
      | "signatures_and_bodies"
      | "signatures_only"
      | "metadata_only";
    full_tokens_estimate?: number;
    /** Sprint 7: True on first response after session resume (sleep/crash recovery) */
    session_resumed?: boolean;
    /** Sprint 7: Previous session summary (only on first response after resume) */
    previous_session?: { tool_calls: number; duration_minutes: number };
    /** L11.2: True when background indexing is in progress */
    indexing?: boolean;
    /** L11.2: True when results are from a partially-built graph */
    partial?: boolean;
    /** L11.2: Number of files indexed so far (during indexing) */
    indexed_files?: number;
    /** L11.2: Total files to index (during indexing) */
    total_files?: number;
    /** Layer 6 — wire shape of `content` for the agent */
    format?: "json" | "columnar" | "outline";
    /** Layer 6 FE-C: column order for `_fmt:columnar` bodies */
    columns?: string[];
    /** Layer 6 FE-E: protocol text once per session until invalidation */
    columnar_legend?: string;
    /** BA-4.3: Output format conventions (once per session until invalidation) */
    output_format_legend?: string;
    /** Sprint FE-B — large file returned outline instead of body */
    gated?: boolean;
    /** BA-4.2: All context for this entity was already delivered in this session */
    context_complete?: boolean;
    /** S9.1: Circuit breaker halt message when entity stuck in loop */
    circuit_breaker?: { entity: string; attempts: number; message: string };
    /** S2: Session health warning when health < 0.6 */
    session_health?: {
      health: number;
      recommendation: string;
      signals: string[];
    };
    /** S7.5: Entity durability score (0.0-1.0) — lower means more fragile */
    durability?: {
      score: number;
      modificationCount: number;
      avgSurvivalMs: number;
    };
    /** Q.1: Causal bridge — entity interaction history summary */
    causal_history?: {
      durability: number;
      interactions: number;
      failure_modes: string[];
    };
    /**
     * P0-3: Tier-2/3 exposure-gate status. Set to "locked" when the
     * tool call was refused by the RouterGateway because its unlock
     * condition has not yet fired. The MCP proxy wrapper reads this
     * and stamps `isError: true` on the wire frame.
     */
    gate_status?: "locked";
    /** P0-3: Tools newly unlocked by the call that produced this result. */
    unlocked_tools?: readonly string[];
    /**
     * CROSS_REPO_INTELLIGENCE Sprint 3: workspace-scoped fan-out summary —
     * how many peer repos contributed and whether any were skipped/timed-out
     * (so the result is incomplete). buildSignalPrefix renders a `ur|fct` line.
     */
    workspace?: { peers: number; partial: boolean };
    /**
     * Set when `scope:'workspace'` was requested on free tier: the upgrade nudge
     * to surface while still returning the home-only result.
     */
    workspace_refused?: string;
    /** Set when an implicit cross-repo path route served this from a peer repo. */
    routed_repo?: string;
  };
  /** Sprint 2: Agent-readable context hints */
  _context?: ContextHints;
}

/** Tools that should receive blast radius + convention enrichment. */
const ENRICHABLE_TOOLS = new Set([
  // Agent-facing tools
  "get_entity",
  "get_references",
  "get_imports",
  "search_code",
  "get_conventions",
  "file_read",
  "file_outline",
  // Router-resolved aliases (still flow through enrichResult)
  "get_function",
  "get_class",
  "get_callers",
  "get_callees",
]);

/**
 * P0-3: Prepend an unlock announcement to a tool result's content body.
 *
 * Two body shapes are observed in practice:
 *   1. A string (custom encoded format — `_fmt:columnar`, `@meta …`, etc.).
 *      The announcement is concatenated as a prefix, separator already
 *      included in `announceText` via `formatUnlockAnnounce`.
 *   2. An MCP-style `[{type:"text", text:"…"}]` array. Prepend the
 *      announcement to the first text block's text. If no text block
 *      exists, prepend a fresh one.
 *
 * For any other shape (raw object, etc.) we wrap with an MCP-style
 * text-block array carrying the announcement followed by the JSON-
 * stringified original — preserving the agent's ability to read the
 * `ur|act` line without losing structured data.
 */
function prependAnnounceToBody(
  content: unknown,
  announceText: string
): unknown {
  if (announceText.length === 0) return content;
  if (typeof content === "string") return `${announceText}${content}`;
  if (Array.isArray(content)) {
    const blocks = content as Array<
      { type?: string; text?: string } & Record<string, unknown>
    >;
    const firstTextIdx = blocks.findIndex(
      (b) => b && b.type === "text" && typeof b.text === "string"
    );
    if (firstTextIdx >= 0) {
      const existing = blocks[firstTextIdx]?.text ?? "";
      const updated = [...blocks];
      updated[firstTextIdx] = {
        ...blocks[firstTextIdx],
        type: "text",
        text: `${announceText}${existing}`,
      } as { type: "text"; text: string };
      return updated;
    }
    return [{ type: "text", text: announceText }, ...blocks];
  }
  return [
    { type: "text", text: announceText },
    { type: "text", text: JSON.stringify(content) },
  ];
}

export class QueryRouter {
  private ruleEvaluator: typeof EvaluateRulesFn | null;
  private branchContext: BranchContext | null = null;
  /** P0-3: Tier-aware exposure gateway. Null until proxy injects via `setRouterGateway`. */
  private routerGateway: RouterGateway | null = null;
  private currentMode: ProxyMode = "local";
  private modeReason = "";
  readonly sessionContext: SessionContext;

  /** External session events ref — set by proxy for value counter. */
  private sessionEvents: SessionEvents | null = null;

  /** Health grade string for session greeting. */
  private healthGrade: string | null = null;

  /** Graph stats for session greeting. */
  private graphStats: {
    entities: number;
    edges: number;
    rules: number;
  } | null = null;

  /** Push-based violation store (Task 7.3) — shared with DriftTracker. */
  private pendingViolations: PendingViolationStore | null = null;

  /** Project root path for file operations (Task 7.4 revert). */
  private projectRoot: string | null = null;

  /**
   * Cross-repo federation coordinator (CROSS_REPO_INTELLIGENCE Sprint 3). Null
   * until the proxy injects one via `setFederationCoordinator` — when null,
   * `scope:'workspace'` silently degrades to the home repo. The coordinator owns
   * the pro-tier gate, peer discovery, fan-out, and the per-peer circuit breaker.
   */
  private federationCoordinator:
    | import("./federation/coordinator.js").FederationCoordinator
    | null = null;

  /**
   * This repo's SCIP moniker index (CROSS_REPO_INTELLIGENCE Sprint 4). Gives a
   * focus entity its stable cross-repo identity so `get_references` can ask
   * peers who imports it, and answers a peer's `xref_by_moniker` lookup. Null
   * until the proxy injects one via `setMonikerIndex` (no SCIP / not indexed →
   * cross-repo references silently degrade to the home repo).
   */
  private monikerIndex:
    | import("./federation/moniker-index.js").MonikerIndex
    | null = null;

  /** L11.1: Background indexer reference — enables partial graph responses during indexing. */
  private backgroundIndexer: BackgroundIndexer | null = null;

  /** L9.4: DriftTracker for writing changed files to drift overlay in Local Mode. */
  private driftTracker: DriftTracker | null = null;

  /** S1: Session-level context deduplication. */
  private sessionDedup: SessionDedup | null = null;

  /** S1: Compression quality feedback loop. */
  private compressionMonitor: CompressionQualityMonitor | null = null;

  /** Layer 6 FE-E: one-time legends per session until retry invalidation. */
  private readonly sessionLegend = createSessionLegendTracker();

  /** S1: Recent entity queries for retry detection (entityKey → timestamp). */
  private recentEntityQueries = new Map<string, number>();

  /** S2: Session health monitor — detects session degradation. */
  private healthMonitor: ReturnType<typeof createSessionHealthMonitor> | null =
    null;

  /** Verb-noun behavior events — named counters for PREVENT-class wins
   *  (graph_query_served, loop_broken, cascade_guard, etc.). Replaces the
   *  deleted exploration-cost estimator. */
  private behaviorEvents: BehaviorEventWriter | null = null;

  /** S3: Context rot detector — detects long-session degradation. */
  private contextRotDetector: ContextRotDetector | null = null;

  /** S4: Token counter — accumulates savings, emits to stderr at interval. */
  private tokenCounter: TokenCounter | null = null;

  /** S4: Efficiency tracker — tracks original vs delivered for session summary. */
  private efficiencyTracker: EfficiencyTracker | null = null;

  /** Layer 10: Token flow writer — unified savings attribution. */
  private tokenFlow: TokenFlowWriter | null = null;

  /** Persistent memory effectiveness — fact/convention/resume verdict scorer. */
  private effectivenessTracker: PersistenceEffectivenessTracker | null = null;

  /** S7.4: Session resume context — injected on first response of resumed session. */
  private sessionResumeContext: {
    summary: string;
    filesModified: string[];
    incompleteEntities: string[];
  } | null = null;

  /** Unix-ms timestamp of the previous session's end — drives the elapsed-time
   * line of the visible `[unerr:session-resume]` block. Null when the agent
   * starts a fresh session with no prior history. */
  private previousSessionEndedAt: number | null = null;

  /** S7.5: Durability scorer — scores entity fragility across sessions. */
  private durabilityScorer: ReturnType<
    typeof import("../intelligence/durability-scorer.js").createDurabilityScorer
  > | null = null;

  /** S7.6: Anti-pattern entries from negative knowledge for injection. */
  private antiPatternEntries: Array<{
    entityKey: string;
    pattern: string;
    reason: string;
  }> = [];

  /** S9.1: Circuit breaker — halts repeated failed attempts on same entity. */
  private circuitBreaker: {
    recordAttempt(entity: string, hadViolations: boolean): void;
    check(entities: string[]): {
      triggered: boolean;
      entity: string;
      attempts: number;
      message: string;
    } | null;
    isHalted(entity: string): boolean;
  } | null = null;

  /** S9.2: Health threshold below which circuit breaker force-triggers. */
  private readonly HEALTH_CIRCUIT_BREAK_THRESHOLD = 0.3;

  /** Q.1: Causal bridge — entity history from prompt→commit→survival chain. */
  private causalBridge: {
    buildCausalChain(entityKey: string): Promise<{
      entityKey: string;
      entityName: string;
      interactions: Array<{
        prompt: string;
        commitSha: string;
        sessionId: string;
        timestamp: string;
        survived: boolean;
        outcome: string;
        survivalMs: number;
      }>;
      durability: number;
      failureModes: string[];
    }>;
  } | null = null;

  /** Q.3: Convention learner — conventions learned from corrections. */
  private learnedConventions: Array<{
    id: string;
    name: string;
    pattern: string;
    confidence: number;
  }> = [];

  /** Q.1: Prompt durability profiles — which prompt styles produce durable code. */
  private promptDurabilityProfiles: Array<{
    actionType: string;
    targetRisk: string;
    durability: number;
    recommendation?: string;
  }> = [];

  /** Cross-session context ledger — tracks delivered context across sessions. */
  private contextLedger: {
    hasDelivered(entityKey: string, contextKey: string): boolean;
    markDelivered(entityKey: string, contextKeys: string[]): void;
  } | null = null;

  /** Intent token tracker — groups tool calls by intent for token accounting. */
  private intentTracker: {
    startIntent(intentId: string, prompt?: string): void;
    recordToolCall(
      intentId: string,
      tokens: number,
      saved: number,
      entity?: string
    ): void;
    getActiveIntentId(): string | null;
    getAllGroups(): import("../tracking/intent-token-tracker.js").IntentGroup[];
    getTotalTokens(): { consumed: number; saved: number; ratio: number };
    pruneAbandoned(): number;
  } | null = null;

  /** Layer 7: Event bus for dashboard SSE — emits on every tool call. */
  private eventBus: { emit(type: string, data: unknown): void } | null = null;

  /** Sprint 1.2: Temporal fact store — facts attached to internal `context.signals`, drained to `ur|fct` prefix lines. */
  private factStore: {
    recallForFile(
      filePath: string,
      entityKeys?: string[]
    ): Promise<
      Array<{
        fact_id: string;
        fact_type: string;
        content: string;
        effective_confidence: number;
        source: string;
      }>
    >;
    recallByScope(
      scope: string,
      minConfidence?: number
    ): Promise<
      Array<{
        fact_id: string;
        fact_type: string;
        content: string;
        effective_confidence: number;
        source: string;
      }>
    >;
    recallNegative(minConfidence?: number): Promise<
      Array<{
        fact_id: string;
        fact_type: string;
        content: string;
        effective_confidence: number;
        source: string;
      }>
    >;
  } | null = null;

  /** Sprint 1.2: Fact IDs surfaced this session — for session summary tracking. */
  private factsSurfaced: string[] = [];

  /** Sprint 9.3: Signal delivery stats — tracked for intelligence health UI. */
  private signalDeliveryStats = {
    total_delivered: 0,
    by_type: {} as Record<string, number>,
    tool_calls_with_signals: 0,
    total_tool_calls: 0,
  };

  constructor(
    private localGraph: CozoGraphStore,
    ruleEvaluator?: typeof EvaluateRulesFn
  ) {
    this.ruleEvaluator = ruleEvaluator ?? null;
    this.sessionContext = new SessionContext();
  }

  /**
   * Swap the graph reference atomically (called by GraphHolder on rebuild completion).
   * All subsequent tool calls will use the new graph instance.
   */
  swapGraph(newGraph: CozoGraphStore): void {
    this.localGraph = newGraph;
  }

  /**
   * Set the session events reference (from proxy's SessionStats).
   * Used by the value counter (Task 2.7).
   */
  setSessionEvents(events: SessionEvents): void {
    this.sessionEvents = events;
  }

  /**
   * Set health grade info for session greeting (Task 2.6).
   */
  setHealthInfo(
    grade: string,
    stats: { entities: number; edges: number; rules: number }
  ): void {
    this.healthGrade = grade;
    this.graphStats = stats;
  }

  /**
   * Set the pending violation store for push-based rule enforcement (Task 7.3).
   */
  setPendingViolations(store: PendingViolationStore): void {
    this.pendingViolations = store;
  }

  /**
   * Set the project root path for file operations (Task 7.4 revert).
   */
  setProjectRoot(root: string): void {
    this.projectRoot = root;
  }

  /**
   * Inject the cross-repo federation coordinator (CROSS_REPO_INTELLIGENCE
   * Sprint 3). The proxy wires one over the daemon client + peer transport on
   * pro/enterprise; on free tier the coordinator itself refuses, so this can be
   * set unconditionally. Unset → `scope:'workspace'` degrades to the home repo.
   */
  setFederationCoordinator(
    coordinator: import("./federation/coordinator.js").FederationCoordinator
  ): void {
    this.federationCoordinator = coordinator;
  }

  /**
   * Inject this repo's SCIP moniker index (CROSS_REPO_INTELLIGENCE Sprint 4).
   * The proxy loads `.unerr/scip/monikers.json` at startup and on every
   * reindex, so cross-repo `get_references` always reflects the current graph.
   * Unset → cross-repo references degrade to the home repo silently.
   */
  setMonikerIndex(
    index: import("./federation/moniker-index.js").MonikerIndex | null
  ): void {
    this.monikerIndex = index;
  }

  /**
   * Set the background indexer reference (L11.2).
   * When set and indexing is active, tools return partial results with indexing metadata.
   */
  setBackgroundIndexer(indexer: BackgroundIndexer): void {
    this.backgroundIndexer = indexer;
  }

  /**
   * Set the drift tracker for drift overlay writes (L9.4).
   */
  setDriftTracker(tracker: DriftTracker): void {
    this.driftTracker = tracker;
  }

  /**
   * S1: Set session dedup tracker for _context deduplication.
   */
  setSessionDedup(dedup: SessionDedup): void {
    this.sessionDedup = dedup;
  }

  /**
   * S1: Set compression quality monitor for adaptive compression.
   */
  setCompressionMonitor(monitor: CompressionQualityMonitor): void {
    this.compressionMonitor = monitor;
  }

  /**
   * S2: Set session health monitor for degradation detection.
   */
  setHealthMonitor(
    monitor: ReturnType<typeof createSessionHealthMonitor>
  ): void {
    this.healthMonitor = monitor;
  }

  /** Set the writer for verb-noun behavior events. */
  setBehaviorEvents(writer: BehaviorEventWriter): void {
    this.behaviorEvents = writer;
  }

  /**
   * S3: Set context rot detector for long-session degradation detection.
   */
  setContextRotDetector(detector: ContextRotDetector): void {
    this.contextRotDetector = detector;
  }

  /**
   * S4: Set token counter for live stderr emission and session accounting.
   */
  setTokenCounter(counter: TokenCounter): void {
    this.tokenCounter = counter;
  }

  /**
   * S4: Set efficiency tracker for session-level original vs delivered tracking.
   */
  setEfficiencyTracker(tracker: EfficiencyTracker): void {
    this.efficiencyTracker = tracker;
  }

  /**
   * Layer 10: Set token flow writer for unified savings attribution.
   */
  setTokenFlow(writer: TokenFlowWriter): void {
    this.tokenFlow = writer;
  }

  /**
   * Layer 10: Get token flow writer (for external consumers like format-encoder).
   */
  getTokenFlow(): TokenFlowWriter | null {
    return this.tokenFlow;
  }

  setEffectivenessTracker(tracker: PersistenceEffectivenessTracker): void {
    this.effectivenessTracker = tracker;
  }

  getEffectivenessTracker(): PersistenceEffectivenessTracker | null {
    return this.effectivenessTracker;
  }

  /**
   * S7.4: Set session resume context (injected on first response).
   * `previousSessionEndedAt` is the unix-ms timestamp of the prior session's
   * end — used to render the elapsed-time line of the visible resume block.
   */
  setSessionResumeContext(ctx: {
    summary: string;
    filesModified: string[];
    incompleteEntities: string[];
    previousSessionEndedAt?: number;
  }): void {
    const { previousSessionEndedAt, ...rest } = ctx;
    this.sessionResumeContext = rest;
    this.previousSessionEndedAt = previousSessionEndedAt ?? null;
  }

  /**
   * S7.5: Set durability scorer for entity fragility warnings.
   */
  setDurabilityScorer(scorer: {
    getScore: (entityKey: string) => {
      score: number;
      modificationCount: number;
      avgSurvivalMs: number;
    } | null;
    getTopUnstable: (
      limit?: number
    ) => Array<{ entityKey: string; score: number }>;
  }): void {
    this.durabilityScorer = scorer as any;
  }

  /**
   * S7.6: Set anti-pattern entries from negative knowledge analysis.
   */
  setAntiPatterns(
    entries: Array<{ entityKey: string; pattern: string; reason: string }>
  ): void {
    this.antiPatternEntries = entries;
  }

  /**
   * Sprint 1.2: Wire temporal fact store for _context injection.
   */
  setFactStore(store: typeof this.factStore): void {
    this.factStore = store;
  }

  /**
   * Wire the persistent rotation store so signal show counts survive restart
   * and are coordinated across parallel sessions in the same repo.
   */
  setSignalShowStore(
    store: import("./signal-show-store.js").SignalShowStore | null
  ): void {
    this.sessionContext.setSignalShowStore(store);
  }

  /** Sprint 1.2: Get fact IDs surfaced this session (for session summary). */
  getFactsSurfaced(): string[] {
    return this.factsSurfaced;
  }

  /** Sprint 9.3: Get signal delivery stats for intelligence health UI. */
  getSignalStats(): {
    total_delivered: number;
    by_type: Record<string, number>;
    coverage_pct: number;
  } {
    const {
      total_delivered,
      by_type,
      tool_calls_with_signals,
      total_tool_calls,
    } = this.signalDeliveryStats;
    return {
      total_delivered,
      by_type,
      coverage_pct:
        total_tool_calls > 0
          ? Math.round((tool_calls_with_signals / total_tool_calls) * 100)
          : 0,
    };
  }

  /**
   * S9.1: Wire circuit breaker into query router.
   * Records entity attempts and injects halt messages when threshold tripped.
   */
  setCircuitBreaker(breaker: {
    recordAttempt(entity: string, hadViolations: boolean): void;
    check(entities: string[]): {
      triggered: boolean;
      entity: string;
      attempts: number;
      message: string;
    } | null;
    isHalted(entity: string): boolean;
  }): void {
    this.circuitBreaker = breaker;
  }

  /**
   * Q.1: Wire causal bridge for entity history — surfaces as `ur|fct` prefix lines.
   */
  setCausalBridge(bridge: typeof this.causalBridge): void {
    this.causalBridge = bridge;
  }

  /**
   * Q.3: Set learned conventions from cross-session correction analysis.
   */
  setLearnedConventions(conventions: typeof this.learnedConventions): void {
    this.learnedConventions = conventions;
  }

  /**
   * Q.1: Set prompt durability profiles for strategy recommendations.
   */
  setPromptDurabilityProfiles(
    profiles: typeof this.promptDurabilityProfiles
  ): void {
    this.promptDurabilityProfiles = profiles;
  }

  /**
   * Cross-session context ledger — prevents re-delivering context across sessions.
   */
  setContextLedger(ledger: typeof this.contextLedger): void {
    this.contextLedger = ledger;
  }

  /**
   * Intent token tracker — groups tool calls by intent for accounting.
   */
  setIntentTracker(tracker: typeof this.intentTracker): void {
    this.intentTracker = tracker;
  }

  /**
   * Layer 7: Event bus for dashboard real-time updates.
   */
  setEventBus(bus: { emit(type: string, data: unknown): void }): void {
    this.eventBus = bus;
  }

  /**
   * P0-3: Wire the RouterGateway. Called once at proxy boot. The gateway
   * owns SessionState + ToolExposureStore; the router consults it before
   * each dispatch (gate) and after each success (record + unlock).
   */
  setRouterGateway(gateway: RouterGateway): void {
    this.routerGateway = gateway;
  }

  /** P0-3: Read-only access to the gateway for the proxy's tools/list handler. */
  getRouterGateway(): RouterGateway | null {
    return this.routerGateway;
  }

  /**
   * S4: Get efficiency snapshot for session summary at shutdown.
   */
  getEfficiencySnapshot(): {
    totalCalls: number;
    savedTokens: number;
    efficiency: number;
  } | null {
    if (!this.efficiencyTracker) return null;
    const snap = this.efficiencyTracker.getSnapshot();
    return {
      totalCalls: snap.totalCalls,
      savedTokens: snap.savedTokens,
      efficiency: snap.efficiency,
    };
  }

  /**
   * Layer 7: Intent groups for dashboard session API.
   */
  getIntentGroups(): import(
    "../tracking/intent-token-tracker.js"
  ).IntentGroup[] {
    return this.intentTracker?.getAllGroups() ?? [];
  }

  /**
   * Set the current proxy operating mode. Affects _meta on all responses.
   */
  setMode(mode: ProxyMode, reason?: string): void {
    this.currentMode = mode;
    this.modeReason = reason ?? "";
  }

  getMode(): ProxyMode {
    return this.currentMode;
  }

  /**
   * Update the branch context (called on startup and branch switch).
   */
  setBranchContext(ctx: BranchContext): void {
    this.branchContext = ctx;
  }

  isKnownTool(toolName: string): boolean {
    return LOCAL_TOOLS.has(toolName);
  }

  async execute(
    requestedTool: string,
    requestedArgs: Record<string, unknown>
  ): Promise<ToolResult> {
    const t0 = performance.now();

    // search_code profile mode — detail:true (or include_body / want, which
    // imply it) resolves the query to ONE entity and returns the full profile.
    // Translated to the internal get_entity executor (de-advertised from the
    // catalog 2026-06, retained by name like get_function/get_class) so every
    // downstream stage — risk injection, noise stripping, wire encoding,
    // telemetry — keys on the single-entity tool name it already handles.
    // Same early-translate pattern as translateUnerrTrack (proxy.ts). The
    // translation is shared with executeRaw via resolveProfileTool so the public
    // and raw paths can never diverge (executeLocal dispatches on tool name).
    const profile = resolveProfileTool(requestedTool, requestedArgs);
    const toolName = profile.toolName;
    const args = profile.args;

    // Cross-repo scope (CROSS_REPO_INTELLIGENCE Sprint 3). `scope:'workspace'`
    // on a query fan-out tool federates the SAME query to sibling repos and
    // merges; the coordinator forces `scope:'repo'` on every peer sub-call, so
    // the recursive home call below (also `scope:'repo'`) can never re-enter
    // this branch. With no coordinator wired (federation off, or free tier)
    // executeWorkspace returns the home-only result in the SAME structured
    // shape, so the wire output is consistent whether or not federation is on.
    if (args.scope === "workspace" && WORKSPACE_FANOUT_TOOLS.has(toolName)) {
      return this.executeWorkspace(toolName, args);
    }

    // Cross-repo references (CROSS_REPO_INTELLIGENCE Sprint 4). A home entity
    // key is meaningless on a peer, so `get_references({scope:'workspace'})`
    // can't fan out the raw key — it resolves the focus entity's STABLE moniker
    // and asks each peer who references THAT (an `xref_by_moniker` lookup),
    // then merges the cross-repo importers into the local result.
    if (args.scope === "workspace" && toolName === "get_references") {
      return this.executeWorkspaceReferences(args);
    }

    // Implicit cross-repo path routing (Sprint 3 §3.3). A path-bearing tool
    // whose path resolves OUTSIDE the home repo is routed to the sibling repo
    // that owns it — scenario 3 (agent references a foreign file mid-session).
    // The cheap home-root pre-check keeps the common in-repo read off the
    // network path entirely.
    if (this.federationCoordinator && PATH_ROUTED_TOOLS.has(toolName)) {
      const routed = await this.maybeRoutePathCall(toolName, args, t0);
      if (routed) return routed;
    }

    // Mode-aware: SETUP mode returns informational response (not an error)
    if (this.currentMode === "setup") {
      const r = this.buildModeResponse(
        toolName,
        t0,
        `unerr is not yet configured for this repository. Run 'unerr' to complete setup. Tool '${toolName}' will be available after setup.`
      );
      await this.enrichResult(toolName, args, r);
      return r;
    }

    // L11.2: During background indexing, return partial results or progress messages
    if (this.backgroundIndexer?.isIndexing()) {
      const progress = this.backgroundIndexer.getProgress();
      const indexingMeta: ToolResult["_meta"] = {
        source: "local",
        latency_ms: performance.now() - t0,
        indexing: true,
        partial: true,
        indexed_files: progress.processed,
        total_files: progress.total,
      };
      this.injectModeMeta(indexingMeta);

      // Try to serve from partial graph — if entities exist, return them with caveat
      if (LOCAL_TOOLS.has(toolName)) {
        try {
          const result = await this.executeLocal(toolName, args);
          if (result !== null && result !== undefined) {
            const toolResult: ToolResult = {
              content: result,
              _meta: indexingMeta,
            };
            await this.enrichResult(toolName, args, toolResult);
            return toolResult;
          }
        } catch (err: unknown) {
          process.stderr.write(
            `[unerr] ⚠ Graph query failed during tool dispatch: ${formatUnknownError(err)}\n`
          );
        }
      }

      // Graph empty or non-local tool — return structured progress message
      return {
        content: {
          message: `Indexing in progress: ${progress.processed}/${progress.total} files (${progress.pct}%)`,
          indexing: true,
          phase: progress.phase,
          processed: progress.processed,
          total: progress.total,
          pct: progress.pct,
          tool: toolName,
          available: false,
        },
        _meta: indexingMeta,
      };
    }

    // Unknown tool
    if (!LOCAL_TOOLS.has(toolName)) {
      const r = this.buildModeResponse(
        toolName,
        t0,
        `Unknown tool '${toolName}'. Run 'unerr status' to see available tools.`
      );
      return r;
    }

    // P0-3 exposure gate. Tier-1 tools are always exposed; tier-2/3
    // tools whose unlock condition has not yet fired short-circuit here
    // with a soft-refuse — proxy.ts stamps `isError: true` on the wire
    // frame when it reads `_meta.gate_status === "locked"`.
    if (this.routerGateway) {
      const refusal = this.routerGateway.gate(toolName, args);
      if (refusal) {
        const totalMs = Math.round(performance.now() - t0);
        const gated: ToolResult = {
          content: refusal.content,
          _meta: {
            source: "local",
            latency_ms: totalMs,
            gate_status: "locked",
          },
        };
        this.routerGateway.recordTelemetry(toolName, "soft_refused", 0, 0, {
          classify: totalMs,
          total: totalMs,
        });
        return gated;
      }
    }

    try {
      // Phase 1: Tool-level timeout prevents stuck MCP calls from CozoDB contention.
      // Content-heavy tools (file_read, file_outline, search_code) hit CozoDB hard and
      // can legitimately exceed 3s under indexer contention, so they get a higher tier.
      //
      // Network tools (fetch_url) own their own retry + deadline machinery
      // (FETCH_PROTOCOL_LIMITS.totalDeadlineMs = 120_000ms). The outer race must NOT
      // pre-empt that or the typed `deadline_exceeded` http_error never wins —
      // agents see a generic `tool_timeout` instead. 130_000ms = 120_000 + 10_000
      // buffer so the inner deadline fires first.
      const HEAVY_TOOLS = new Set(["file_read", "file_outline", "search_code"]);
      const NETWORK_TOOLS = new Set(["fetch_url"]);
      const TOOL_TIMEOUT_MS = NETWORK_TOOLS.has(toolName)
        ? 130_000
        : HEAVY_TOOLS.has(toolName)
          ? 5_000
          : 3_000;
      const rawLocal = await Promise.race([
        this.executeLocal(toolName, args),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `tool_timeout: ${toolName} exceeded ${TOOL_TIMEOUT_MS}ms`
                )
              ),
            TOOL_TIMEOUT_MS
          )
        ),
      ]);
      const latency_ms = performance.now() - t0;
      const meta: ToolResult["_meta"] = { source: "local", latency_ms };

      let result: unknown = rawLocal;
      if (
        toolName === "file_read" &&
        rawLocal &&
        typeof rawLocal === "object"
      ) {
        const fr = rawLocal as {
          content: unknown;
          _layer6_meta?: Partial<ToolResult["_meta"]> & {
            tokens_estimate?: number;
            optimization?: string;
            total_lines?: number;
            total_file_tokens?: number;
          };
        };
        if ("content" in fr) {
          result = fr.content;
          if (fr._layer6_meta) {
            Object.assign(meta, fr._layer6_meta);

            // Layer 10: Record file read optimization savings.
            // Gate only on total_lines (always set on successful reads) — `optimization`
            // is informational and absent on full small-file reads, but those have zero
            // savings anyway and are filtered by the `> 0` threshold below.
            if (this.tokenFlow && fr._layer6_meta.total_lines) {
              const deliveredTokens = fr._layer6_meta.tokens_estimate ?? 0;
              // Prefer the real BPE count of the full file (set by
              // file-read-protocol.ts via estimateTokens). Fall back to a
              // line heuristic only when it's absent (older meta shapes).
              const fullFileTokens =
                fr._layer6_meta.total_file_tokens ??
                Math.ceil((fr._layer6_meta.total_lines * 80) / 4);
              const fileReadSaved = fullFileTokens - deliveredTokens;
              if (fileReadSaved > 0) {
                this.tokenFlow.record({
                  session_id: this.tokenFlow.sessionId,
                  turn: this.sessionContext.getToolCallCount(),
                  mechanism: "file_read",
                  tool: toolName,
                  tokens_without: fullFileTokens,
                  tokens_with: deliveredTokens,
                  tokens_saved: fileReadSaved,
                  detail: {
                    // L2 capture-site fix: the Logbook can only name the file
                    // ("Trimmed the read of `src/x.ts`") if file_path rides the
                    // detail bag — it was missing here, so prod rows fell back
                    // to the generic "Trimmed a file read". Same extraction the
                    // fact injector uses (execute() args).
                    file_path:
                      (args.file_path as string) ??
                      (args.path as string) ??
                      null,
                    optimization:
                      fr._layer6_meta.optimization ?? "file_read full",
                    total_lines: fr._layer6_meta.total_lines,
                  },
                });
              }
            }
          }
        }
      }

      // P10-MV-01: Inject entity risk metadata for entity-returning tools
      const entityRisk = extractEntityRisk(toolName, result);
      if (entityRisk) {
        meta.entity_risk = entityRisk;
      }

      // P10-PROXY-02: Inject drift metadata
      const driftMeta = await this.extractDriftMeta(toolName, args, result);
      if (driftMeta) {
        meta.drift = driftMeta;
      }

      // Layer 8 §5.1 (SC-C.2): inject comment-drift metadata when the focus
      // entity carries a stale @sem/doc annotation (body moved, comment did
      // not). buildSignalPrefix renders it as a once-per-episode `ur|ctx` nudge.
      const commentDriftMeta = await this.extractCommentDriftMeta(
        toolName,
        args
      );
      if (commentDriftMeta) {
        meta.comment_drift = commentDriftMeta;
      }

      // Layer 8 §6 (SC-D.3): inject boundary-erosion metadata when the focus
      // entity lives in a low-purity community (the domain vote is contested).
      // buildSignalPrefix renders it as a once-per-episode `ur|rsk` nudge.
      const boundaryErosionMeta = await this.extractBoundaryErosionMeta(
        toolName,
        args
      );
      if (boundaryErosionMeta) {
        meta.boundary_erosion = boundaryErosionMeta;
      }

      // Persistent-memory effectiveness: subsequent activity on an entity
      // counts as the agent "acting on" any open fact/convention signal for
      // that entity. Drift / high entity_risk also signal a potential
      // correction — record both observations.
      if (this.effectivenessTracker) {
        const dispatchArgs = args as Record<string, unknown>;
        const entityKey =
          (dispatchArgs.key as string | undefined) ??
          (dispatchArgs.name as string | undefined) ??
          null;
        if (entityKey) {
          this.effectivenessTracker.recordEdit(entityKey);
          if (driftMeta?.entityStatus) {
            this.effectivenessTracker.recordCorrection(entityKey, "drift");
          }
          if (entityRisk?.risk_level === "high") {
            this.effectivenessTracker.recordCorrection(
              entityKey,
              "blast_radius"
            );
          }
        }
      }

      // Merge inner _meta from executeLocal (e.g. indexing status)
      if (
        result &&
        typeof result === "object" &&
        "_meta" in (result as Record<string, unknown>)
      ) {
        const innerMeta = (result as Record<string, unknown>)._meta as Record<
          string,
          unknown
        >;
        Object.assign(meta, innerMeta);
      }

      this.injectModeMeta(meta);

      // S1: Compress large text output before delivering to agent
      const compressedContent = await this.maybeCompressContent(
        toolName,
        result,
        meta
      );

      // Strip noise fields that are meaningless to coding agents before encoding
      const cleanedContent = stripNoiseFields(toolName, compressedContent);

      // Tier-3 wire-cap MUST run BEFORE format encoding. Reason: format-encoder
      // converts arrays into columnar STRINGS, after which wire-cap can no
      // longer slice (the array is gone). Apply pagination to the raw object,
      // then encode the smaller result. Stash the pageHint on `meta` for the
      // wire boundary to surface as the leading `ur|` line.
      const { applyWireCap: applyCapEarly } = await import(
        "../proxy/wire-cap.js"
      );
      const {
        body: cappedContent,
        pageHint: cappedHint,
        metrics: capMetrics,
      } = applyCapEarly(toolName, cleanedContent, args);
      if (cappedHint) {
        // _unerr_page_hint is an internal-only field — wire boundaries
        // consume it (prepend to body) and never serialize it on the wire.
        (meta as Record<string, unknown>)._unerr_page_hint = cappedHint;
      }
      // §4: record the wire-cap event's reversible/importance/query fields on
      // the existing compression_events stream (no new event type). Best-effort
      // — a recording failure never affects the response.
      if (capMetrics) {
        try {
          const { appendCompressionLog } = await import(
            "../proxy/shell-compression-log.js"
          );
          appendCompressionLog(this.projectRoot ?? process.cwd(), {
            ts: new Date().toISOString(),
            command: toolName,
            category: "wire_cap",
            confidence: 1,
            rawBytes: capMetrics.original_tokens ?? 0,
            compressedBytes: capMetrics.delivered_tokens ?? 0,
            savedPct:
              capMetrics.original_tokens && capMetrics.original_tokens > 0
                ? Math.max(
                    0,
                    1 -
                      (capMetrics.delivered_tokens ?? 0) /
                        capMetrics.original_tokens
                  )
                : 0,
            omniFallback: false,
            reversible: capMetrics,
          });
        } catch {
          /* best effort — metrics never block the wire */
        }
      }

      // Layer 6 FE-C / FE-E: columnar wire encoding (after compression, before envelope)
      const estLayer6 = this.estimateLayer6Tokens(cappedContent);
      const layer6Tier =
        this.compressionMonitor?.getLayer6Tier(toolName) ?? "columnar";
      const formattedContent = formatToolOutput(toolName, cappedContent, meta, {
        legend: this.sessionLegend,
        tier: layer6Tier,
      });

      // Layer 10: Record format encoding savings
      const postEncodingTok =
        typeof formattedContent === "string"
          ? estimateTokens(formattedContent)
          : estimateTokens(JSON.stringify(formattedContent));

      if (this.compressionMonitor && meta.format === "columnar") {
        const ratio = postEncodingTok / Math.max(1, estLayer6);
        this.compressionMonitor.recordCompression(
          `${toolName}-l6-${Date.now()}`,
          "layer6_columnar",
          ratio
        );
      }

      if (this.tokenFlow && estLayer6 > postEncodingTok) {
        const encodingSaved = estLayer6 - postEncodingTok;
        this.tokenFlow.record({
          session_id: this.tokenFlow.sessionId,
          turn: this.sessionContext.getToolCallCount(),
          mechanism: "format_encoding",
          tool: toolName,
          tokens_without: estLayer6,
          tokens_with: postEncodingTok,
          tokens_saved: encodingSaved,
          detail: { format: meta.format },
        });
      }

      const toolResult: ToolResult = {
        content: formattedContent,
        _meta: meta,
      };
      const enrichStats = await this.enrichResult(toolName, args, toolResult);

      // A truncated file read surfaces as a TOP-LEVEL body marker, never as
      // `_meta.truncated`: wire-cap emits `{status:"too_large", ...}` and the
      // entity-gate in file-read-protocol emits `{entity_overflow:true, ...}`.
      // The smart-truncate ENTITY paths set `meta.truncated`, but these two
      // file-read paths never did — and enrichResult's budget accounting just
      // recomputed `truncated` from the SMALL capped body (≈43 tokens < 2000),
      // resetting it to false. Stamp the canonical flag here, AFTER enrichResult
      // and BEFORE recordAndUnlock reads it, so call-signals.ts can unlock
      // get_file (whose sole unlock condition is FileReadTruncated). The gated
      // outline path needs no stamp — it carries `_meta.gated`, which
      // call-signals reads directly.
      if (
        cappedContent &&
        typeof cappedContent === "object" &&
        !Array.isArray(cappedContent)
      ) {
        const cc = cappedContent as Record<string, unknown>;
        if (cc.status === "too_large" || cc.entity_overflow === true) {
          toolResult._meta.truncated = true;
        }
      }

      // P0-3 post-execute: fold signals, evaluate unlocks, prepend
      // `ur|act <tool> unlocked — …` lines to the body when new tools
      // come online. The gateway also persists the unlock event.
      if (this.routerGateway) {
        const outcome = await this.routerGateway.recordAndUnlock(
          toolName,
          args,
          toolResult,
          (err) =>
            process.stderr.write(
              `[unerr] router-gateway: persistence failed: ${formatUnknownError(err)}\n`
            )
        );
        if (outcome.unlocks.length > 0) {
          toolResult.content = prependAnnounceToBody(
            toolResult.content,
            outcome.announceText
          );
          toolResult._meta.unlocked_tools = outcome.unlocks.map(
            (u) => u.toolName
          );
        }

        const telemetryTotalMs = Math.round(performance.now() - t0);
        this.routerGateway.recordTelemetry(
          toolName,
          "executed",
          0,
          0,
          { forward: telemetryTotalMs, total: telemetryTotalMs },
          outcome.unlocks.map((u) => u.toolName)
        );
      }

      // Layer 7: Emit tool_call event for dashboard SSE — stats stay internal,
      // never written to wire `_meta` (vanity-strip pass).
      if (this.eventBus) {
        const entityKey =
          (args.key as string) ?? (args.name as string) ?? toolName;
        this.eventBus.emit("tool_call", {
          tool: toolName,
          entity: entityKey,
          latency_ms: toolResult._meta.latency_ms,
          tokens_saved: enrichStats.tokensSaved,
        });

        // Layer 10: Emit token_flow SSE event for dashboard real-time counter
        if (enrichStats.tokensSaved > 0) {
          const tokensDelivered = estimateTokens(toolResult.content);
          const sessionTotal = this.tokenFlow?.getSessionTokensSaved() ?? 0;
          const sessionEff = this.tokenFlow?.getSessionEfficiency() ?? 0;
          this.eventBus.emit("token_flow", {
            turn: this.sessionContext.getToolCallCount(),
            tool: toolName,
            mechanism: enrichStats.savingsMechanism ?? "fetch_url",
            tokens_saved: enrichStats.tokensSaved,
            tokens_delivered: tokensDelivered,
            session_total: sessionTotal,
            session_efficiency: sessionEff,
          });
        }
      }

      return toolResult;
    } catch (err: unknown) {
      // S3.5: Feed errors into context rot detector
      if (this.contextRotDetector) {
        this.contextRotDetector.recordError();
      }

      const errMsg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
            ? JSON.stringify(err)
            : String(err);
      process.stderr.write(`[unerr:tool-error] ${toolName}: ${errMsg}\n`);

      const isTimeout = errMsg.startsWith("tool_timeout:");
      const meta: ToolResult["_meta"] = {
        source: "local",
        latency_ms: performance.now() - t0,
      };
      this.injectModeMeta(meta);
      return {
        content: {
          error: isTimeout
            ? `Tool '${toolName}' timed out — the graph may be busy indexing. The tool will work on retry. If this persists, restart the unerr process.`
            : `Tool '${toolName}' failed locally: ${errMsg}`,
          ...(isTimeout ? { retryable: true, timeout: true } : {}),
        },
        _meta: meta,
      };
    }
  }

  /**
   * Build an informational response for degraded modes (isError: false).
   */
  private buildModeResponse(
    toolName: string,
    t0: number,
    message: string
  ): ToolResult {
    const meta: ToolResult["_meta"] = {
      source: "local",
      latency_ms: performance.now() - t0,
    };
    this.injectModeMeta(meta);
    return {
      content: { message, tool: toolName, available: false },
      _meta: meta,
    };
  }

  /**
   * Inject mode, mode_reason, and tools_degraded into _meta.
   */
  private injectModeMeta(meta: ToolResult["_meta"]): void {
    if (meta.format === undefined) {
      meta.format = "json";
    }
    meta.mode = this.currentMode;
    if (this.modeReason) {
      meta.mode_reason = this.modeReason;
    }
    if (this.currentMode !== "local") {
      meta.tools_degraded = this.getDegradedTools();
    }
  }

  /**
   * Get list of tools that are degraded in current mode.
   */
  private getDegradedTools(): string[] {
    switch (this.currentMode) {
      case "parse":
        return ["get_conventions"];
      case "setup":
        return Array.from(LOCAL_TOOLS);
      default:
        return [];
    }
  }

  /**
   * Sprint 2: Enrich a tool result with blast radius, conventions, drift alerts,
   * session greeting, and value counter. Dedup is handled by SessionContext.
   *
   * Called after execute() for all local entity-returning tools.
   */
  async enrichResult(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult
  ): Promise<{ tokensSaved: number; savingsMechanism?: string }> {
    this.sessionContext.recordToolCall();

    // S2.4: Feed tool call into health monitor
    if (this.healthMonitor) {
      const entityKey = (args.key as string) ?? (args.name as string);
      this.healthMonitor.recordToolCall(toolName, entityKey ?? undefined);
    }

    // S9.1 + S9.2: Circuit breaker — record attempt and check for halt
    if (this.circuitBreaker && ENRICHABLE_TOOLS.has(toolName)) {
      const entityKey = (args.key as string) ?? (args.name as string);
      if (entityKey) {
        // Determine if this attempt had violations (e.g., from rule evaluation)
        const hasViolations = result._meta.auto_check?.violations
          ? result._meta.auto_check.violations.length > 0
          : false;
        this.circuitBreaker.recordAttempt(entityKey, hasViolations);

        if (hasViolations && this.eventBus) {
          const ac = result._meta.auto_check?.violations ?? [];
          this.eventBus.emit("violation", {
            source: "push_rules",
            entity: entityKey,
            count: ac.length,
            tool: toolName,
          });
        }

        // S9.2: Force-trigger if session health is critically low
        const healthScore = this.healthMonitor?.getHealth().health ?? 1.0;
        const forceBreak = healthScore < this.HEALTH_CIRCUIT_BREAK_THRESHOLD;

        const breakerResult = this.circuitBreaker.check([entityKey]);
        if (breakerResult || forceBreak) {
          const msg = breakerResult
            ? breakerResult.message
            : `Session health critically low (${(healthScore * 100).toFixed(0)}%). Halting repeated attempts on ${entityKey}.`;
          result._meta.circuit_breaker = {
            entity: entityKey,
            attempts: breakerResult?.attempts ?? 0,
            message: msg,
          };
          this.effectivenessTracker?.recordCorrection(
            entityKey,
            "circuit_breaker"
          );
          this.behaviorEvents?.record({
            session_id: this.behaviorEvents.sessionId,
            turn: this.sessionContext.getToolCallCount(),
            type: "loop_broken",
            tool: toolName,
            entity_key: entityKey,
            response_bytes: null,
            detail: {
              attempts: breakerResult?.attempts ?? 0,
              forced_by_health: Boolean(forceBreak && !breakerResult),
              policy: "loop_breaker",
              action: "halted",
              reason: msg,
              ...(entityKey ? { target_entity: entityKey } : {}),
            },
          });
          // S9.7: Stderr notification on circuit break
          process.stderr.write(
            `[unerr] Circuit breaker: halting repeated attempts on ${entityKey}\n`
          );
          // S9.5: Increment caught counter for convention violations that triggered breaker
          if (this.sessionEvents) {
            this.sessionEvents.conventionViolationsCaught++;
          }

          if (this.eventBus) {
            this.eventBus.emit("circuit_breaker", {
              entity: entityKey,
              attempts: breakerResult?.attempts ?? 0,
              forced_by_health: Boolean(forceBreak && !breakerResult),
              message: msg,
            });
          }
        }
      }
    }

    // Honest accounting split:
    //   * fetch_url is COMPRESS-class. raw_bytes (what came off the wire) vs
    //     extracted_bytes (what reaches the agent) are physical measurements.
    //     Recorded to token_flow with mechanism "fetch_url".
    //   * Everything else here is PREVENT-class. We cannot measure "the grep
    //     and 5 file reads the agent didn't do" without inventing a number.
    //     Per RTK_VS_UNERR_PERCEPTION_GAP doc we ship discrete named events
    //     (graph_query_served, full_read_avoided) instead of fabricated ratios.
    //   * file_read has its own real measurement at the file-read protocol
    //     site (line ~1330) using actual char counts \u2014 left untouched here.
    let enrichTokensSaved = 0;
    let enrichSavingsMechanism: string | undefined;
    if (LOCAL_TOOLS.has(toolName) && toolName !== "file_read") {
      const turn = this.sessionContext.getToolCallCount();
      const entityKey = (args.key as string) ?? (args.name as string) ?? null;
      const responseBytes = this.estimateResponseBytes(result.content);

      if (toolName === "fetch_url") {
        const c = result.content as {
          raw_bytes?: number;
          extracted_bytes?: number;
          raw_tokens?: number;
          extracted_tokens?: number;
        };
        // Prefer real BPE token counts (estimateTokens on the raw page +
        // extracted markdown, set by fetch-url-protocol.ts). Fall back to the
        // byte/4 prose ratio only when they're absent (older result shapes).
        const tokensWithout =
          typeof c?.raw_tokens === "number"
            ? c.raw_tokens
            : Math.ceil(
                (typeof c?.raw_bytes === "number" ? c.raw_bytes : 0) / 4
              );
        const tokensWith =
          typeof c?.extracted_tokens === "number"
            ? c.extracted_tokens
            : Math.ceil(
                (typeof c?.extracted_bytes === "number"
                  ? c.extracted_bytes
                  : 0) / 4
              );
        const saved = Math.max(0, tokensWithout - tokensWith);
        if (saved > 0) {
          enrichTokensSaved = saved;
          enrichSavingsMechanism = "fetch_url";
          this.tokenFlow?.record({
            session_id: this.tokenFlow.sessionId,
            turn,
            mechanism: "fetch_url",
            tool: toolName,
            tokens_without: tokensWithout,
            tokens_with: tokensWith,
            tokens_saved: saved,
            detail: {
              raw_bytes:
                typeof c?.raw_bytes === "number" ? c.raw_bytes : undefined,
              extracted_bytes:
                typeof c?.extracted_bytes === "number"
                  ? c.extracted_bytes
                  : undefined,
              source:
                typeof c?.raw_tokens === "number"
                  ? "real-tokens"
                  : "measured-bytes",
            },
          });
          // Feed real-measurement values into legacy trackers. PREVENT-class
          // events (graph queries, behaviors) are intentionally excluded —
          // they record discrete counts via behaviorEvents, not synthetic
          // saved/used numbers.
          this.tokenCounter?.record(saved, tokensWithout);
          if (this.intentTracker && entityKey) {
            const activeIntentId = this.intentTracker.getActiveIntentId();
            if (activeIntentId) {
              this.intentTracker.recordToolCall(
                activeIntentId,
                tokensWith,
                saved,
                entityKey
              );
            }
          }
        }
      } else {
        // PREVENT-class: emit a verb-noun behavior event. file_outline /
        // get_file replace full file reads; everything else (search_code,
        // get_references, get_entity, file_connections, ...) is a graph
        // query.
        const isFileNav = toolName === "file_outline";
        const type = isFileNav ? "full_read_avoided" : "graph_query_served";
        // Normalize the recorded entity_key to a human-readable NAME. The agent
        // may look up an entity by name OR by the 16-char hex key it carried
        // forward from a prior result row (search_code / get_references return
        // `key` = hex). Storing the resolved name keeps end-of-turn receipts
        // ("looked up callers of classifyShellOutput") and downstream telemetry
        // consistent regardless of which form was passed.
        let recordedKey = entityKey;
        if (entityKey && /^[0-9a-f]{16}$/.test(entityKey)) {
          try {
            const resolved = await this.localGraph.getEntity(entityKey);
            if (resolved?.name) recordedKey = resolved.name;
          } catch {
            /* keep the hex key if the graph lookup fails — never block */
          }
        }
        this.behaviorEvents?.record({
          session_id: this.behaviorEvents.sessionId,
          turn,
          type,
          tool: toolName,
          entity_key: recordedKey,
          response_bytes: responseBytes,
        });
      }
    }

    // S3.3: Feed token estimates into context rot detector
    if (this.contextRotDetector) {
      const contentStr =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);
      this.contextRotDetector.recordToolCallTokens(estimateTokens(contentStr));

      // S3.4: Detect repeated queries via sessionContext cross-reference
      if (ENRICHABLE_TOOLS.has(toolName)) {
        const entityKey = (args.key as string) ?? (args.name as string);
        if (entityKey && this.sessionContext.hasHistory(entityKey)) {
          this.contextRotDetector.recordRepeatedQuery(entityKey);
        }
      }
    }

    // Skip enrichment in setup mode — no graph available
    if (this.currentMode === "setup") {
      return {
        tokensSaved: enrichTokensSaved,
        savingsMechanism: enrichSavingsMechanism,
      };
    }

    // S5.4: Compute token budget ceiling — skip context injection if content already at capacity
    const tokenBudget =
      typeof args.token_budget === "number" && args.token_budget >= 100
        ? args.token_budget
        : 2000;
    const contentForBudget =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    const tokensUsed = estimateTokens(contentForBudget);
    const atBudgetCeiling = tokensUsed >= tokenBudget;

    // S5.4: Skip all context injection if response content is at budget ceiling
    if (atBudgetCeiling) {
      // Still compute token accounting metadata, but skip _context to avoid bloat
      result._meta.tokens_budget = tokenBudget;
      result._meta.tokens_used = tokensUsed;
      result._meta.truncated = true;
      result._meta.full_tokens_estimate = tokensUsed;
      result._meta.truncation_level = "full";
      return {
        tokensSaved: enrichTokensSaved,
        savingsMechanism: enrichSavingsMechanism,
      };
    }

    const context: ContextHints = {};
    let hasContext = false;

    // ── Sprint 4: Structured Session Brief (first call only) ──────
    if (this.sessionContext.isFirstCall()) {
      // Build structured brief (replaces flat greeting + resume)
      try {
        const { SessionBriefBuilder, formatBriefAsVisibleBlock } = await import(
          "./session-brief-builder.js"
        );
        const briefBuilder = new SessionBriefBuilder(
          this.localGraph,
          this.factStore as any,
          this.graphStats,
          this.healthGrade
        );
        const brief = await briefBuilder.build(this.sessionResumeContext);
        context.session_brief = brief;
        hasContext = true;
        // MCP clients strip `_meta` before the model sees the response, so the
        // structured brief is invisible to the agent. Emit the same intel as
        // an inline `[unerr:session-resume]` block prepended to content[0].
        const elapsedMs = this.previousSessionEndedAt
          ? Date.now() - this.previousSessionEndedAt
          : undefined;
        const resumeBlock = formatBriefAsVisibleBlock(brief, elapsedMs);
        if (resumeBlock.length > 0) {
          result.content = prependAnnounceToBody(result.content, resumeBlock);
        }
      } catch {
        // Fallback to flat greeting if brief builder fails
        const greeting = this.buildSessionGreeting();
        if (greeting) {
          context.session_greeting = greeting;
          hasContext = true;
        }
        if (this.sessionResumeContext) {
          context.session_resume = this.sessionResumeContext;
          hasContext = true;
        }
      }
      this.sessionResumeContext = null; // One-time injection
      this.sessionContext.markGreeted();

      // Inject active skills context on first call so agent knows available intelligence
      try {
        const { getSkillsContext } = await import("../skills/local-pack.js");
        const skillsCtx = getSkillsContext();
        if (skillsCtx) {
          Object.assign(context, skillsCtx);
          hasContext = true;
        }
      } catch {
        // Non-blocking — skills context is optional enhancement
      }

      // Tool adoption nudge — keeps agent on unerr tools instead of built-ins.
      // Anti-drift signal; do NOT remove.
      context.tool_adoption = {
        hint: "This project has unerr graph intelligence tools. Use search_code (find entities), get_callers (find references), file_outline (file structure), file_read (read with context) INSTEAD OF built-in Grep/Glob/Read. Graph tools are faster (<5ms) and include project conventions.",
        tools_available: 18,
      };
      hasContext = true;
    }

    // ── Task 2.2 + 2.3 + 2.5 + 7.8: Entity-level enrichment ───
    if (ENRICHABLE_TOOLS.has(toolName)) {
      // Agents pass entity NAMES (e.g. "startMcpServer") but the graph stores
      // 16-char hex keys. Without resolution, getBlastRadius runs against the
      // literal name, returns 0 rows, and emits a misleading "No dependencies"
      // summary alongside a tool result that actually has callers/callees.
      // Resolve once here so every downstream query AND the session-context
      // caches use a single canonical key.
      const rawEntityArg = (args.key as string) ?? (args.name as string);
      // File-level tools (get_file, get_imports via key-aliasing, etc.) pass
      // file paths here, not entity names. Running blast-radius on a file path
      // yields 0 rows and prints a misleading "No dependencies" signal. Detect
      // path-shaped args and skip entity enrichment for them.
      const looksLikeFilePath =
        typeof rawEntityArg === "string" &&
        (rawEntityArg.includes("/") ||
          /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/.test(rawEntityArg));
      const entityKey =
        rawEntityArg && !looksLikeFilePath
          ? await this.resolveKeyArg(rawEntityArg)
          : null;
      if (entityKey) {
        // Tier-3: re-query of previously-seen entity is now signaled via
        // result._meta.context_complete=true → "ur|ctx already delivered" prefix.
        // The legacy `context.reminder = "Previously queried: N callers..."` was
        // redundant noise (showed up twice as ur|ctx + ur|fct). Drop it.
        if (this.sessionContext.hasHistory(entityKey)) {
          result._meta.context_complete = true;
        }

        let blastRadiusCount = 0;
        let riskLevel = "normal";

        // Task 2.2: Blast radius (first query per entity). Skip when the graph
        // does not implement getBlastRadius (a partial/mock store) so it does
        // not throw `is not a function` into a per-call warning; a present
        // method that throws still surfaces to the catch below.
        if (
          this.sessionContext.shouldInjectBlastRadius(entityKey) &&
          typeof this.localGraph.getBlastRadius === "function"
        ) {
          try {
            const br = await this.localGraph.getBlastRadius(entityKey);
            const brEntities =
              await this.localGraph.getBlastRadiusEntities(entityKey);
            result._meta.blast_radius = {
              direct_callers: br.direct_callers,
              direct_callees: br.direct_callees,
              transitive_depth2: br.transitive_count,
              is_chokepoint: br.is_chokepoint,
              affected_entities: brEntities.slice(0, 20),
            };
            context.blast_radius = br.summary;
            hasContext = true;
            blastRadiusCount = br.direct_callers;

            // S2.5: Feed blast radius into health monitor
            if (this.healthMonitor) {
              this.healthMonitor.recordBlastRadius(
                entityKey,
                br.direct_callers
              );
            }

            // Related issues from chokepoint detection
            if (br.is_chokepoint) {
              context.related_issues = context.related_issues ?? [];
              context.related_issues.push(
                "Chokepoint: high fan_in and fan_out \u2014 changes here have wide blast radius"
              );
              riskLevel = "high";
              // S9.5: Wire chokepoint warning into caught counter
              if (this.sessionEvents) {
                this.sessionEvents.chokepointWarningsIssued++;
              }
            }
          } catch (err: unknown) {
            process.stderr.write(
              `[unerr] ⚠ Blast radius query failed for ${entityKey}: ${formatUnknownError(err)}\n`
            );
          }
        }

        // Leapfrog Sprint A.3: Community context injection (after blast radius)
        try {
          // Optional enrichment method — a partial or mock graph may not
          // implement it. Skip silently when absent instead of throwing
          // `getCommunityForEntity is not a function` into a per-call warning.
          // A method that IS present but throws still surfaces to the catch.
          const getCommunity = this.localGraph.getCommunityForEntity;
          const communityInfo =
            typeof getCommunity === "function"
              ? await getCommunity.call(this.localGraph, entityKey)
              : null;
          if (communityInfo && communityInfo.id >= 0) {
            // SC-D.3: name the community by its voted domain when one exists.
            const domainVote = await this.lookupCommunityDomain(
              communityInfo.id
            );
            result._meta.community = {
              id: communityInfo.id,
              label: communityInfo.label,
              size: communityInfo.size,
              cohesion: communityInfo.cohesion,
              ...(domainVote
                ? {
                    domain: domainVote.domain,
                    domain_purity: domainVote.purity,
                  }
                : {}),
            };
            // SC-D.3: prefer the voted domain name over the bare cluster label.
            const named = domainVote
              ? `Domain "${domainVote.domain}" (community ${communityInfo.label}, purity ${Math.round(domainVote.purity * 100)}%, ${communityInfo.size} entities, cohesion ${communityInfo.cohesion})`
              : `Community "${communityInfo.label}" (${communityInfo.size} entities, cohesion ${communityInfo.cohesion})`;
            const crossEdges =
              await this.localGraph.getCrossCommunityEdges(entityKey);
            if (crossEdges.length > 0) {
              result._meta.cross_community_edges = crossEdges
                .slice(0, 10)
                .map((e) => ({
                  entity_key: e.entity_key,
                  entity_name: e.entity_name,
                  entity_community_label: e.entity_community_label,
                  relation: e.relation,
                }));
              result._meta.cross_community_count = crossEdges.length;
              context.community = `${named}. ${crossEdges.length} cross-community connection${crossEdges.length !== 1 ? "s" : ""} to: ${[...new Set(crossEdges.map((e) => e.entity_community_label))].join(", ")}`;
            } else {
              context.community = `${named}. No cross-community connections.`;
            }
            hasContext = true;
          }
        } catch (err: unknown) {
          process.stderr.write(
            `[unerr] ⚠ Community query failed: ${formatUnknownError(err)}\n`
          );
        }

        // Determine risk level from entity if not already set
        if (riskLevel === "normal") {
          try {
            const entity = await this.localGraph.getEntity(entityKey);
            if (entity?.risk_level) {
              riskLevel = entity.risk_level;
            }
          } catch (err: unknown) {
            process.stderr.write(
              `[unerr] ⚠ Entity risk lookup failed: ${formatUnknownError(err)}\n`
            );
          }
        }

        // Leapfrog Sprint B.3: Correction injection (deduped per entity+errorType)
        try {
          // Optional enrichment method — skip silently when the graph does not
          // implement it (partial/mock store) instead of throwing
          // `getCorrections is not a function` on every call. A present method
          // that throws still surfaces to the catch below.
          const getCorrections = this.localGraph.getCorrections;
          const corrections =
            typeof getCorrections === "function"
              ? await getCorrections.call(this.localGraph, entityKey, 0.7)
              : [];
          const newCorrections = corrections.filter((c) =>
            this.sessionContext.shouldInjectCorrection(
              c.entity_key,
              c.error_type
            )
          );
          if (newCorrections.length > 0) {
            result._meta.corrections = newCorrections.map((c) => ({
              entity_key: c.entity_key,
              error_type: c.error_type,
              confidence: c.confidence,
              occurrences: c.occurrences,
            }));
            context.corrections = newCorrections.map(
              (c) =>
                `WARNING: ${c.correction_summary} (confidence: ${c.confidence}, seen ${c.occurrences}x)`
            );
            hasContext = true;
          }
        } catch (err: unknown) {
          process.stderr.write(
            `[unerr] ⚠ Correction query failed: ${formatUnknownError(err)}\n`
          );
        }

        // S7.5: Durability scoring — warn on fragile entities (score < 0.5)
        if (this.durabilityScorer) {
          try {
            const durScore = this.durabilityScorer.getScore(entityKey);
            if (durScore && durScore.score < 0.5) {
              result._meta.durability = {
                score: durScore.score,
                modificationCount: durScore.modificationCount,
                avgSurvivalMs: durScore.avgSurvivalMs,
              };
              context.durability_warning = `FRAGILE: "${entityKey}" has durability ${durScore.score.toFixed(2)} (modified ${durScore.modificationCount}x, avg survival ${Math.round(durScore.avgSurvivalMs / 60000)}min). AI changes here rarely stick — consider a different approach.`;
              hasContext = true;

              // S7.8: Feed durability into session health monitor
              if (this.healthMonitor) {
                this.healthMonitor.recordDurability(entityKey, durScore.score);
              }
            }
          } catch (err: unknown) {
            process.stderr.write(
              `[unerr] ⚠ Durability lookup failed: ${formatUnknownError(err)}\n`
            );
          }
        }

        // S7.6: Anti-pattern injection from negative knowledge
        if (this.antiPatternEntries.length > 0) {
          const entityPatterns = this.antiPatternEntries.filter(
            (e) => e.entityKey === entityKey
          );
          if (entityPatterns.length > 0) {
            context.anti_patterns = entityPatterns.map(
              (p) => `ANTI-PATTERN: ${p.pattern} — ${p.reason}`
            );
            hasContext = true;
          }
        }

        // Q.1: Causal bridge — inject entity interaction history
        if (this.causalBridge) {
          try {
            const chain = await this.causalBridge.buildCausalChain(entityKey);
            if (chain.interactions.length > 0) {
              result._meta.causal_history = {
                durability: chain.durability,
                interactions: chain.interactions.length,
                failure_modes: chain.failureModes,
              };
              const recentInteractions = chain.interactions.slice(-3);
              context.history = recentInteractions.map(
                (i) =>
                  `${i.outcome === "survived" ? "✓" : "✗"} ${i.prompt.slice(0, 60)} (${i.outcome}, ${Math.round(i.survivalMs / 3600000)}h)`
              );
              hasContext = true;
            }
          } catch (err: unknown) {
            process.stderr.write(
              `[unerr] ⚠ Causal bridge query failed: ${formatUnknownError(err)}\n`
            );
          }
        }

        // Q.3: Inject learned conventions from cross-session correction analysis
        if (this.learnedConventions.length > 0) {
          const entityName = entityKey.split("::").pop() ?? entityKey;
          const applicable = this.learnedConventions.filter(
            (c) =>
              c.confidence >= 0.6 &&
              entityKey.includes(c.pattern.split(" ")[0] ?? "")
          );
          if (applicable.length > 0) {
            context.learned_conventions = applicable.map(
              (c) =>
                `LEARNED: ${c.name} (confidence: ${c.confidence.toFixed(2)})`
            );
            hasContext = true;
          }
        }

        // Q.1: Prompt durability — inject strategy recommendations for high-risk entities
        if (
          this.promptDurabilityProfiles.length > 0 &&
          riskLevel !== "normal"
        ) {
          const lowDurability = this.promptDurabilityProfiles.filter(
            (p) => p.durability < 0.5 && p.recommendation
          );
          if (lowDurability.length > 0) {
            context.prompt_strategy = lowDurability
              .slice(0, 2)
              .map((p) => p.recommendation!);
            hasContext = true;
          }
        }

        // Task 2.3: Convention injection (deduped per convention ID)
        try {
          const entity = await this.localGraph.getEntity(entityKey);
          const getConventions = this.localGraph.getConventionsForEntity;
          if (entity && typeof getConventions === "function") {
            const conventions = await getConventions.call(
              this.localGraph,
              entity.file_path
            );
            const newConventions = conventions.filter((c) =>
              this.sessionContext.shouldInjectConvention(c.id)
            );
            if (newConventions.length > 0) {
              result._meta.conventions = newConventions.map((c) => ({
                name: c.name,
                adherence_pct: c.adherence_pct,
                rule: c.rule,
              }));
              // Sprint 5: Prescriptive convention mode — actionable guidance instead of flat descriptions
              const { getSignalScorer } = await import("./signal-scorer.js");
              const scorer = getSignalScorer();
              context.conventions = newConventions.map((c) => {
                const signal = scorer.conventionToSignal(
                  {
                    name: c.name,
                    rule: c.rule,
                    adherence_pct: c.adherence_pct,
                    kind: (c as any).kind ?? "entity",
                  },
                  toolName
                );
                return signal.action
                  ? `${signal.content} — ${signal.action}`
                  : signal.content;
              });
              hasContext = true;
              this.sessionContext.recordConventions(
                newConventions.map((c) => c.id)
              );
              if (this.effectivenessTracker) {
                const turn = this.sessionContext.getToolCallCount();
                const entityKey =
                  ((args as Record<string, unknown>).key as
                    | string
                    | undefined) ??
                  ((args as Record<string, unknown>).name as
                    | string
                    | undefined) ??
                  null;
                for (const c of newConventions) {
                  this.effectivenessTracker.recordSignalFired({
                    kind: "convention_injected",
                    signal_id: c.id,
                    entity_key: entityKey,
                    turn,
                  });
                }
              }

              // S2.6: Feed convention violations into health monitor (adherence < 70%)
              const violations = newConventions.filter(
                (c) => c.adherence_pct < 70
              );
              if (this.healthMonitor) {
                for (const _v of violations) {
                  this.healthMonitor.recordConventionViolation();
                }
              }
              // S9.5: Wire convention violations into caught counter
              if (this.sessionEvents && violations.length > 0) {
                this.sessionEvents.conventionViolationsCaught +=
                  violations.length;
              }
            }
          }
        } catch (err: unknown) {
          process.stderr.write(
            `[unerr] ⚠ Convention lookup failed: ${formatUnknownError(err)}\n`
          );
        }

        // Task 2.5: Proactive drift alert (deduped per entity)
        if (this.sessionContext.shouldInjectRisk(entityKey)) {
          try {
            const driftMeta = result._meta.drift;
            if (
              driftMeta?.entityStatus === "modified" ||
              driftMeta?.entityStatus === "added"
            ) {
              const br = result._meta.blast_radius;
              const affectedCount = br ? br.direct_callers : 0;
              context.drift_alert = `WARNING: ${entityKey} has been ${driftMeta.entityStatus} locally${affectedCount > 0 ? `, ${affectedCount} caller${affectedCount !== 1 ? "s" : ""} may be affected` : ""}`;
              hasContext = true;
              this.sessionContext.recordRisk(entityKey);
            }
          } catch (err: unknown) {
            process.stderr.write(
              `[unerr] ⚠ Drift alert failed: ${formatUnknownError(err)}\n`
            );
          }
        }

        // Task 7.8: Record entity history on first query for post-compaction recovery
        if (!this.sessionContext.hasHistory(entityKey)) {
          this.sessionContext.recordEntityHistory(
            entityKey,
            blastRadiusCount,
            riskLevel
          );
        }

        // Record this entity as queried (dedup future calls)
        this.sessionContext.recordQuery(entityKey);
      }
    }

    // ── Sprint 1.2: Fact injection into _context (visible to agents) ──
    if (this.factStore) {
      const filePath =
        (args.file_path as string) ??
        (args.path as string) ??
        (args.key as string)?.split("::")[0] ??
        null;
      if (filePath) {
        try {
          let merged: Array<{
            fact_id: string;
            fact_type: string;
            content: string;
            effective_confidence: number;
            source: string;
          }>;

          if (toolName === "file_read") {
            const entityKeys = await this.getEntityKeysForFile(filePath);
            merged = await this.factStore.recallForFile(filePath, entityKeys);
          } else {
            const [fileFacts, negativeFacts] = await Promise.all([
              this.factStore.recallByScope(filePath),
              this.factStore.recallNegative(0.2),
            ]);
            const seen = new Set<string>();
            merged = [];
            for (const f of fileFacts) {
              if (!seen.has(f.fact_id)) {
                seen.add(f.fact_id);
                merged.push(f);
              }
            }
            for (const f of negativeFacts) {
              if (!seen.has(f.fact_id)) {
                seen.add(f.fact_id);
                merged.push(f);
              }
            }
          }

          // Dedup: only inject facts not yet delivered this session
          const newFacts = merged.filter((f) =>
            this.sessionContext.shouldInjectFact(f.fact_id)
          );
          if (newFacts.length > 0) {
            const top = newFacts.slice(0, 5);
            for (const f of top) this.factsSurfaced.push(f.fact_id);
            this.sessionContext.recordFacts(top.map((f) => f.fact_id));
            // Table rows #16/17/18 CUT-FLUFF — drop "(confidence:…, source:…)"
            // telemetry suffix from fact emissions. The dashboard reads
            // confidence/source via the structured /api/facts route; the
            // agent's context window does not benefit from these fields.
            context.relevant_facts = top.map((f) => {
              return `[${f.fact_type}] ${f.content}`;
            });
            hasContext = true;
            if (this.effectivenessTracker) {
              const turn = this.sessionContext.getToolCallCount();
              const entityKey =
                ((args as Record<string, unknown>).key as string | undefined) ??
                ((args as Record<string, unknown>).name as
                  | string
                  | undefined) ??
                null;
              for (const f of top) {
                this.effectivenessTracker.recordSignalFired({
                  kind:
                    f.fact_type === "negative"
                      ? "negative_warned"
                      : "fact_injected",
                  signal_id: f.fact_id,
                  entity_key: entityKey,
                  turn,
                  // L2: thread the fact text so persistent_memory events name
                  // the actual note in the Logbook, not "a remembered signal".
                  content: f.content,
                });
              }
            }
          }
        } catch {
          // Fact recall failure is non-critical
        }
      }
    }

    // ── Task 2.7: Value Counter (every 3rd caught event) ─────────
    if (this.sessionEvents) {
      const counter = this.sessionContext.getValueCounter(this.sessionEvents);
      if (counter) {
        context.value_counter = counter;
        hasContext = true;
      }
    }

    // ── Sprint 3.2: Co-change prediction (GraphTemporalJoiner) ──
    if (this.localGraph && ENRICHABLE_TOOLS.has(toolName)) {
      const filePath =
        (args.file_path as string) ??
        (args.path as string) ??
        (args.name as string);
      if (filePath && typeof filePath === "string" && filePath.includes("/")) {
        try {
          const { GraphTemporalJoiner } = await import(
            "./graph-temporal-joiner.js"
          );
          const joiner = new GraphTemporalJoiner(
            this.localGraph,
            this.factStore ? (this.factStore as any) : null
          );
          const coChanges = await joiner.predictCoChanges(filePath);
          const topCoChange = coChanges[0];
          if (
            coChanges.length > 0 &&
            topCoChange &&
            topCoChange.combined_score > 0.3
          ) {
            const topFiles = coChanges
              .slice(0, 3)
              .map((c) => c.file_b)
              .join(", ");
            // Table row #15 TRIM — "co-changes (N edges): files" is tighter
            // than "Often changed together: files (N shared edges)".
            context.co_changes = `co-changes (${topCoChange.evidence}): ${topFiles}`;
            hasContext = true;
          }

          // ── Sprint 6: Hidden coupling detection ──
          const hidden = await joiner.detectHiddenCouplings();
          const topHidden = hidden.filter(
            (h: { file_a: string; file_b: string }) =>
              h.file_a === filePath || h.file_b === filePath
          );
          if (topHidden.length > 0) {
            const hiddenFile = topHidden[0];
            if (hiddenFile) {
              const otherFile =
                hiddenFile.file_a === filePath
                  ? hiddenFile.file_b
                  : hiddenFile.file_a;
              context.co_changes = `${context.co_changes ? `${context.co_changes}. ` : ""}Hidden dependency: ${otherFile} (${hiddenFile.evidence})`;
              hasContext = true;
            }
          }
        } catch {
          // Co-change prediction is non-critical
        }
      }
    }

    // ── Task 7.3: Push-based pending violations ─────────────────
    if (this.pendingViolations?.hasPending) {
      const violations = this.pendingViolations.drain();
      if (violations) {
        context.pending_violations = violations;
        hasContext = true;
      }
    }

    if (hasContext) {
      // Session dedup operates on raw context fields (before signal conversion)
      let dedupedContext = orderContextFields(context);

      // S1.4: Apply session dedup — filter already-delivered context keys per entity
      if (this.sessionDedup && ENRICHABLE_TOOLS.has(toolName)) {
        const entityKey = (args.key as string) ?? (args.name as string);
        if (entityKey) {
          const preFilterKeys = Object.keys(dedupedContext);
          dedupedContext = orderContextFields(
            this.sessionDedup.filter(
              entityKey,
              dedupedContext as Record<string, unknown>
            ) as ContextHints
          );

          // Layer 10: Record session dedup savings
          if (this.tokenFlow) {
            const postFilterKeys = new Set(Object.keys(dedupedContext));
            const dedupedKeys = preFilterKeys.filter(
              (k) => !postFilterKeys.has(k)
            );
            if (dedupedKeys.length > 0) {
              const dedupedContent = dedupedKeys
                .map((k) =>
                  JSON.stringify((context as Record<string, unknown>)[k])
                )
                .join("");
              const dedupedTokens = estimateTokens(dedupedContent);
              this.tokenFlow.record({
                session_id: this.tokenFlow.sessionId,
                turn: this.sessionContext.getToolCallCount(),
                mechanism: "session_dedup",
                tool: toolName,
                tokens_without: dedupedTokens,
                tokens_with: 0,
                tokens_saved: dedupedTokens,
                detail: { keys_deduped: dedupedKeys.length },
              });
            }
          }

          // Cross-session context ledger — skip context already delivered in prior sessions
          if (this.contextLedger) {
            const deliveredKeys: string[] = [];
            for (const key of Object.keys(dedupedContext)) {
              if (this.contextLedger.hasDelivered(entityKey, key)) {
                delete (dedupedContext as Record<string, unknown>)[key];
              } else {
                deliveredKeys.push(key);
              }
            }
            if (deliveredKeys.length > 0) {
              this.contextLedger.markDelivered(entityKey, deliveredKeys);
            }
          }
        }
      }

      // Three-Layer Experience: Detect decision level + convert to ranked signals
      const { getDecisionPointDetector } = await import(
        "./decision-point-detector.js"
      );
      const decisionLevel = getDecisionPointDetector().detect(
        toolName,
        args,
        this.sessionContext
      );
      const signalOutput = await assembleContextOutput(
        dedupedContext,
        toolName,
        args,
        decisionLevel,
        this.sessionContext
      );

      if (Object.keys(signalOutput).length > 0) {
        result._context = signalOutput;
      } else if (hasContext) {
        // BA-4.2: All context was already delivered — signal agent to skip restatement
        result._meta.context_complete = true;
      }

      // Sprint 9.3: Track signal delivery stats
      this.signalDeliveryStats.total_tool_calls++;
      const deliveredSignals = (signalOutput as Record<string, unknown>)
        .signals as Array<{ type: string }> | undefined;
      if (deliveredSignals && deliveredSignals.length > 0) {
        this.signalDeliveryStats.tool_calls_with_signals++;
        this.signalDeliveryStats.total_delivered += deliveredSignals.length;
        for (const s of deliveredSignals) {
          this.signalDeliveryStats.by_type[s.type] =
            (this.signalDeliveryStats.by_type[s.type] ?? 0) + 1;
        }
      }
    }
    if (ENRICHABLE_TOOLS.has(toolName)) {
      const entityKey = (args.key as string) ?? (args.name as string);
      if (entityKey) {
        const now = Date.now();
        const lastQuery = this.recentEntityQueries.get(entityKey);
        const isRetry = lastQuery !== undefined && now - lastQuery < 60_000;
        if (isRetry) {
          this.sessionLegend.invalidateAll();
          this.compressionMonitor?.recordLayer6Retry(toolName);
        }
        if (this.compressionMonitor) {
          this.compressionMonitor.recordAgentAction(entityKey, isRetry, false);
        }
        this.recentEntityQueries.set(entityKey, now);
        // RC-5: Evict oldest entries if map exceeds limit
        if (this.recentEntityQueries.size > 500) {
          const iter = this.recentEntityQueries.keys();
          for (let i = 0; i < 100; i++) {
            const k = iter.next().value;
            if (k !== undefined) this.recentEntityQueries.delete(k);
          }
        }
      }
    }

    // S3.6-S3.8: Evaluate context rot every 10th tool call
    if (
      this.contextRotDetector &&
      this.sessionContext.getToolCallCount() % 10 === 0
    ) {
      const rotSignal = this.contextRotDetector.evaluate();
      if (rotSignal.action === "inject_refresh") {
        // S3.7: Add session warning with refresh context
        const refreshData = this.contextRotDetector.getRefreshContext();
        if (refreshData) {
          if (!result._context) result._context = {} as ContextHints;
          (result._context as Record<string, unknown>).session_warning =
            refreshData;
        }
      } else if (rotSignal.action === "suggest_new_session") {
        // S3.8: Propagate to _meta.session_health with new-session recommendation
        result._meta.session_health = {
          health: Math.round((1 - rotSignal.rotConfidence) * 100) / 100,
          recommendation: "suggest_new_session",
          signals: rotSignal.signals.map((s) => s.type),
        };
      }
    }

    // S2.9: Inject session health warning when health drops below 0.6
    if (this.healthMonitor && !result._meta.session_health) {
      const healthSignal = this.healthMonitor.getHealth();
      if (healthSignal.health < 0.6) {
        result._meta.session_health = {
          health: Math.round(healthSignal.health * 100) / 100,
          recommendation: healthSignal.recommendation,
          signals: healthSignal.signals.map((s) => s.type),
        };
      }
    }

    // ── Leapfrog Sprint C: Token accounting on every response ──────
    result._meta.tokens_budget = tokenBudget;
    result._meta.tokens_used = tokensUsed;
    result._meta.truncated = tokensUsed > tokenBudget;
    if (tokensUsed > tokenBudget) {
      result._meta.full_tokens_estimate = tokensUsed;
      result._meta.truncation_level = "full";
    }

    return {
      tokensSaved: enrichTokensSaved,
      savingsMechanism: enrichSavingsMechanism,
    };
  }

  /**
   * Build session greeting based on health grade (Task 2.6).
   * Max 200 tokens. Content varies by grade and mode.
   */
  private buildSessionGreeting(): string | null {
    if (this.currentMode === "parse") {
      return "unerr is running in parse mode — basic code structure available. Link your repo with 'unerr' to unlock full graph intelligence.";
    }

    if (!this.healthGrade || !this.graphStats) {
      return "unerr proxy ready. Graph intelligence active.";
    }

    const { entities, edges, rules } = this.graphStats;
    const grade = this.healthGrade;

    if (grade === "A" || grade === "A+") {
      return `Your codebase scores ${grade} — ${entities} entities, ${edges} edges, ${rules} rules tracked. Architecture is healthy. unerr is watching for regressions.`;
    }
    if (grade === "B" || grade === "B+") {
      return `Codebase health: ${grade}. Tracking ${entities} entities across ${edges} edges with ${rules} rules. Some areas could improve — I'll flag specific issues as you work.`;
    }
    if (grade.startsWith("C")) {
      return `Heads up: codebase health is ${grade}. ${entities} entities tracked, ${rules} rules active. There are structural issues that affect maintainability — ask me about high-risk areas.`;
    }
    // D or F
    return `Warning: codebase health is ${grade}. Significant structural issues detected across ${entities} entities. I'll actively flag risks as you work. Consider running 'unerr status' for details.`;
  }

  /** Layer 6 — token estimate for encoding tier / legend budgeting. */
  private estimateLayer6Tokens(content: unknown): number {
    if (typeof content === "string") return estimateTokens(content);
    try {
      return estimateTokens(JSON.stringify(content));
    } catch {
      return 2000;
    }
  }

  /**
   * S1: Compress large text tool output if it exceeds 2K tokens.
   * Uses graph-aware compression with entity risk map from CozoDB.
   * Feeds compression events into quality monitor for adaptive behavior.
   */
  private async maybeCompressContent(
    toolName: string,
    result: unknown,
    meta: ToolResult["_meta"]
  ): Promise<unknown> {
    // Apply smart truncation to entity objects from get_function/get_class/get_file
    if (
      typeof result === "object" &&
      result !== null &&
      "signature" in result &&
      "body" in result &&
      (toolName === "get_function" || toolName === "get_class")
    ) {
      const entity = result as {
        key?: string;
        name?: string;
        kind?: string;
        file_path?: string;
        start_line?: number;
        fan_in?: number;
        fan_out?: number;
        risk_level?: string;
        community?: number;
        signature?: string;
        body?: string;
      };

      // Build metadata section from entity fields
      const metadataLines = [
        entity.name ? `name: ${entity.name}` : "",
        entity.kind ? `kind: ${entity.kind}` : "",
        entity.file_path
          ? `file: ${entity.file_path}${entity.start_line ? `:${entity.start_line}` : ""}`
          : "",
        entity.fan_in !== undefined ? `fan_in: ${entity.fan_in}` : "",
        entity.fan_out !== undefined ? `fan_out: ${entity.fan_out}` : "",
        entity.risk_level ? `risk: ${entity.risk_level}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const fullContent = [metadataLines, entity.signature, entity.body]
        .filter(Boolean)
        .join("\n\n");
      const fullTokens = estimateTokens(fullContent);
      const budget = (meta as Record<string, unknown>).token_budget_override
        ? ((meta as Record<string, unknown>).token_budget_override as number)
        : 2000;

      // Only truncate if content exceeds budget
      if (fullTokens > budget) {
        const truncated = smartTruncate({
          metadata: metadataLines,
          imports: "", // Entities don't have a separate imports section
          signatures: entity.signature ?? "",
          bodies: entity.body ?? "",
          budget,
          // T1.4: cache the full entity body so a follow-up read pulls back only
          // the withheld window via cache_ref. Keyed on the file path so a
          // changed file forces a miss → recompute (staleness guard).
          cacheOriginal: (full) =>
            getSharedReversibleCache().put(full, {
              file: entity.file_path,
            }),
        });

        meta.truncated = truncated.truncated;
        meta.truncation_level = truncated.truncation_level;
        meta.tokens_used = truncated.tokens_used;
        meta.tokens_budget = truncated.tokens_budget;
        meta.full_tokens_estimate = truncated.full_tokens_estimate;

        // §4: record the smart-truncation event on compression_events with its
        // reversible cache_ref so the dashboard pairs it to a later retrieve.
        if (truncated.truncated) {
          try {
            const { appendCompressionLog } = await import(
              "../proxy/shell-compression-log.js"
            );
            appendCompressionLog(this.projectRoot ?? process.cwd(), {
              ts: new Date().toISOString(),
              command: toolName,
              category: "smart_truncation",
              confidence: 1,
              rawBytes: truncated.full_tokens_estimate,
              compressedBytes: truncated.tokens_used,
              savedPct:
                truncated.full_tokens_estimate > 0
                  ? Math.max(
                      0,
                      1 - truncated.tokens_used / truncated.full_tokens_estimate
                    )
                  : 0,
              omniFallback: false,
              reversible: {
                event_kind: "compress",
                mechanism: "smart_truncation",
                original_tokens: truncated.full_tokens_estimate,
                delivered_tokens: truncated.tokens_used,
                ...(truncated.cache_ref
                  ? { cache_ref: truncated.cache_ref }
                  : {}),
              },
            });
          } catch {
            /* best effort — metrics never block the wire */
          }
        }

        // Layer 10: Record smart truncation savings
        if (truncated.truncated && this.tokenFlow) {
          const truncSaved =
            truncated.full_tokens_estimate - truncated.tokens_used;
          if (truncSaved > 0) {
            this.tokenFlow.record({
              session_id: this.tokenFlow.sessionId,
              turn: this.sessionContext.getToolCallCount(),
              mechanism: "smart_truncation",
              tool: toolName,
              tokens_without: truncated.full_tokens_estimate,
              tokens_with: truncated.tokens_used,
              tokens_saved: truncSaved,
              detail: { level: truncated.truncation_level },
            });
          }
        }

        // Return the entity with truncated content inlined
        return {
          ...entity,
          body: truncated.content,
          signature: undefined, // Already included in truncated content
          _truncation: {
            level: truncated.truncation_level,
            tokens_used: truncated.tokens_used,
            full_tokens: truncated.full_tokens_estimate,
          },
        };
      }

      return result;
    }

    // Apply list truncation to array results from get_callers/get_callees/search_code
    if (Array.isArray(result) && result.length > 0) {
      const budget = 2000;
      const truncatedList = truncateResultList(result, budget, (item) =>
        JSON.stringify(item)
      );
      if (truncatedList.truncated) {
        meta.truncated = true;
        meta.tokens_used = truncatedList.tokens_used;
        meta.tokens_budget = budget;
        const fullTokensEst = estimateTokens(
          result.map((i) => JSON.stringify(i)).join("\n")
        );
        meta.full_tokens_estimate = fullTokensEst;

        // Layer 10: Record list truncation savings
        if (this.tokenFlow) {
          const listTruncSaved = fullTokensEst - truncatedList.tokens_used;
          if (listTruncSaved > 0) {
            this.tokenFlow.record({
              session_id: this.tokenFlow.sessionId,
              turn: this.sessionContext.getToolCallCount(),
              mechanism: "smart_truncation",
              tool: toolName,
              tokens_without: fullTokensEst,
              tokens_with: truncatedList.tokens_used,
              tokens_saved: listTruncSaved,
              detail: {
                type: "list",
                total: truncatedList.total,
                returned: truncatedList.items.length,
              },
            });
          }
        }

        return {
          items: truncatedList.items,
          total: truncatedList.total,
          returned: truncatedList.items.length,
          _truncation: {
            truncated: true,
            total: truncatedList.total,
            returned: truncatedList.items.length,
          },
        };
      }
      return result;
    }

    // Only compress string content — structured objects pass through
    if (typeof result !== "string" || isStructuredContent(result))
      return result;

    // file_read produces a pre-windowed slice (entity-aware slicing, budget-derived
    // line limits, log-tail optimization, outline fallback). Section compression
    // here would re-order content by score, duplicate the preserved head, and
    // mislabel source lines as "error" sections. Skip it.
    if (toolName === "file_read") return result;

    const tokenCount = estimateTokens(result);
    if (tokenCount <= 2000) return result;

    // Determine content type from tool name
    const contentType = this.inferContentType(toolName);

    // Get adaptive token budget from quality monitor (or default 2000)
    const retention = this.compressionMonitor?.getRetention(contentType) ?? 0.5;
    const tokenBudget = Math.max(800, Math.floor(tokenCount * retention));

    // Build entity risk map from graph for intelligent prioritization
    const entityRiskMap = await this.buildEntityRiskMap(result);

    const compressed = compressOutput(result, {
      tokenBudget,
      entityRiskMap,
    });

    // Feed compression event into quality monitor
    if (this.compressionMonitor) {
      const compressionId = `${toolName}-${Date.now()}`;
      const ratio = compressed.compressedTokens / compressed.originalTokens;
      this.compressionMonitor.recordCompression(
        compressionId,
        contentType,
        ratio
      );
    }

    // Apply budget enforcer as final cap (4K token ceiling)
    const enforced = enforceBudget(compressed.output, 4000);
    if (enforced.truncated) {
      meta.truncated = true;
      meta.full_tokens_estimate = compressed.originalTokens;
    }

    return enforced.content;
  }

  /**
   * S1: Infer content type from tool name for compression quality tracking.
   */
  private inferContentType(toolName: string): ContentType {
    switch (toolName) {
      case "search_code":
        return "generic";
      default:
        return "generic";
    }
  }

  /**
   * S2: Estimate result size (number of items/entities) for exploration cost calculation.
   */
  /** Measured size (bytes) of the response content delivered to the agent.
   *  Used as the `response_bytes` field on behavior_events so the dashboard
   *  can show what each graph query actually returned, without claiming any
   *  counterfactual savings. */
  private estimateResponseBytes(content: unknown): number {
    if (content === null || content === undefined) return 0;
    if (typeof content === "string") return content.length;
    try {
      return JSON.stringify(content).length;
    } catch {
      return 0;
    }
  }

  /**
   * S1: Build entity risk map from CozoDB for graph-aware compression.
   * Extracts file paths mentioned in text and queries their risk levels.
   */
  private async buildEntityRiskMap(
    text: string
  ): Promise<Map<string, EntityRiskInfo>> {
    const riskMap = new Map<string, EntityRiskInfo>();
    try {
      // Extract file paths from text (diff headers, error lines, etc.)
      const filePathPattern = /(?:^|\s)([\w/.]+\.[a-z]{1,4})(?:\s|:|$)/gm;
      const seen = new Set<string>();
      let match: RegExpExecArray | null;
      match = filePathPattern.exec(text);
      while (match !== null) {
        const filePath = match[1]!;
        if (seen.has(filePath)) {
          match = filePathPattern.exec(text);
          continue;
        }
        seen.add(filePath);
        if (seen.size > 20) break; // Cap to avoid expensive queries

        const entities = await this.localGraph.getEntitiesByFile(filePath);
        for (const entity of entities) {
          if (riskMap.has(entity.key)) continue;
          const br = await this.localGraph.getBlastRadius(entity.key);
          riskMap.set(entity.key, {
            riskLevel: br.is_chokepoint
              ? "high"
              : br.direct_callers > 5
                ? "medium"
                : "normal",
            fanIn: br.direct_callers,
            isChokepoint: br.is_chokepoint,
          });
        }
        match = filePathPattern.exec(text);
      }
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ Risk map construction failed: ${formatUnknownError(err)}\n`
      );
    }
    return riskMap;
  }

  /**
   * Raw local tool execution for the warm recon composer (`unerr_context`).
   *
   * `composeRecon` needs the structured shapes the graph tools produce — entity
   * arrays from search_code, `{references,…}` from get_references, `{naming,…}`
   * from get_conventions — NOT the columnar/json wire strings `execute()` emits
   * (Layer-6 formatting + budget pipeline). This exposes the otherwise-private
   * local dispatch so the in-process recon runner gets those shapes directly.
   * Pass any LOCAL_TOOLS name; the composer only ever calls search_code,
   * get_references, and get_conventions through it.
   */
  /**
   * Workspace-scoped fan-out (CROSS_REPO_INTELLIGENCE Sprint 3). Merges at the
   * STRUCTURED layer: the home result comes from `executeRaw` (not the columnar-
   * formatted `execute` output) so home rows and peer rows share one shape and
   * merge cleanly with per-repo labels. Both sides force `scope:'repo'`, so a
   * federated call can never re-federate. On free tier the coordinator refuses
   * and the home-only result is returned with an upgrade nudge — never an error.
   * The merged structured content is wrapped as a ToolResult; the proxy applies
   * the final wire encoding once (cross-repo rows skip the home columnar legend).
   */
  /**
   * Record one `cross_repo_access` behavior event per workspace tool call that
   * reached the federation path (CROSS_REPO_INTELLIGENCE Sprint 5.1). Additive
   * telemetry — drains through the existing C1 `events` projection. Best-effort:
   * a missing writer or a record failure never affects the tool result.
   */
  private recordCrossRepoAccess(
    toolName: string,
    info: { peers: number; partial: boolean; refused: boolean }
  ): void {
    const writer = this.behaviorEvents;
    if (!writer) return;
    try {
      writer.record({
        session_id: writer.sessionId,
        type: "cross_repo_access",
        tool: toolName,
        entity_key: null,
        response_bytes: null,
        detail: {
          peers: info.peers,
          partial: info.partial,
          refused: info.refused,
        },
      });
    } catch {
      // Telemetry is never load-bearing — swallow.
    }
  }

  private async executeWorkspace(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const t0 = performance.now();
    const coord = this.federationCoordinator;
    const repoArgs = { ...args, scope: "repo" };
    const homeContent = await this.executeRaw(toolName, repoArgs);
    const meta: ToolResult["_meta"] = { source: "local", latency_ms: 0 };

    if (!coord) {
      meta.latency_ms = performance.now() - t0;
      return { content: homeContent, _meta: meta };
    }

    const homeRepo = this.projectRoot ?? process.cwd();
    const fan = await coord.fanOut({ homeRepo, toolName, args: repoArgs });

    if (fan.refused) {
      meta.workspace_refused = fan.refused.message;
      meta.latency_ms = performance.now() - t0;
      this.recordCrossRepoAccess(toolName, {
        peers: 0,
        partial: false,
        refused: true,
      });
      // Issue 1 + 8: free tier / refused fan-out → yielded silently to the home
      // repo (no agent surface). Record the wall-hit for the savings-origin
      // rollup so we know how often users hit it.
      this.emitCrossRepoSavings("cross_repo_yielded_free", toolName, 0);
      return { content: homeContent, _meta: meta };
    }

    let content = homeContent;
    if (fan.results.length > 0) {
      const { basename } = await import("node:path");
      const homeLabel = basename(homeRepo) || homeRepo;
      const peers: WorkspacePeerResult[] = fan.results.map((r) => ({
        repoId: r.repoId,
        label: r.label,
        path: r.path,
        result: r.result,
      }));
      content = mergeWorkspaceResults(toolName, homeContent, homeLabel, peers);
    }
    meta.workspace = { peers: fan.results.length, partial: fan.partial };
    meta.latency_ms = performance.now() - t0;
    this.recordCrossRepoAccess(toolName, {
      peers: fan.results.length,
      partial: fan.partial,
      refused: false,
    });
    // Issue 8: a successful cross-repo fan-out served the query from the graph
    // instead of the agent shelling into sibling repos.
    if (fan.results.length > 0) {
      this.emitCrossRepoSavings(
        "cross_repo_routed",
        toolName,
        fan.results.length
      );
    } else {
      // Issue 1: workspace scope requested but no registered sibling answered
      // (daemon knew of zero peers). Yielded to the home repo — record the
      // wall-hit so the rollup shows how often cross-repo had nothing to serve.
      this.emitCrossRepoSavings("cross_repo_yielded_unregistered", toolName, 0);
    }
    return { content, _meta: meta };
  }

  /**
   * Emit one Issue 8 savings_event for a cross-repo outcome (routed / yielded).
   * Best-effort and additive to {@link recordCrossRepoAccess}: this row feeds
   * the consolidated savings-origin rollup; the cross_repo_access row stays the
   * raw federation telemetry. No-op when there is no writer or session id.
   */
  private emitCrossRepoSavings(
    kind:
      | "cross_repo_routed"
      | "cross_repo_yielded_free"
      | "cross_repo_yielded_unregistered",
    toolName: string,
    peers: number
  ): void {
    const sid = this.tokenFlow?.sessionId;
    if (!this.behaviorEvents || !sid) return;
    const note =
      kind === "cross_repo_routed"
        ? `${peers} peer repo(s)`
        : kind === "cross_repo_yielded_unregistered"
          ? "no registered peer"
          : "home-only";
    emitSavingsEvent(this.behaviorEvents, kind, {
      session_id: sid,
      turn: this.sessionContext.getToolCallCount(),
      tool: toolName,
      note,
    });
  }

  /**
   * Cross-repo `get_references` (CROSS_REPO_INTELLIGENCE Sprint 4). Resolves the
   * focus entity's stable moniker from the home moniker index, asks every peer
   * who references THAT moniker (`xref_by_moniker`), and merges the cross-repo
   * importers into the local caller/callee list. Degrades to home-only — never
   * errors — when there is no coordinator, no moniker index, the focus entity
   * has no cross-repo identity, or the tier refuses.
   */
  private async executeWorkspaceReferences(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const t0 = performance.now();
    const coord = this.federationCoordinator;
    const repoArgs = { ...args, scope: "repo" };
    const homeContent = await this.executeRaw("get_references", repoArgs);
    const meta: ToolResult["_meta"] = { source: "local", latency_ms: 0 };

    const finishHome = (): ToolResult => {
      meta.latency_ms = performance.now() - t0;
      return { content: homeContent, _meta: meta };
    };

    if (!coord || !this.monikerIndex) return finishHome();

    // The home entity → its stable cross-repo moniker. No moniker (entity not
    // exported, or no SCIP) → nothing a peer can match on.
    const key = await this.resolveKeyArg(args.key as string);
    const { monikerForEntity } = await import("./federation/moniker-index.js");
    const moniker = monikerForEntity(this.monikerIndex, key);
    if (!moniker) return finishHome();

    const homeRepo = this.projectRoot ?? process.cwd();
    const direction = (args.direction as string) ?? "callers";
    const fan = await coord.fanOut({
      homeRepo,
      toolName: "xref_by_moniker",
      args: { moniker, direction },
    });

    if (fan.refused) {
      meta.workspace_refused = fan.refused.message;
      this.recordCrossRepoAccess("get_references", {
        peers: 0,
        partial: false,
        refused: true,
      });
      // Issue 1 + 8: silent home-only yield; record the wall-hit.
      this.emitCrossRepoSavings("cross_repo_yielded_free", "get_references", 0);
      return finishHome();
    }

    let content = homeContent;
    if (fan.results.length > 0) {
      const { basename } = await import("node:path");
      const homeLabel = basename(homeRepo) || homeRepo;
      const peers: WorkspacePeerResult[] = fan.results.map((r) => ({
        repoId: r.repoId,
        label: r.label,
        path: r.path,
        result: r.result,
      }));
      content = mergeWorkspaceResults(
        "get_references",
        homeContent,
        homeLabel,
        peers
      );
    }
    meta.workspace = { peers: fan.results.length, partial: fan.partial };
    meta.latency_ms = performance.now() - t0;
    this.recordCrossRepoAccess("get_references", {
      peers: fan.results.length,
      partial: fan.partial,
      refused: false,
    });
    if (fan.results.length > 0) {
      this.emitCrossRepoSavings(
        "cross_repo_routed",
        "get_references",
        fan.results.length
      );
    }
    return { content, _meta: meta };
  }

  /**
   * Implicit cross-repo path routing (Sprint 3 §3.3). When a path-bearing tool
   * names an ABSOLUTE path outside the home repo, route the call to the sibling
   * repo that owns it and wrap its raw content as a ToolResult. Returns null
   * (→ caller runs the home path) when no path arg, a relative/home path, or no
   * owning peer. The cheap home-prefix check keeps in-repo reads off the network.
   */
  private async maybeRoutePathCall(
    toolName: string,
    args: Record<string, unknown>,
    t0: number
  ): Promise<ToolResult | null> {
    const coord = this.federationCoordinator;
    if (!coord) return null;
    const filePath =
      (args.file_path as string | undefined) ??
      (args.path as string | undefined);
    if (!filePath) return null;

    const { resolve, isAbsolute, sep } = await import("node:path");
    // Relative paths are home-relative by definition — never foreign.
    if (!isAbsolute(filePath)) return null;

    const homeRepo = this.projectRoot ?? process.cwd();
    const abs = resolve(filePath);
    const home = resolve(homeRepo);
    // Under the home root → local read; no routing.
    if (
      abs === home ||
      abs.startsWith(home.endsWith(sep) ? home : home + sep)
    ) {
      return null;
    }

    const route = await coord.routeByPath({
      homeRepo,
      toolName,
      args,
      filePath,
    });
    if (!route.routed) return null;

    const latency_ms = performance.now() - t0;
    const meta = {
      source: "local" as const,
      latency_ms,
      routed_repo: route.peer.label,
    };

    // CROSS_REPO_INTELLIGENCE Sprint 8.1: a path-routed file read/outline returns
    // a {content, peer_conventions} wrapper. Unwrap the content the agent reads
    // and lift the owning peer's conventions into `_context.signals`, labeled by
    // repo, so the wire boundary renders them as `ur|fct` lines — the home graph
    // has none of the peer's conventions to inject on its own.
    const { isRoutedFileContent, peerConventionSignals } = await import(
      "./federation/cross-repo-conventions.js"
    );
    if (isRoutedFileContent(route.result)) {
      const signals = peerConventionSignals(
        route.result.peer_conventions,
        route.peer.label
      );
      const result: ToolResult = { content: route.result.content, _meta: meta };
      if (signals.length > 0) result._context = { signals };
      return result;
    }
    return { content: route.result, _meta: meta };
  }

  async executeRaw(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    // Mirror the public execute() path: search_code in profile mode
    // (detail / include_body / want) resolves to ONE entity via get_entity.
    // executeLocal dispatches purely on tool name, so the raw recon runner MUST
    // translate here too — otherwise the focus-body fetch hits the plain
    // search_code case (rows, no body) and recon inlines nothing.
    const profile = resolveProfileTool(toolName, args);
    return this.executeLocal(profile.toolName, profile.args);
  }

  /**
   * Core caller/callee list for an entity — the body-stripped, capped rows
   * shared by `get_references` and `get_entity({want:['callers'|'callees']})`.
   * Returns the capped list plus the pre-cap total so the caller can report
   * truncation. Body is stripped: navigation needs signature + location only.
   */
  private async computeReferenceList(
    key: string,
    direction: "callers" | "callees",
    limit: number
  ): Promise<{ results: Array<Record<string, unknown>>; total: number }> {
    const raw =
      direction === "callees"
        ? await this.localGraph.getCalleesOf(key)
        : await this.localGraph.getCallersOf(key);
    const total = raw.length;
    const results = raw.slice(0, limit).map(({ body: _body, ...rest }) => rest);
    return { results, total };
  }

  /**
   * Word-boundary literal sweep of an entity's name, for a rename — the textual
   * occurrences a callers-only graph structurally cannot see (a name in a
   * test-fixture string, a config key, a dynamic-dispatch string). Excludes the
   * definition file and every caller file already in `callerResults`, so the
   * returned matches are exactly the sites the call graph missed. Best-effort:
   * returns null when the entity or its name can't be resolved.
   */
  private async computeTextOccurrences(
    key: string,
    callerResults: Array<Record<string, unknown>>
  ): Promise<{
    matches: Array<{ file: string; line: number; preview: string }>;
    total: number;
    truncated: boolean;
    note: string;
  } | null> {
    const entity = await this.localGraph.getEntity(key);
    if (!entity?.name) return null;
    const exclude = new Set<string>();
    if (entity.file_path) exclude.add(entity.file_path);
    for (const r of callerResults) {
      const fp = r.file_path;
      if (typeof fp === "string" && fp.length > 0) exclude.add(fp);
    }
    const { findTextOccurrences } = await import("./text-occurrences.js");
    const root = this.projectRoot ?? process.cwd();
    const { matches, total, truncated } = findTextOccurrences(
      root,
      entity.name,
      exclude
    );
    if (total === 0) return null;
    return {
      matches,
      total,
      truncated,
      // Imperative, no deictic — the agent can act on this verbatim.
      note: `${total} textual occurrence(s) of "${entity.name}" not in the call graph (strings, configs, comments). Update these alongside the callers for a complete rename.`,
    };
  }

  /**
   * Resolved imports for a file, each paired with the symbols imported from it
   * — shared by `get_imports` and `get_entity({want:['imports']})`. The graph
   * stores file→file edges only; symbol names are read from source on demand
   * and degrade gracefully to path-only rows on failure.
   */
  private async computeFileImports(
    filePath: string
  ): Promise<Array<{ imported_file: string; symbols: string[] }>> {
    const rows = await this.localGraph.getImports(filePath);
    const { loadImportSymbols } = await import("./import-symbols.js");
    const symbolMap = await loadImportSymbols(
      this.projectRoot ?? process.cwd(),
      filePath
    );
    const lookup = new Map<string, string[]>();
    const stripExt = (p: string): string =>
      p
        .split("/")
        .pop()
        ?.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "") ?? "";
    for (const [spec, syms] of symbolMap.entries()) {
      const base = stripExt(spec);
      if (!base) continue;
      const existing = lookup.get(base);
      if (existing) existing.push(...syms);
      else lookup.set(base, syms.slice());
    }
    return rows.map((r) => {
      const base = stripExt(r.imported_file);
      const symbols = lookup.get(base) ?? [];
      return { imported_file: r.imported_file, symbols };
    });
  }

  /**
   * Content search across indexed code files (Issue 2). Serves
   * `search_code({query, mode:'literal'|'regex'})` — the exact-string / regex
   * match that the entity graph cannot express. Each hit carries a BOUNDED
   * context slice (matched line ± `context` lines, default 2, max 6); hard caps
   * keep it from flooding context: at most `limit` matches total (default 30),
   * 20 per file, and ~12 KB of context bytes. Files come from a filesystem
   * walk (`discoverSearchableFiles`, code files only) — NOT a graph query — so
   * the search never blocks on a contended CozoDB write.
   */
  private async searchFileContent(
    args: Record<string, unknown>
  ): Promise<unknown> {
    const clamp = (n: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, n));
    const mode = args.mode === "regex" ? "regex" : "literal";
    const opts = {
      mode: mode as "literal" | "regex",
      query: typeof args.query === "string" ? args.query : "",
      limit: clamp(Number(args.limit) || 30, 1, 100),
      contextLines: clamp(
        Number.isFinite(Number(args.context)) ? Number(args.context) : 2,
        0,
        6
      ),
      maxTotalBytes: 12_000,
      maxPerFile: 20,
    };

    const { readFile, stat } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const cwd = this.projectRoot ?? process.cwd();

    // Compile once, up front — an invalid regex returns a clean error without
    // touching the disk at all.
    const compiled = compilePattern(opts.mode, opts.query);
    if ("error" in compiled) {
      return {
        files_scanned: 0,
        matches: [],
        truncated: false,
        error: compiled.error,
      };
    }

    // Enumerate code files by WALKING THE FILESYSTEM, not by querying the graph.
    // The old `?[fp] := *file_index[fp,_]` cozo read queued behind any in-flight
    // CozoDB write — drift processing / incremental reindex can hold the write
    // lock up to 60s, so a `mode:'literal'` search appeared to hang for that
    // whole window even though the scan itself is ~80ms. The walk reuses the
    // indexer's exclusions + extension set + size cap and never touches the DB.
    let relPaths: string[] = [];
    try {
      const { discoverSearchableFiles } = await import("./local-indexer.js");
      relPaths = await discoverSearchableFiles(cwd);
    } catch {
      relPaths = [];
    }

    // STREAM the scan: read + match one file at a time and STOP at the match /
    // byte cap, instead of materialising every file first. On a big repo (1000+
    // indexed files, some multi-thousand-line) the old "readFileSync all files,
    // then scan" path blocked the MCP event loop for seconds on EVERY
    // literal/regex call — the proxy appeared to hang. Async reads (each `await`
    // yields the loop), a per-file size skip (`MAX_SCAN_FILE_BYTES` — generated
    // / minified blobs the agent never means to grep), and early-exit keep it
    // bounded: a query that matches early reads only a handful of files.
    const acc: ScanAccumulator = {
      matches: [],
      totalBytes: 0,
      truncated: false,
    };
    let filesScanned = 0;
    for (const rel of relPaths) {
      if (
        acc.matches.length >= opts.limit ||
        acc.totalBytes >= opts.maxTotalBytes
      ) {
        acc.truncated = true;
        break;
      }
      const abs = resolve(cwd, rel);
      let content: string;
      try {
        const info = await stat(abs);
        if (!info.isFile() || info.size > MAX_SCAN_FILE_BYTES) continue;
        content = await readFile(abs, "utf-8");
      } catch {
        // Unreadable / moved file — skip; the graph may be mid-reindex.
        continue;
      }
      filesScanned++;
      if (!scanFileInto(compiled.re, rel, content, opts, acc)) break;
    }

    const result = {
      files_scanned: filesScanned,
      matches: acc.matches,
      truncated: acc.truncated,
    };

    // Issue 8 telemetry — best-effort, additive.
    const sid = this.tokenFlow?.sessionId;
    if (this.behaviorEvents && sid) {
      const turn = this.sessionContext.getToolCallCount();
      // Issue 2 adoption: the in-tool literal/regex search ran at all — the
      // agent chose search_code content mode over a bash grep. One row per
      // completed search (the error path returned earlier, so this is a real
      // served search), so the rollup can count grep replacement directly.
      emitSavingsEvent(this.behaviorEvents, "search_code_regex_served", {
        session_id: sid,
        turn,
        tool: "search_code",
        note: `${opts.mode} search, ${acc.matches.length} match(es) in ${filesScanned} file(s)`,
      });
      // Issue 8: when a content match carried its surrounding context, the agent
      // does not need a follow-up read of that file — record one savings_event
      // for the distinct files the matches covered (each would otherwise be a read).
      if (opts.contextLines > 0 && result.matches.length > 0) {
        const distinctFiles = new Set(result.matches.map((m) => m.file_path));
        emitSavingsEvent(this.behaviorEvents, "search_code_context_inlined", {
          session_id: sid,
          turn,
          tool: "search_code",
          roundtrips_saved: distinctFiles.size,
          note: `${opts.mode} match carried ±${opts.contextLines}-line context`,
        });
      }
    }

    return result;
  }

  private async executeLocal(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    // T1.5/T1.6 — reversible-cache retrieve side. When a pagination-capable
    // tool (search_code, get_references, file_read) is handed a `cache_ref`,
    // resolve the withheld slice from the shared in-process cache in O(slice)
    // instead of recomputing the whole payload. A live entry is a hit (return
    // the slice, record the re-request savings); an evicted/unknown hash is a
    // miss (record it, then fall through to the normal recompute path below).
    // Additive: with no `cache_ref` arg this block is skipped entirely.
    const cacheRef = typeof args.cache_ref === "string" ? args.cache_ref : null;
    if (cacheRef && CACHE_REF_TOOLS.has(toolName)) {
      const cwd = this.projectRoot ?? process.cwd();
      const hit = resolveCacheRef(cacheRef, args.offset, args.limit);
      recordCacheRetrieve(cwd, toolName, cacheRef, hit);
      if (hit) {
        return {
          cache_ref: hit.cache_ref,
          offset: hit.offset,
          limit: hit.limit,
          slice: hit.slice,
          cache_hit: true,
          rerequest_saved_tokens: hit.rerequest_saved_tokens,
        };
      }
      // Miss → fall through; the normal handler recomputes (fidelity unchanged).
    }
    switch (toolName) {
      case "get_entity": // internal alias — advertised surface is search_code({detail:true})
      case "get_function": // alias (backward compat)
      case "get_class": {
        const rawArg =
          (args.key as string) ??
          (args.name as string) ??
          (args.query as string);
        // Aliases imply a kind even when the caller didn't pass one
        const aliasKind =
          toolName === "get_function"
            ? "function"
            : toolName === "get_class"
              ? "class"
              : undefined;
        const kindHint = (args.kind as string | undefined) ?? aliasKind;
        const key = await this.resolveKeyArg(rawArg, kindHint);
        const resolved = await this.resolveEntityWithOverlay(key);
        if (resolved === "deleted") {
          // Known entity, deleted locally → content:null (deletion implied),
          // NOT a did-you-mean list (that's for names that never existed).
          return null;
        }
        const entity = resolved;
        if (!entity) {
          // Resolution failed — return an honest not-found WITH suggestions so
          // the agent picks a real name instead of reasoning over a wrong hit.
          // Suggestions are the closest token-matched names (deduped).
          const suggestions = Array.from(
            new Set(
              (await this.localGraph.searchEntities(rawArg, 5)).map(
                (r) => r.name
              )
            )
          );
          return {
            matched: false,
            query: rawArg,
            suggestions,
            _hint:
              suggestions.length > 0
                ? `No entity named "${rawArg}". Closest names: ${suggestions.join(", ")}. Re-call search_code({query:"<one of these>", detail:true}), or search_code({query:"${rawArg}"}) for the ranked list.`
                : `No entity named "${rawArg}". Run search_code({query:"${rawArg}"}) to locate it.`,
          };
        }
        // Resolve actual body from source file — CozoDB stores body_hash, not
        // body text. readEntityBodyLines is the shared reader (also used by the
        // cold-path recon runner) so warm and cold inline byte-identical source.
        const bodyLines = readEntityBodyLines(
          entity?.file_path,
          entity?.start_line,
          entity?.end_line,
          this.projectRoot ?? process.cwd()
        );
        if (bodyLines) {
          const CHARS_PER_TOKEN = 4;
          const tokenBudget =
            typeof args.token_budget === "number" && args.token_budget >= 100
              ? args.token_budget
              : 400;
          // Body inclusion is opt-in. Heuristic: explicit include_body, or
          // budget >= 1500 (caller clearly asked for full body), or aliases
          // that historically returned full bodies. Default => preview only.
          const includeBody =
            args.include_body === true ||
            tokenBudget >= 1500 ||
            toolName === "get_function" ||
            toolName === "get_class";
          const fullBody = bodyLines.join("\n");
          // Budget the wire cap (enforceByteCap) will require to deliver the
          // full body uncapped. The cap serializes the ENTIRE response (body +
          // JSON envelope + newline/quote escaping) and rounds the token
          // estimate up to the next 100. Mirror that here over the projected
          // full-body entity so the suggested token_budget actually clears the
          // cap on retry. Estimating only the raw body (the prior
          // `estimateTokens(fullBody)+100`) undershot — JSON escaping plus the
          // entity envelope inflate the on-wire bytes, so the agent bounced off
          // a second gate (e.g. suggested 2876 when the cap needed 3400).
          const suggestedBudget =
            Math.ceil(estimateTokens({ ...entity, body: fullBody }) / 100) *
            100;

          if (!includeBody) {
            // Structural preview: first ~15 lines as a signature/intro snippet
            const PREVIEW_LINES = 15;
            const previewLines = bodyLines.slice(0, PREVIEW_LINES);
            (entity as unknown as Record<string, unknown>).body_preview =
              previewLines.join("\n");
            if (bodyLines.length > PREVIEW_LINES) {
              (entity as unknown as Record<string, unknown>)._preview = {
                shown_lines: PREVIEW_LINES,
                total_lines: bodyLines.length,
                _hint: `Structural preview only — showing first ${PREVIEW_LINES} of ${bodyLines.length} lines. Pass include_body:true (or token_budget:${suggestedBudget}) to get the full body.`,
              };
            }
          } else if (fullBody.length > tokenBudget * CHARS_PER_TOKEN) {
            const maxChars = tokenBudget * CHARS_PER_TOKEN;
            const truncatedLines: string[] = [];
            let charCount = 0;
            for (const line of bodyLines) {
              if (charCount + line.length + 1 > maxChars) break;
              truncatedLines.push(line);
              charCount += line.length + 1;
            }
            entity.body = truncatedLines.join("\n");
            (entity as unknown as Record<string, unknown>)._truncated = {
              shown_lines: truncatedLines.length,
              total_lines: bodyLines.length,
              omitted_lines: `${entity.start_line + truncatedLines.length}-${entity.start_line + bodyLines.length - 1}`,
              _hint: `Body truncated: showing ${truncatedLines.length} of ${bodyLines.length} lines (~${tokenBudget} tokens). To see the full entity, pass token_budget: ${suggestedBudget}. Or use file_read with offset: ${entity.start_line + truncatedLines.length}, limit: ${bodyLines.length - truncatedLines.length} to read the remaining lines.`,
            };
          } else {
            entity.body = fullBody;
          }
        }
        // T9.2: get_entity absorbs get_references + get_imports via `want`.
        // When the caller asks for extras, attach them so ONE call covers
        // signature + callers/callees/imports (the merge target for the retired
        // get_references / get_imports). Each extra reuses the exact shared path
        // the standalone tools use, so the output is identical field-for-field.
        const want = Array.isArray(args.want)
          ? (args.want as unknown[]).filter(
              (w): w is string => typeof w === "string"
            )
          : [];
        if (want.length > 0) {
          const wantLimit =
            typeof args.limit === "number" && args.limit > 0 ? args.limit : 25;
          const e = entity as unknown as Record<string, unknown>;
          if (want.includes("callers")) {
            const { results, total } = await this.computeReferenceList(
              key,
              "callers",
              wantLimit
            );
            e.callers = results;
            e.callers_total = total;
          }
          if (want.includes("callees")) {
            const { results, total } = await this.computeReferenceList(
              key,
              "callees",
              wantLimit
            );
            e.callees = results;
            e.callees_total = total;
          }
          if (want.includes("imports") && entity.file_path) {
            e.imports = await this.computeFileImports(entity.file_path);
          }
        }
        return entity;
      }
      case "get_references": {
        // consolidated: replaces get_callers + get_callees
        const key = await this.resolveKeyArg(args.key as string);
        const direction = (args.direction as string) ?? "callers";
        const limit =
          typeof args.limit === "number" && args.limit > 0 ? args.limit : 25;
        // Body-stripped caller/callee list via the shared path also used by
        // get_entity({want:[...]}) — keeps the two merge surfaces identical.
        const { results, total: totalCount } = await this.computeReferenceList(
          key,
          direction === "callees" ? "callees" : "callers",
          limit
        );
        // Rename safety (P3): a callers-only graph cannot see a symbol baked into
        // a test-fixture string, a config key, or a dynamic-dispatch lookup — yet
        // a rename must update those too. When the agent signals rename intent
        // (`include_text_occurrences`, callers direction only), pair the semantic
        // callers with a word-boundary, case-sensitive literal sweep, excluding
        // every file the call graph already covers so the two lists don't overlap.
        const textOccurrences =
          args.include_text_occurrences === true && direction !== "callees"
            ? await this.computeTextOccurrences(key, results)
            : null;
        return {
          references: results,
          direction,
          total: totalCount,
          // `returned` dropped from the wire — it equals references.length,
          // which the agent can count directly. `total` + `truncated` carry
          // the only non-derivable facts (how many exist, were any cut).
          truncated: totalCount > limit,
          ...(totalCount > limit
            ? {
                _hint: `Showing ${limit} of ${totalCount}. Pass limit: ${totalCount} to see all.`,
              }
            : {}),
          // Flat array + scalar siblings (NOT a nested object): the columnar
          // wire encoder keeps a recognized array plus scalar fields, but drops
          // a sibling object. With `references` and `text_occurrences` both
          // top-level arrays, the encoder uses its two-array `_fmt:multi` path
          // and both survive; the count/note ride as scalars.
          ...(textOccurrences
            ? {
                text_occurrences: textOccurrences.matches,
                text_occurrences_total: textOccurrences.total,
                text_occurrences_truncated: textOccurrences.truncated,
                text_occurrences_note: textOccurrences.note,
              }
            : {}),
        };
      }
      case "xref_by_moniker": {
        // CROSS_REPO_INTELLIGENCE Sprint 4 (peer side, internal — not
        // advertised). Answers the home repo's "who references this exported
        // symbol?" by returning THIS repo's references to the given normalized
        // moniker, shaped like get_references so the home can merge them. Empty
        // when this repo has no moniker index or no references to it.
        const moniker = args.moniker as string | undefined;
        const direction = (args.direction as string) ?? "callers";
        const refs =
          (moniker && this.monikerIndex?.refs[moniker]) || ([] as const);
        const references = refs.map((r) => ({
          name: r.name,
          file_path: r.file,
          line: r.line,
        }));
        return {
          references,
          direction,
          total: references.length,
          truncated: false,
        };
      }
      case "moniker_def": {
        // CROSS_REPO_INTELLIGENCE Sprint 6.3 (peer side, internal — not
        // advertised). Answers "which of these normalized monikers does THIS
        // repo still define?" so the home repo can detect a dangling cross-repo
        // reference (a symbol it imports that moved, was renamed, or was deleted
        // — all of which change or drop the moniker's definition here). Batched:
        // the home sends every external moniker it references in ONE call so the
        // drift pass is a single fan-out, not one per symbol. Returns the subset
        // this repo defines + this repo's package.
        const requested = Array.isArray(args.monikers)
          ? (args.monikers as unknown[]).filter(
              (m): m is string => typeof m === "string"
            )
          : typeof args.moniker === "string"
            ? [args.moniker]
            : [];
        const defs = this.monikerIndex?.defs ?? {};
        const defined = requested.filter((m) => defs[m] !== undefined);
        return {
          package: this.monikerIndex?.package ?? null,
          defined,
        };
      }
      case "get_callers": {
        // alias (backward compat)
        const key = await this.resolveKeyArg(args.key as string);
        const rawCallers = await this.localGraph.getCallersOf(key);
        return rawCallers.slice(0, 25).map(({ body: _body, ...rest }) => rest);
      }
      case "get_callees": {
        // alias (backward compat)
        const key = await this.resolveKeyArg(args.key as string);
        const rawCallees = await this.localGraph.getCalleesOf(key);
        return rawCallees.slice(0, 25).map(({ body: _body, ...rest }) => rest);
      }
      case "get_imports": {
        const filePath = args.file_path as string;
        // Resolved imports + per-path symbols via the shared path also used by
        // get_entity({want:['imports']}).
        return await this.computeFileImports(filePath);
      }
      case "search_code": {
        // Content-search mode (Issue 2) — `mode:'literal'|'regex'` serves the one
        // legit reason to grep code (an exact string / real regex across files)
        // in-tool, so there is no correct reason left to shell out. Returns each
        // match with a BOUNDED context slice (the matched line ± a few lines,
        // capped per-match and by total bytes) to kill the follow-up file read
        // without dumping whole files into context.
        if (args.mode === "literal" || args.mode === "regex") {
          return await this.searchFileContent(args);
        }
        const query = args.query as string;
        const limit = (args.limit as number) ?? 20;
        const rows = await this.localGraph.searchEntities(query, limit);
        // Layer 8 §5.4: serve the domain annotation alongside each hit when one
        // exists; un-annotated hits (and an absent graph db) pass through
        // unchanged — attachAnnotations is best-effort.
        return await attachAnnotations(this.localGraph.db, rows);
      }
      case "domain_tags": {
        // Layer 8 §5.4 "reuse before invent": the active domain-tag vocabulary
        // ranked by entity count, served in the recon bundle so a new
        // `@sem domain=` reuses an existing tag. Best-effort — [] on any error.
        const tags = await fetchActiveDomainTags(this.localGraph.db);
        return { tags };
      }
      case "vocab_nudges": {
        // Layer 8 §5.2 / §6.4: the canonical/provisional split at the promotion
        // threshold plus near-duplicate merge hints, served in the recon bundle
        // so an agent standardises a `@sem domain=` instead of minting sprawl.
        // Best-effort — empty sets on any error.
        return await fetchVocabularyNudges(this.localGraph.db);
      }
      case "get_conventions": {
        const raw = await this.localGraph.getConventions();
        // Hoist each kind to a top-level array so the format-encoder can emit
        // `_fmt:multi` (per the documented response contract). A nested
        // `conventions: { naming: [...], ... }` shape forces JSON fallback
        // because the encoder only inspects arrays at the top level.
        const naming: typeof raw = [];
        const import_direction: typeof raw = [];
        const structure: typeof raw = [];
        const other: typeof raw = [];
        for (const c of raw) {
          if (c.kind === "naming") naming.push(c);
          else if (c.kind === "import_direction") import_direction.push(c);
          else if (c.kind === "structure") structure.push(c);
          else other.push(c);
        }
        // Each convention object already carries name + kind +
        // adherence_rate + confidence + description — enough to act on. The
        // old `guidance` (prose pre-chewed from those same fields) and
        // `summary` (a count restatement) were synthetic duplications the
        // agent didn't need; dropped from the wire.
        return {
          naming,
          import_direction,
          structure,
          ...(other.length > 0 ? { other } : {}),
        };
      }
      case "file_outline": {
        const { buildFileOutline } = await import(
          "../tools/coding/file-outline.js"
        );
        const { appendFileReadLog } = await import(
          "../proxy/shell-compression-log.js"
        );
        const fp = args.file_path as string;
        if (!fp) throw new Error("file_outline requires file_path");
        const cwd = this.projectRoot ?? process.cwd();
        const outline = await buildFileOutline({
          cwd,
          filePathArg: fp,
          graph: this.localGraph,
        });
        const savedPct =
          outline.total_lines > 0
            ? Math.round(
                ((outline.total_lines - outline.entities.length) /
                  outline.total_lines) *
                  100
              )
            : 0;
        appendFileReadLog(cwd, {
          ts: new Date().toISOString(),
          file: outline.file_path,
          mode: "outline",
          totalLines: outline.total_lines,
          returnedLines: outline.entities.length,
          savedPct,
          tokenEstimate: outline.token_estimate,
        });
        return outline;
      }
      case "file_read": {
        const { runFileReadForRouter } = await import(
          "../tools/coding/file-read-protocol.js"
        );
        return runFileReadForRouter(args, {
          cwd: this.projectRoot ?? process.cwd(),
          graph: this.localGraph,
        });
      }
      case "fetch_url": {
        // One entry point handles BOTH modes: single `url` and bulk `urls:[...]`.
        // runFetchUrlRequest validates the XOR shape and routes to runFetchUrl
        // or runFetchUrlBatch — the only place that decision lives.
        const { runFetchUrlRequest } = await import(
          "../tools/web/fetch-url-protocol.js"
        );
        return runFetchUrlRequest(
          args as unknown as Parameters<typeof runFetchUrlRequest>[0],
          {
            cwd: this.projectRoot ?? process.cwd(),
          }
        );
      }
      default:
        throw new Error(`Unknown local tool: ${toolName}`);
    }
  }

  /**
   * Get entity keys for a file path (from file_index).
   * Used by fact injection to call recallForFile with entity-scoped facts.
   */
  async getEntityKeysForFile(filePath: string): Promise<string[]> {
    try {
      const results = await this.localGraph.getEntitiesByFile(filePath);
      return results.map((e) => e.key);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a key argument: if it looks like a hex hash (entity key), use as-is.
   * Otherwise, search by name and return the best match's key.
   * Falls back to the raw string if no search results (let the graph return its own error).
   */
  private async resolveKeyArg(raw: string, kind?: string): Promise<string> {
    if (!raw) return raw;
    // 16-char hex = already a valid entity key
    if (/^[0-9a-f]{16}$/.test(raw)) return raw;
    // Prefer exact-name match over fuzzy search — fuzzy search ranks by IDF
    // and can score a method ("Class.method") higher than its bare class name
    // when both match the query tokens. An exact name match should always win.
    try {
      const db = (
        this.localGraph as unknown as { db: import("./cozo-schema.js").CozoDb }
      ).db;
      // Rank exact-name matches with two-tier priority:
      //   1. is_test=false (production) before is_test=true (test)
      //   2. Within same test-tier: class > function > method > type > interface > variable
      // This ensures `compressShellOutput` resolves to the production function,
      // not a test `describe(...)` block that happens to share the name.
      //
      // Resolve name→key via the `entities:by_name` index relation EXPLICITLY,
      // then read the base relation BY KEY. Do NOT bind `name` as a constant on
      // the base relation (`*entities{name: $n, kind, ...}`): CozoDB's planner
      // then picks an index→base join that silently returns [] for any column
      // not covered by the index (kind, is_test, file_path, …). That defect is
      // deterministic — recreating the index reproduces it — and made
      // get_entity("QueryRouter") fall through to fuzzy and resolve to a method.
      // The index relation supplies (name, key); the base lookup is keyed on the
      // primary key, which is unaffected. ~0.4ms vs ~46ms for a full base scan.
      const exact = await db.run(
        `?[k, kind, rank] := *entities:by_name{name: $n, key: k},
          *entities{key: k, kind, is_test: it},
          test_penalty = if(it, 100, 0),
          kind_rank = if(kind == "class", 0, if(kind == "function", 1, if(kind == "method", 2, if(kind == "type", 3, if(kind == "interface", 4, if(kind == "variable", 5, 6)))))),
          rank = test_penalty + kind_rank
         :order rank
         :limit 8`,
        { n: raw }
      );
      const exactRows = (exact.rows ?? []) as Array<[string, string, number]>;
      if (exactRows.length > 0) {
        // If a kind filter is provided, prefer that kind among exact matches
        if (kind) {
          const matchKind = exactRows.find((r) => r[1] === kind);
          if (matchKind) return matchKind[0];
        }
        return exactRows[0]![0];
      }
    } catch {
      // fall through to fuzzy search
    }
    // Fuzzy fallback. We accept a fuzzy hit ONLY when it is confident: either an
    // exact name match, or a candidate whose tokenized name contains EVERY token
    // of the query (e.g. "compressShell" → "compressShellOutput"). A weak partial
    // overlap (e.g. "QueryRouter" → "setHashQueryParams", which shares only the
    // "query" token) must NOT resolve — we return `raw` to signal not-found, and
    // the caller emits a helpful "did you mean" list. Returning a wrong entity
    // costs the agent far more tokens (it reasons over the wrong code) than an
    // honest miss does.
    try {
      const results = await this.localGraph.searchEntities(raw, 15);
      if (results.length === 0) return raw;

      const isTest = (r: { file_path?: string }): boolean =>
        r.file_path?.includes("__tests__") ?? false;

      // Exact name match always wins (production before test).
      const exactNonTest = results.filter((r) => r.name === raw && !isTest(r));
      const exactTest = results.filter((r) => r.name === raw && isTest(r));
      if (exactNonTest.length > 0 || exactTest.length > 0) {
        const exact = [...exactNonTest, ...exactTest];
        if (kind) {
          const matchKind = exact.find((r) => r.kind === kind);
          if (matchKind) return matchKind.key;
        }
        return exact[0]!.key;
      }

      // No exact name — accept only candidates whose name covers ALL query
      // tokens. This keeps useful prefix/superset matches while rejecting the
      // weak single-token overlaps that produced the wrong-entity bug.
      const queryTokens = tokenize(raw);
      const coversAllQueryTokens = (name: string): boolean => {
        if (queryTokens.length === 0) return false;
        const nameTokens = new Set(tokenize(name));
        return queryTokens.every((t) => nameTokens.has(t));
      };
      const qualifiedNonTest = results.filter(
        (r) => !isTest(r) && coversAllQueryTokens(r.name)
      );
      const qualifiedTest = results.filter(
        (r) => isTest(r) && coversAllQueryTokens(r.name)
      );
      const qualified = [...qualifiedNonTest, ...qualifiedTest];
      if (qualified.length === 0) return raw; // honest not-found

      if (kind) {
        const matchKind = qualified.find((r) => r.kind === kind);
        if (matchKind) return matchKind.key;
      }
      return qualified[0]!.key;
    } catch {
      return raw;
    }
  }

  /**
   * Run a read query against the Cozo db backing the live graph.
   *
   * Returns null when the graph exposes no `db` — a test mock or any non-Cozo
   * store — so the drift_overlay lookups degrade to "no overlay" silently
   * instead of throwing `Cannot read properties of undefined (reading 'run')`
   * and logging a warning on every entity query. A genuine query failure (bad
   * Datalog, db error) still rejects so the caller's catch can surface it.
   */
  private async runDriftQuery(
    query: string,
    params: Record<string, unknown>
  ): Promise<{ rows: unknown[][] } | null> {
    const db = (this.localGraph as { db?: import("./cozo-schema.js").CozoDb })
      .db;
    if (!db) return null;
    return db.run(query, params);
  }

  /**
   * Resolve entity with drift overlay merge.
   * If entity exists in drift_overlay, overlay data replaces/augments base entity.
   */
  private async resolveEntityWithOverlay(
    key: string
  ): Promise<
    LocalEntity | (LocalEntity & { _drift: DriftEntity }) | "deleted" | null
  > {
    // Check drift overlay first
    const _driftEntities = await this.localGraph.getDriftEntitiesForFile("");
    // Need to check by key across all files - query drift_overlay directly
    let driftEntity: DriftEntity | null = null;
    try {
      const result = await this.runDriftQuery(
        `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
          *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps],
          key = $key`,
        { key }
      );
      if (result && result.rows.length > 0) {
        const [
          k,
          name,
          kind,
          signature,
          body,
          file_path,
          line_start,
          line_end,
          content_hash,
          drift_status,
          intent_id,
          modified_at,
          origin,
          previous_body,
          previous_signature,
        ] = result.rows[0] as [
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          number,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        driftEntity = {
          key: k,
          name,
          kind,
          signature,
          body,
          file_path,
          line_start,
          line_end,
          content_hash,
          drift_status: drift_status as DriftEntity["drift_status"],
          intent_id,
          modified_at,
          origin: origin as DriftEntity["origin"],
          previous_body,
          previous_signature,
        };
      }
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr] ⚠ Drift overlay query failed: ${formatUnknownError(err)}\n`
      );
    }

    // Get base entity
    const baseEntity = await this.localGraph.getEntity(key);

    if (driftEntity) {
      if (driftEntity.drift_status === "deleted") {
        // A "deleted" overlay normally means the entity was removed from the
        // working tree → return content:null (deletion implied), NOT a
        // did-you-mean list (that is for names that never existed).
        //
        // But a STALE "deleted" row can outlive the entity it shadowed: a
        // transient empty/partial read or a parse miss marks the entity deleted
        // while it is in fact still present in the file. That row persists in
        // graph.db across a plain resume (which does not re-scan unchanged
        // files) and masks a LIVE entity. The base graph alone cannot tell the
        // two apart — the last-index baseEntity is present in BOTH the stale and
        // the genuine-pending-deletion case — so the working-tree file is the
        // only authority. When a base entity exists, re-extract its file with
        // the canonical extractor: if the entity is still defined there, the
        // overlay is stale → self-heal it and serve the live entity; otherwise
        // honor the deletion. (No file / extraction failure → honor deletion,
        // which is also the unit-test path: no real file on disk.)
        if (baseEntity?.file_path) {
          try {
            const { readFileSync } = await import("node:fs");
            const { resolve } = await import("node:path");
            const { extractEntitiesAsync } = await import("./ast-extractor.js");
            const cwd = this.projectRoot ?? process.cwd();
            const content = readFileSync(
              resolve(cwd, baseEntity.file_path),
              "utf-8"
            );
            const stillDefined = (
              await extractEntitiesAsync(content, baseEntity.file_path)
            ).some(
              (e) => e.name === baseEntity.name && e.kind === baseEntity.kind
            );
            if (stillDefined) {
              await this.localGraph.removeDriftEntity(driftEntity.key);
              return baseEntity;
            }
          } catch {
            // Unreadable file / extraction failure → fall through and honor the
            // recorded deletion.
          }
        }
        return "deleted";
      }

      if (driftEntity.drift_status === "added") {
        // Entity only exists locally — construct from overlay
        return {
          key: driftEntity.key,
          kind: driftEntity.kind,
          name: driftEntity.name,
          file_path: driftEntity.file_path,
          start_line: driftEntity.line_start,
          signature: driftEntity.signature,
          body: driftEntity.body,
          fan_in: 0,
          fan_out: 0,
          risk_level: "normal",
          _drift: driftEntity,
        } as LocalEntity & { _drift: DriftEntity };
      }

      if (driftEntity.drift_status === "modified" && baseEntity) {
        // Overlay body replaces base body
        return {
          ...baseEntity,
          body: driftEntity.body || baseEntity.body,
          signature: driftEntity.signature || baseEntity.signature,
          start_line: driftEntity.line_start || baseEntity.start_line,
          _drift: driftEntity,
        } as LocalEntity & { _drift: DriftEntity };
      }
    }

    return baseEntity;
  }

  /**
   * Extract drift metadata for injection into _meta.
   */
  private async extractDriftMeta(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown
  ): Promise<DriftMeta | null> {
    // Only inject drift for entity-returning tools
    if (!ENTITY_TOOLS.has(toolName)) return null;

    const branch = this.branchContext?.currentBranch ?? "unknown";
    const commitsAhead = this.branchContext?.commitsAhead ?? 0;

    // Check if result has drift info attached
    if (result && typeof result === "object" && "_drift" in result) {
      const drift = (result as { _drift: DriftEntity })._drift;
      return {
        entityStatus: drift.drift_status,
        branch,
        commitsAhead,
        lastModifiedBy: drift.intent_id || null,
      };
    }

    // Check if any entity in the result file has drift
    const key = args.key as string | undefined;
    if (key) {
      try {
        const driftResult = await this.runDriftQuery(
          "?[ds, iid] := *drift_overlay[$key, _, _, _, _, _, _, _, _, ds, iid, _, _, _, _]",
          { key }
        );
        if (driftResult && driftResult.rows.length > 0) {
          const [ds, iid] = driftResult.rows[0] as [string, string];
          return {
            entityStatus: ds,
            branch,
            commitsAhead,
            lastModifiedBy: iid || null,
            deletedLocally: ds === "deleted",
          };
        }
      } catch (err: unknown) {
        process.stderr.write(
          `[unerr] ⚠ Drift data query failed: ${formatUnknownError(err)}\n`
        );
      }
    }

    // No drift — only inject branch context if there is drift in the repo at all
    const summary = await this.localGraph.getDriftSummary();
    if (summary.total > 0) {
      return {
        entityStatus: null,
        branch,
        commitsAhead,
        lastModifiedBy: null,
      };
    }

    return null;
  }

  /**
   * Layer 8 §5.1 (SC-C.2): detect a stale @sem/doc annotation on the focus
   * entity (body moved, comment did not — status flipped by the C.1 predicate).
   * Returns the name + file:line buildSignalPrefix needs for the
   * once-per-episode comment-drift nudge, or null when no stale annotation
   * exists. Best-effort: a DB error or absent annotation never disturbs the
   * response.
   */
  private async extractCommentDriftMeta(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    entityKey: string;
    name: string;
    file: string;
    line: number;
  } | null> {
    if (!ENTITY_TOOLS.has(toolName)) return null;
    const key = args.key as string | undefined;
    if (!key) return null;
    try {
      const db = (
        this.localGraph as unknown as {
          db: import("./cozo-schema.js").CozoDb;
        }
      ).db;
      // entity_key is the domain_annotations primary key (direct lookup, not a
      // secondary index), joined to entities for the name + line. status is a
      // value-column constant filter.
      const res = await db.run(
        `?[name, file_path, start_line] :=
           *domain_annotations{entity_key: $key, status: "stale"},
           *entities{key: $key, name, file_path, start_line}`,
        { key }
      );
      if (res.rows.length === 0) return null;
      const [name, filePath, startLine] = res.rows[0] as [
        string,
        string,
        number,
      ];
      return {
        entityKey: key,
        name,
        file: filePath,
        line: typeof startLine === "number" ? startLine : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Layer 8 §6 (SC-D.3): the voted domain + purity for a Louvain community,
   * or null when the community has no `community_domains` row (untagged) or the
   * lookup fails. Used to name communities by their domain in the `_meta`
   * envelope + dashboard.
   */
  private async lookupCommunityDomain(
    communityId: number
  ): Promise<{ domain: string; purity: number } | null> {
    try {
      const db = (
        this.localGraph as unknown as {
          db: import("./cozo-schema.js").CozoDb;
        }
      ).db;
      const res = await db.run(
        `?[domain, purity] :=
           *community_domains{community_id: $cid, domain, purity},
           domain != ""`,
        { cid: communityId }
      );
      if (res.rows.length === 0) return null;
      const [domain, purity] = res.rows[0] as [string, number];
      return { domain, purity: typeof purity === "number" ? purity : 0 };
    } catch {
      return null;
    }
  }

  /**
   * Layer 8 §6 (SC-D.3): boundary-erosion signal. The focus entity's Louvain
   * community carries a `community_domains` vote whose purity is below
   * BOUNDARY_PURITY_THRESHOLD — the community mixes domains, so an edit here
   * risks pulling code across a contested domain boundary. Returns the
   * dominant domain + purity for the `ur|rsk` line, or null when the entity
   * is in a pure (or unlabeled) community.
   */
  private async extractBoundaryErosionMeta(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    entityKey: string;
    domain: string;
    purity: number;
    communityId: number;
  } | null> {
    if (!ENTITY_TOOLS.has(toolName)) return null;
    const key = args.key as string | undefined;
    if (!key) return null;
    try {
      const db = (
        this.localGraph as unknown as {
          db: import("./cozo-schema.js").CozoDb;
        }
      ).db;
      // Resolve the entity's community (primary-key lookup), then join the
      // community_domains vote. domain is filtered non-empty so unlabeled
      // communities never trip the signal.
      const res = await db.run(
        `?[domain, purity, community] :=
           *entities{key: $key, community},
           *community_domains{community_id: community, domain, purity},
           domain != ""`,
        { key }
      );
      if (res.rows.length === 0) return null;
      const [domain, purity, community] = res.rows[0] as [
        string,
        number,
        number,
      ];
      if (typeof purity !== "number" || purity >= BOUNDARY_PURITY_THRESHOLD) {
        return null;
      }
      return {
        entityKey: key,
        domain,
        purity,
        communityId: typeof community === "number" ? community : -1,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Layer 8 §6 (SC-D.3): a community whose domain vote falls below this purity
 * is "contested" — editing an entity inside it earns a boundary-erosion
 * `ur|rsk` line. 0.7 means the dominant domain holds under 70% of the
 * confidence-weighted vote.
 */
const BOUNDARY_PURITY_THRESHOLD = 0.7;

/** Entity-returning tool names where risk injection is relevant. */
const ENTITY_TOOLS = new Set([
  "get_entity",
  "get_function",
  "get_class",
  "get_callers",
  "get_callees",
  "get_references",
]);

/**
 * Fields that are noise for coding agents — removed before wire encoding.
 * `body` is always empty in caller/callee/search results (never populated).
 * `community` is an internal graph clustering ID with no meaning to agents.
 */
/** Fields stripped from ALL entity results (arrays and single). */
const ENTITY_NOISE_FIELDS_ALL = new Set(["community"]);
/** Fields stripped only from array results (body is empty in list rows but useful in single-entity).
 * `score` is stripped from list rows — results are already relevance-sorted so the raw numeric
 * value adds nothing actionable on the wire. */
const ENTITY_NOISE_FIELDS_ARRAY = new Set(["body", "community", "score"]);

/** Tools that return entity arrays (or arrays wrapped in a metadata object)
 * where noise fields and sentinel placeholders should be stripped before
 * format encoding. */
const ENTITY_ARRAY_TOOLS = new Set([
  "get_callers",
  "get_callees",
  "get_references",
  "search_code",
  "file_outline",
]);

/** Tools that return single entity objects where noise fields should be stripped. */
const SINGLE_ENTITY_TOOLS = new Set([
  "get_entity",
  "get_function",
  "get_class",
]);

/**
 * Strip fields that are meaningless to coding agents (body, community).
 * Also normalizes legacy "normal" risk_level → "low" and drops sentinel
 * placeholders (end_line:0, community:-1) so consumers don't have to special-case
 * them. Rounds excessive float precision in conventions.
 */
function stripEntityRow(
  row: Record<string, unknown>,
  noiseSet: Set<string>
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (noiseSet.has(k)) continue;
    // Drop sentinel placeholders rather than emit them on the wire.
    if (k === "end_line" && v === 0) continue;
    if (k === "community" && v === -1) continue;
    if (k === "risk_level" && typeof v === "string") {
      // Normalize legacy "normal" → "low" so downstream consumers see one enum.
      cleaned[k] = v === "normal" ? "low" : v;
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

function stripNoiseFields(toolName: string, content: unknown): unknown {
  // Entity arrays (top-level): strip body + community + sentinels.
  if (ENTITY_ARRAY_TOOLS.has(toolName) && Array.isArray(content)) {
    return content.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? stripEntityRow(
            item as Record<string, unknown>,
            ENTITY_NOISE_FIELDS_ARRAY
          )
        : item
    );
  }

  // Wrapped array shape: {references|connections|entities: [...], ...}
  // get_references / file_connections / file_outline return this shape, so
  // their inner rows also need sentinel stripping + risk normalization.
  if (
    ENTITY_ARRAY_TOOLS.has(toolName) &&
    content &&
    typeof content === "object" &&
    !Array.isArray(content)
  ) {
    const obj = content as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };
    for (const k of ["references", "connections", "entities"]) {
      const v = obj[k];
      if (Array.isArray(v)) {
        result[k] = v.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? stripEntityRow(
                item as Record<string, unknown>,
                ENTITY_NOISE_FIELDS_ARRAY
              )
            : item
        );
      }
    }
    return result;
  }

  // Single entity: strip only community + sentinels (body contains actual code).
  if (
    SINGLE_ENTITY_TOOLS.has(toolName) &&
    content &&
    typeof content === "object" &&
    !Array.isArray(content)
  ) {
    return stripEntityRow(
      content as Record<string, unknown>,
      ENTITY_NOISE_FIELDS_ALL
    );
  }

  // Conventions: round excessive float precision
  if (toolName === "get_conventions" && Array.isArray(content)) {
    return content.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "number" && !Number.isInteger(v)) {
            cleaned[k] = Math.round(v * 1000) / 1000;
          } else {
            cleaned[k] = v;
          }
        }
        return cleaned;
      }
      return item;
    });
  }

  return content;
}

/**
 * Scan an array of entity-shaped records for the highest-risk member.
 * Returns the max-risk entity's risk metadata along with its `entity_key`
 * (for fine-grained `ur|rsk` dedup), or undefined if nothing exceeds normal.
 */
function extractMaxRiskFromArray(items: unknown[]): EntityRiskMeta | undefined {
  let highestRisk: EntityRiskMeta | undefined;
  for (const item of items) {
    if (!item || typeof item !== "object" || !("risk_level" in item)) continue;
    const entity = item as {
      key?: string;
      fan_in?: number;
      fan_out?: number;
      risk_level?: string;
    };
    if (entity.risk_level === "high") {
      return {
        fan_in: entity.fan_in ?? 0,
        fan_out: entity.fan_out ?? 0,
        risk_level: "high",
        ...(entity.key ? { entity_key: entity.key } : {}),
      };
    }
    if (entity.risk_level === "medium" && !highestRisk) {
      highestRisk = {
        fan_in: entity.fan_in ?? 0,
        fan_out: entity.fan_out ?? 0,
        risk_level: "medium",
        ...(entity.key ? { entity_key: entity.key } : {}),
      };
    }
  }
  return highestRisk;
}

/**
 * Extract entity risk metadata from a local tool result.
 * Returns risk info for single entities, or the highest-risk entity for arrays.
 */
function extractEntityRisk(
  toolName: string,
  result: unknown
): EntityRiskMeta | undefined {
  if (!ENTITY_TOOLS.has(toolName)) return undefined;

  // Single entity (get_function, get_class, get_file)
  if (result && typeof result === "object" && "fan_in" in result) {
    const entity = result as {
      fan_in?: number;
      fan_out?: number;
      risk_level?: string;
    };
    if (entity.risk_level && entity.risk_level !== "normal") {
      return {
        fan_in: entity.fan_in ?? 0,
        fan_out: entity.fan_out ?? 0,
        risk_level: entity.risk_level,
      };
    }
  }

  // Envelope shape: get_references returns { references: [...], direction, ... }
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "references" in result &&
    Array.isArray((result as { references: unknown[] }).references)
  ) {
    return extractMaxRiskFromArray(
      (result as { references: unknown[] }).references
    );
  }

  // Entity array (get_callers, get_callees) — surface the highest-risk entity
  if (Array.isArray(result) && result.length > 0) {
    return extractMaxRiskFromArray(result);
  }

  return undefined;
}
