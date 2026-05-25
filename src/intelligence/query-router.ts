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
import type {
  CompressionQualityMonitor,
  ContentType,
} from "../proxy/compression-quality-monitor.js";
import type { ContextRotDetector } from "../proxy/context-rot-detector.js";
import type { EfficiencyTracker } from "../proxy/efficiency-tracker.js";
import { formatToolOutput } from "../proxy/format-encoder.js";
import { calculateDollarSavings } from "../proxy/model-pricing.js";
import {
  type EntityRiskInfo,
  compressOutput,
} from "../proxy/output-compressor.js";
import type { RouterGateway } from "../proxy/router-gateway.js";
import type { SessionDedup } from "../proxy/session-dedup.js";
import { createSessionLegendTracker } from "../proxy/session-legend.js";
import type { SessionEvents } from "../proxy/session-stats.js";
import type { TokenCounter } from "../proxy/token-counter.js";
import type { BehaviorEventWriter } from "../tracking/behavior-events.js";
import type { BranchContext } from "../tracking/branch-context.js";
import type { DriftTracker } from "../tracking/drift-tracker.js";
import { revertEntity } from "../tracking/entity-rewind.js";
import type { PendingViolationStore } from "../tracking/pending-violations.js";
import type { PersistenceEffectivenessTracker } from "../tracking/persistence-effectiveness.js";
import type { TokenFlowWriter } from "../tracking/token-flow.js";
import { formatUnknownError } from "../utils/format-error.js";
import type { BackgroundIndexer } from "./background-indexer.js";
import type { LocalEmbeddingStore } from "./local-embeddings.js";
import type {
  CozoGraphStore,
  DriftEntity,
  LocalEntity,
} from "./local-graph.js";
import type { evaluateRules as EvaluateRulesFn } from "./rule-evaluator.js";
import { SessionContext } from "./session-context.js";
import type { createSessionHealthMonitor } from "./session-health-monitor.js";
import {
  estimateTokens,
  smartTruncate,
  truncateResultList,
} from "./smart-truncate.js";

export type ToolSource = "local";

/** L8.3: Deferred embedding computation status (shared between proxy and QueryRouter). */
export interface EmbeddingStatus {
  ready: boolean;
  progress: number;
  total: number;
}
export type ProxyMode = "local" | "parse" | "setup";

/**
 * Tool registry: all tools run locally against CozoDB.
 */
const LOCAL_TOOLS = new Set([
  "get_function",
  "get_class",
  "get_entity", // consolidated: replaces get_function + get_class
  "get_file",
  "get_callers",
  "get_callees",
  "get_references", // consolidated: replaces get_callers + get_callees
  "get_imports",
  "search_code",
  // "get_rules", // Disabled: no rules detected/stored yet, always returns empty
  // "check_rules", // Disabled: alias for get_rules validation mode
  // "get_business_context", // Disabled: not properly wired, produces no useful data
  "get_conventions",
  // "unerr_revert_entity", // Disabled: shadow ledger tool, not active

  // Leapfrog Sprint A: Community intelligence tools
  "get_cross_boundary_links",
  "get_critical_nodes",

  // Sprint 11: Phase 22 Blueprint Deep Dive tools (disabled — no tool-definitions wired)
  // "unerr_get_plan_context",
  // "unerr_get_next_slice",
  // "unerr_check_boundary",
  // "unerr_get_design_system",
  // "unerr_get_next_task",
  // "unerr_complete_task",
  // "unerr_get_sprint_context",
  // "unerr_get_checkpoint_status",

  // Local embedding tools (disabled — embedding store never wired in proxy/mcp-server)
  // "semantic_search",
  // "find_similar",
  "get_project_stats",

  // Sprint R: File-level graph tools
  "file_connections",
  "get_test_coverage",

  // Sprint FE-B: file read protocol
  "file_outline",
  "file_read",

  // Sprint FU-1: web fetch
  "fetch_url",
]);

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
    /** L8.3: Embedding computation status (e.g. "computing") */
    embedding_status?: string;
    /** S8.5: Value guard nudge — fires once when dollar threshold crossed. Anti-drift surfacing. */
    value_guard?: string;
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
  "get_critical_nodes",
  "get_cross_boundary_links",
  "get_test_coverage",
  "file_read",
  "file_outline",
  "file_connections",
  "get_project_stats",
  "get_file",
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

  /** L11.1: Background indexer reference — enables partial graph responses during indexing. */
  private backgroundIndexer: BackgroundIndexer | null = null;

  /** Sprint L3: Local embedding store for semantic search / find_similar. */
  private embeddingStore: LocalEmbeddingStore | null = null;

  /** L8.3: Deferred embedding computation status. */
  private embeddingStatus: EmbeddingStatus | null = null;

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

  /** S8.5: Value guard — fires once when session dollar threshold crossed. */
  private valueGuard: { check: (dollars: number) => string | null } | null =
    null;

  /** S8.5: Accumulated session dollar savings (tracked for guard). */
  private sessionDollarsSaved = 0;

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
   * Set the background indexer reference (L11.2).
   * When set and indexing is active, tools return partial results with indexing metadata.
   */
  setBackgroundIndexer(indexer: BackgroundIndexer): void {
    this.backgroundIndexer = indexer;
  }

  /**
   * Set the local embedding store (Sprint L3).
   * When set, semantic_search and find_similar route locally.
   */
  setEmbeddingStore(store: LocalEmbeddingStore): void {
    this.embeddingStore = store;
  }

  /**
   * Set the deferred embedding computation status (L8.3).
   * The proxy updates this object's progress/ready fields as computation proceeds.
   */
  setEmbeddingStatus(status: EmbeddingStatus): void {
    this.embeddingStatus = status;
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
   * S8.5: Set the value guard instance for dollar threshold notifications.
   */
  setValueGuard(guard: { check: (dollars: number) => string | null }): void {
    this.valueGuard = guard;
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
   * S8: Get accumulated session dollar savings for scorecard/guard.
   */
  getSessionDollarsSaved(): number {
    return this.sessionDollarsSaved;
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
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const t0 = performance.now();

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
      const refusal = this.routerGateway.gate(toolName);
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
            total_chars?: number;
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
              const fullFileTokens = fr._layer6_meta.total_chars
                ? Math.ceil(fr._layer6_meta.total_chars / 4)
                : Math.ceil((fr._layer6_meta.total_lines * 80) / 4);
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

      // L8.3: Merge inner _meta from executeLocal (e.g. embedding_status)
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
      const { body: cappedContent, pageHint: cappedHint } = applyCapEarly(
        toolName,
        cleanedContent,
        args
      );
      if (cappedHint) {
        // _unerr_page_hint is an internal-only field — wire boundaries
        // consume it (prepend to body) and never serialize it on the wire.
        (meta as Record<string, unknown>)._unerr_page_hint = cappedHint;
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
          const resultStr =
            typeof toolResult.content === "string"
              ? toolResult.content
              : JSON.stringify(toolResult.content);
          const tokensDelivered = Math.ceil(resultStr.length / 4);
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
        return [/* "check_rules", "get_business_context", */ "get_conventions"];
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
        };
        const rawBytes = typeof c?.raw_bytes === "number" ? c.raw_bytes : 0;
        const extractedBytes =
          typeof c?.extracted_bytes === "number" ? c.extracted_bytes : 0;
        // 4 chars/token: cl100k_base prose ratio (HTML + markdown are both
        // prose-shaped). See intelligence/token-estimator.ts CHARS_PER_TOKEN.
        const tokensWithout = Math.ceil(rawBytes / 4);
        const tokensWith = Math.ceil(extractedBytes / 4);
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
              raw_bytes: rawBytes,
              extracted_bytes: extractedBytes,
              source: "measured-bytes",
            },
          });
          // Feed real-measurement values into legacy trackers. PREVENT-class
          // events (graph queries, behaviors) are intentionally excluded —
          // they record discrete counts via behaviorEvents, not synthetic
          // saved/used numbers.
          this.tokenCounter?.record(saved, tokensWithout);
          this.sessionDollarsSaved += calculateDollarSavings(saved);
          this.valueGuard?.check(this.sessionDollarsSaved);
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
        const isFileNav =
          toolName === "file_outline" || toolName === "get_file";
        const type = isFileNav ? "full_read_avoided" : "graph_query_served";
        this.behaviorEvents?.record({
          session_id: this.behaviorEvents.sessionId,
          turn,
          type,
          tool: toolName,
          entity_key: entityKey,
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

        // Task 2.2: Blast radius (first query per entity)
        if (this.sessionContext.shouldInjectBlastRadius(entityKey)) {
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
          const communityInfo =
            await this.localGraph.getCommunityForEntity(entityKey);
          if (communityInfo && communityInfo.id >= 0) {
            result._meta.community = {
              id: communityInfo.id,
              label: communityInfo.label,
              size: communityInfo.size,
              cohesion: communityInfo.cohesion,
            };
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
              context.community = `Community "${communityInfo.label}" (${communityInfo.size} entities, cohesion ${communityInfo.cohesion}). ${crossEdges.length} cross-community connection${crossEdges.length !== 1 ? "s" : ""} to: ${[...new Set(crossEdges.map((e) => e.entity_community_label))].join(", ")}`;
            } else {
              context.community = `Community "${communityInfo.label}" (${communityInfo.size} entities, cohesion ${communityInfo.cohesion}). No cross-community connections.`;
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
          const corrections = await this.localGraph.getCorrections(
            entityKey,
            0.7
          );
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
          if (entity) {
            const conventions = await this.localGraph.getConventionsForEntity(
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
              const dedupedTokens = Math.ceil(dedupedContent.length / 4);
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
      (toolName === "get_function" ||
        toolName === "get_class" ||
        toolName === "get_file")
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
        });

        meta.truncated = truncated.truncated;
        meta.truncation_level = truncated.truncation_level;
        meta.tokens_used = truncated.tokens_used;
        meta.tokens_budget = truncated.tokens_budget;
        meta.full_tokens_estimate = truncated.full_tokens_estimate;

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
      case "get_file":
        return "file_content";
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

  private async executeLocal(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      case "get_file": {
        // Per tool description: "Get all entities in a file." Returns the
        // entity list — NOT a single fuzzy-matched entity (which is what the
        // shared get_entity/get_function/get_class path used to do, with
        // wrong results when "file:<path>" entities weren't indexed and the
        // fallback fuzzy resolver landed on similarly-named entities).
        const filePath = (args.key as string) ?? (args.name as string);
        if (!filePath) {
          throw new Error("get_file requires a file path in `key`");
        }
        const entities = await this.localGraph.getEntitiesByFile(filePath);
        return {
          file_path: filePath,
          entities,
          total: entities.length,
        };
      }
      case "get_entity": // consolidated: replaces get_function + get_class
      case "get_function": // alias (backward compat)
      case "get_class": {
        const rawArg = (args.key as string) ?? (args.name as string);
        // Aliases imply a kind even when the caller didn't pass one
        const aliasKind =
          toolName === "get_function"
            ? "function"
            : toolName === "get_class"
              ? "class"
              : undefined;
        const kindHint = (args.kind as string | undefined) ?? aliasKind;
        const key = await this.resolveKeyArg(rawArg, kindHint);
        const entity = await this.resolveEntityWithOverlay(key);
        // Resolve actual body from source file — CozoDB stores body_hash, not body text
        if (entity?.file_path && entity.start_line > 0) {
          try {
            const { readFileSync } = await import("node:fs");
            const { resolve } = await import("node:path");
            const cwd = this.projectRoot ?? process.cwd();
            const abs = resolve(cwd, entity.file_path);
            const lines = readFileSync(abs, "utf-8").split("\n");
            const start = entity.start_line - 1; // 0-based
            const end = entity.end_line ?? lines.length;
            const bodyLines = lines.slice(start, end);

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
                  _hint: `Structural preview only — showing first ${PREVIEW_LINES} of ${bodyLines.length} lines. Pass include_body:true (or token_budget:${Math.ceil(fullBody.length / CHARS_PER_TOKEN) + 100}) to get the full body.`,
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
                _hint: `Body truncated: showing ${truncatedLines.length} of ${bodyLines.length} lines (~${tokenBudget} tokens). To see the full entity, pass token_budget: ${Math.ceil(fullBody.length / CHARS_PER_TOKEN) + 100}. Or use file_read with offset: ${entity.start_line + truncatedLines.length}, limit: ${bodyLines.length - truncatedLines.length} to read the remaining lines.`,
              };
            } else {
              entity.body = fullBody;
            }
          } catch {
            // File may not exist on disk — keep whatever body the DB had
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
        const raw =
          direction === "callees"
            ? await this.localGraph.getCalleesOf(key)
            : await this.localGraph.getCallersOf(key);
        const totalCount = raw.length;
        const capped = raw.slice(0, limit);
        // Strip body from references to reduce token flood — callers/callees
        // only need signature, location, and metadata for navigation
        const results = capped.map(({ body: _body, ...rest }) => rest);
        return {
          references: results,
          direction,
          total: totalCount,
          returned: results.length,
          truncated: totalCount > limit,
          ...(totalCount > limit
            ? {
                _hint: `Showing ${limit} of ${totalCount}. Pass limit: ${totalCount} to see all.`,
              }
            : {}),
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
        const rows = await this.localGraph.getImports(filePath);
        // Graph stores file→file edges only — symbol names live in the source.
        // Read the file on demand and pair each resolved path with the symbols
        // imported from it. Failures degrade gracefully to path-only rows.
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
      case "search_code": {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 20;
        return await this.localGraph.searchEntities(query, limit);
      }
      // Disabled: get_rules + check_rules — no rules detected/stored yet, always returns empty.
      // case "get_rules": { ... }
      // case "check_rules": { ... }
      // Disabled: get_business_context — not properly wired, produces no useful data.
      // case "get_business_context": { ... }
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
        return {
          naming,
          import_direction,
          structure,
          ...(other.length > 0 ? { other } : {}),
          guidance: raw
            .filter((c) => c.confidence >= 0.7)
            .map(
              (c) =>
                `${c.name}: ${Math.round(c.adherence_rate * 100)}% adherence — follow for new ${c.kind}s`
            )
            .slice(0, 5),
          summary: `${raw.length} conventions. ${raw.filter((c) => c.adherence_rate >= 0.8).length} strongly adhered (>80%).`,
        };
      }
      case "get_cross_boundary_links": {
        const communityId = args.community_id as number | undefined;
        const topN = (args.top_n as number) ?? 20;
        const fromPath = args.from_path as string | undefined;
        const toPath = args.to_path as string | undefined;

        // When BOTH path filters are provided, run a targeted query with
        // starts_with directly in Datalog.  The old approach (fetch top-N
        // global cross-community edges, then JS-filter by path) breaks when
        // the target directories are tightly coupled (Louvain merges them into
        // one community so fc!=tc never fires) or when the budget runs out
        // before the relevant edges appear.
        if (fromPath && toPath) {
          const norm = (p: string) => p.replace(/\/+$/, "");
          const result = await this.localGraph.getCrossPathLinks(
            norm(fromPath),
            norm(toPath),
            topN
          );
          if (result.length === 0) {
            return {
              links: [],
              _hint:
                "No edges found between these directory prefixes. " +
                "call file_connections({file_path:'<file>'}) for import-level neighbors, " +
                "or get_references({entity:'<name>', direction:'callees'}) for call-level dependencies.",
            };
          }
          return result;
        }

        // Single-path filter or no filter: use community-based approach.
        const fetchN = fromPath ? Math.max(topN * 10, 200) : topN;
        const rows = await this.localGraph.getCrossBoundaryLinks(
          communityId,
          fetchN
        );
        if (!fromPath) return rows;
        const norm = (p?: string): string => (p ? p.replace(/\/+$/, "") : "");
        const f = norm(fromPath);
        const matches = (file: string, prefix: string): boolean =>
          !prefix ||
          file === prefix ||
          file.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
        const filtered = rows.filter(
          (r) => matches(r.from_file, f) || matches(r.to_file, f)
        );
        const result = filtered.slice(0, topN);
        if (result.length === 0) {
          return {
            links: [],
            _hint:
              "No cross-community edges found for this path filter. " +
              "call file_connections({file_path:'<file>'}) for import-level neighbors, " +
              "or get_references({entity:'<name>', direction:'callees'}) for call-level dependencies.",
          };
        }
        return result;
      }
      case "get_critical_nodes": {
        const topN = (args.top_n as number) ?? 10;
        const communityId = args.community_id as number | undefined;
        return await this.localGraph.getCriticalNodes(topN, communityId);
      }
      // case "unerr_revert_entity" disabled — shadow ledger tool, not active
      case "get_project_stats": {
        const stats = await this.localGraph.getLocalProjectStats();
        return {
          ...stats,
          healthGrade: this.healthGrade ?? "unknown",
        };
      }
      case "file_connections": {
        const filePath = args.file_path as string;
        if (!filePath) throw new Error("file_connections requires file_path");
        const neighbors = await this.localGraph.getFileNeighbors(filePath);
        const entities = await this.localGraph.getFileEntities(filePath);
        return { file: filePath, connections: neighbors, entities };
      }
      case "get_test_coverage": {
        const rawKey = args.key as string;
        if (!rawKey) throw new Error("get_test_coverage requires key");
        const key = await this.resolveKeyArg(rawKey);
        const includeTransitive = (args.include_transitive as boolean) ?? true;
        const coverage = await this.localGraph.getTestCoverage(
          key,
          includeTransitive
        );
        return {
          entity: key,
          test_count: coverage.length,
          tests: coverage,
          summary:
            coverage.length > 0
              ? `${coverage.length} test${coverage.length !== 1 ? "s" : ""} cover this entity`
              : "No test coverage found",
        };
      }
      // case "semantic_search" and "find_similar" disabled — embedding store never wired
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
        const { runFetchUrl } = await import(
          "../tools/web/fetch-url-protocol.js"
        );
        return runFetchUrl(
          args as unknown as Parameters<typeof runFetchUrl>[0],
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
      // Rank exact-name matches: kind-preferred (if specified) > class > function/method > everything else
      // The CASE-WHEN expression maps each kind to a sort weight; lower is better.
      const exact = await db.run(
        `?[k, kind, rank] := *entities{key: k, kind, name: $n},
          rank = if(kind == "class", 0, if(kind == "function", 1, if(kind == "method", 2, if(kind == "type", 3, if(kind == "interface", 4, if(kind == "variable", 5, 6))))))
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
    // Fuzzy fallback — use top result's key, or return raw if nothing matches
    try {
      const results = await this.localGraph.searchEntities(raw, 8);
      if (results.length === 0) return raw;
      if (kind) {
        const matchKind = results.find((r) => r.kind === kind);
        if (matchKind) return matchKind.key;
      }
      return results[0]!.key;
    } catch {
      return raw;
    }
  }

  /**
   * Resolve entity with drift overlay merge.
   * If entity exists in drift_overlay, overlay data replaces/augments base entity.
   */
  private async resolveEntityWithOverlay(
    key: string
  ): Promise<LocalEntity | (LocalEntity & { _drift: DriftEntity }) | null> {
    // Check drift overlay first
    const _driftEntities = await this.localGraph.getDriftEntitiesForFile("");
    // Need to check by key across all files - query drift_overlay directly
    let driftEntity: DriftEntity | null = null;
    try {
      const result = await (
        this.localGraph as unknown as { db: import("./cozo-schema.js").CozoDb }
      ).db.run(
        `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
          *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps],
          key = $key`,
        { key }
      );
      if (result.rows.length > 0) {
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
        // Entity was deleted locally — return null
        return null;
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
        const driftResult = await (
          this.localGraph as unknown as {
            db: import("./cozo-schema.js").CozoDb;
          }
        ).db.run(
          "?[ds, iid] := *drift_overlay[$key, _, _, _, _, _, _, _, _, ds, iid, _, _, _, _]",
          { key }
        );
        if (driftResult.rows.length > 0) {
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
}

/** Entity-returning tool names where risk injection is relevant. */
const ENTITY_TOOLS = new Set([
  "get_entity",
  "get_function",
  "get_class",
  "get_file",
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
/** Fields stripped only from array results (body is empty in list rows but useful in single-entity). */
const ENTITY_NOISE_FIELDS_ARRAY = new Set(["body", "community"]);

/** Tools that return entity arrays (or arrays wrapped in a metadata object)
 * where noise fields and sentinel placeholders should be stripped before
 * format encoding. */
const ENTITY_ARRAY_TOOLS = new Set([
  "get_callers",
  "get_callees",
  "get_references",
  "search_code",
  "file_connections",
  "file_outline",
]);

/** Tools that return single entity objects where noise fields should be stripped. */
const SINGLE_ENTITY_TOOLS = new Set([
  "get_entity",
  "get_function",
  "get_class",
  "get_file",
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
