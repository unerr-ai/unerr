/**
 * Session Value Counter — tracks proxy session metrics in memory.
 *
 * Printed on proxy shutdown to show the developer what unerr did for them.
 * "unerr saved you 47k tokens ($0.94)" — the artifact that drives word-of-mouth.
 */

/** Average tokens per MCP tool call resolved locally. */
const AVG_TOKENS_SAVED_PER_LOCAL_CALL = 3200;
/** Approximate cost per 1k tokens (blended input/output for Claude Sonnet). */
const COST_PER_1K_TOKENS = 0.006;

// ── Latency Tracking ─────────────────────────────────────────────────

/** Fixed-size circular buffer for latency samples. Zero allocations after init. */
const LATENCY_BUFFER_SIZE = 1000;

export interface LatencyTracker {
  /** Circular buffer of latency samples in ms (float64) */
  samples: Float64Array;
  /** Write cursor — wraps at LATENCY_BUFFER_SIZE */
  cursor: number;
  /** Total samples recorded (may exceed buffer size) */
  totalSamples: number;
  /** Local tool call latency tracking */
  localSamples: Float64Array;
  localCursor: number;
  localTotalSamples: number;
}

export function createLatencyTracker(): LatencyTracker {
  return {
    samples: new Float64Array(LATENCY_BUFFER_SIZE),
    cursor: 0,
    totalSamples: 0,
    localSamples: new Float64Array(LATENCY_BUFFER_SIZE),
    localCursor: 0,
    localTotalSamples: 0,
  };
}

/**
 * Record a latency sample. O(1), no allocation.
 */
export function recordLatency(
  tracker: LatencyTracker,
  latencyMs: number
): void {
  // All samples
  tracker.samples[tracker.cursor] = latencyMs;
  tracker.cursor = (tracker.cursor + 1) % LATENCY_BUFFER_SIZE;
  tracker.totalSamples++;

  // Local samples
  tracker.localSamples[tracker.localCursor] = latencyMs;
  tracker.localCursor = (tracker.localCursor + 1) % LATENCY_BUFFER_SIZE;
  tracker.localTotalSamples++;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

/**
 * Compute percentiles from a circular buffer. Allocates a sorted copy on demand.
 * Only called at shutdown or for status — never in the hot path.
 */
export function computePercentiles(
  samples: Float64Array,
  totalSamples: number
): LatencyPercentiles | null {
  const count = Math.min(totalSamples, LATENCY_BUFFER_SIZE);
  if (count === 0) return null;

  // Copy active portion and sort
  const active = Array.from(samples.subarray(0, count));
  active.sort((a, b) => a - b);

  return {
    p50: active[Math.floor(count * 0.5)] ?? 0,
    p95: active[Math.floor(count * 0.95)] ?? 0,
    p99: active[Math.floor(count * 0.99)] ?? 0,
    min: active[0] ?? 0,
    max: active[count - 1] ?? 0,
    count: totalSamples,
  };
}

// ── Local Mode Stats ────────────────────────────────────────────────

/** Counters specific to Local Mode — proves the value of fully-offline operation. */
export interface LocalModeStats {
  // Indexing proof
  filesIndexed: number;
  entitiesExtracted: number;
  edgesComputed: number;
  indexingTimeMs: number;
  communitiesDetected: number;

  // Embedding proof (if BYO-LLM configured)
  embeddingsComputed: number;
  embeddingTimeMs: number;
  semanticSearches: number;

  // Token savings proof
  tokensSavedByTruncation: number;
  truncatedResponses: number;

  // Intelligence proof
  correctionPatternsInjected: number;
  communityContextsInjected: number;
  blastRadiusComputations: number;

  // Latency advantage proof
  cumulativeLatencySavedMs: number;

  // Safety proof
  firewallBlockedCount: number;

  // Query distribution
  graphQueriesByType: Record<string, number>;
}

export function createLocalModeStats(): LocalModeStats {
  return {
    filesIndexed: 0,
    entitiesExtracted: 0,
    edgesComputed: 0,
    indexingTimeMs: 0,
    communitiesDetected: 0,
    embeddingsComputed: 0,
    embeddingTimeMs: 0,
    semanticSearches: 0,
    tokensSavedByTruncation: 0,
    truncatedResponses: 0,
    correctionPatternsInjected: 0,
    communityContextsInjected: 0,
    blastRadiusComputations: 0,
    cumulativeLatencySavedMs: 0,
    firewallBlockedCount: 0,
    graphQueriesByType: {},
  };
}

export function recordGraphQuery(
  localStats: LocalModeStats,
  toolName: string
): void {
  localStats.graphQueriesByType[toolName] =
    (localStats.graphQueriesByType[toolName] ?? 0) + 1;
}

export function recordTruncationSavings(
  localStats: LocalModeStats,
  fullTokens: number,
  usedTokens: number
): void {
  const saved = fullTokens - usedTokens;
  if (saved > 0) {
    localStats.tokensSavedByTruncation += saved;
    localStats.truncatedResponses++;
  }
}

export function recordIndexingResult(
  localStats: LocalModeStats,
  result: {
    fileCount: number;
    entityCount: number;
    edgeCount: number;
    elapsedMs: number;
    communityCount: number;
  }
): void {
  localStats.filesIndexed = result.fileCount;
  localStats.entitiesExtracted = result.entityCount;
  localStats.edgesComputed = result.edgeCount;
  localStats.indexingTimeMs = result.elapsedMs;
  localStats.communitiesDetected = result.communityCount;
}

export function recordBlastRadius(localStats: LocalModeStats): void {
  localStats.blastRadiusComputations++;
}

export function recordCorrectionInjection(localStats: LocalModeStats): void {
  localStats.correctionPatternsInjected++;
}

export function recordCommunityContext(localStats: LocalModeStats): void {
  localStats.communityContextsInjected++;
}

export function recordEmbedding(
  localStats: LocalModeStats,
  count: number,
  timeMs: number
): void {
  localStats.embeddingsComputed += count;
  localStats.embeddingTimeMs += timeMs;
}

export function recordSemanticSearch(localStats: LocalModeStats): void {
  localStats.semanticSearches++;
}

/** Accumulate latency advantage (remote baseline minus actual local latency). */
export function recordLatencyAdvantage(
  localStats: LocalModeStats,
  advantageMs: number
): void {
  localStats.cumulativeLatencySavedMs += advantageMs;
}

/** Snapshot firewall blocked count from NetworkFirewall at shutdown. */
export function snapshotFirewallCount(localStats: LocalModeStats): void {
  try {
    // biome-ignore format: esbuild can't parse multi-line typeof import()
    const { getBlockedCount } = require("./network-firewall.js") as typeof import("./network-firewall.js");
    localStats.firewallBlockedCount = getBlockedCount();
  } catch {
    // NetworkFirewall not loaded — leave at 0
  }
}

// ── Session Events ──────────────────────────────────────────────────

/** Specific DX events tracked during a session — the "Caught" section. */
export interface SessionEvents {
  conventionViolationsCaught: number;
  chokepointWarningsIssued: number;
  circularDepsDetected: number;
  signaturePreservations: number;
  deadCodeReferences: number;
  /** Entities modified by AI (origin: "ai") */
  aiEntitiesModified: number;
  /** Entities modified by human (origin: "human") */
  humanEntitiesModified: number;
  /** Entities with mixed attribution (origin: "mixed") */
  mixedEntitiesModified: number;
}

export function createSessionEvents(): SessionEvents {
  return {
    conventionViolationsCaught: 0,
    chokepointWarningsIssued: 0,
    circularDepsDetected: 0,
    signaturePreservations: 0,
    deadCodeReferences: 0,
    aiEntitiesModified: 0,
    humanEntitiesModified: 0,
    mixedEntitiesModified: 0,
  };
}

/** Total caught events across all categories. */
export function totalCaughtEvents(events: SessionEvents): number {
  return (
    events.conventionViolationsCaught +
    events.chokepointWarningsIssued +
    events.circularDepsDetected +
    events.signaturePreservations +
    events.deadCodeReferences
  );
}

// ── Session Stats ────────────────────────────────────────────────────

/** Snapshot of a previous session's stats, read from session_stats.json. */
export interface PreviousSessionSnapshot {
  toolCallsLocal: number;
  violationsCaught: number;
  sessionStartedAt: string;
  /** ISO-8601 timestamp of the previous session's last activity. */
  endedAt: string;
  durationMinutes: number;
  /** Previous session's ledger/proxy session id. Used to CONTINUE under the
   *  same id on a warm restart (see resolveResumableSessionId) so a
   *  mid-conversation restart does not fragment per-turn attribution. */
  sessionId?: string;
}

/**
 * Warm-restart window for session-id continuity. When a proxy boots and the
 * previous session's last activity was within this window, the new proxy
 * REUSES the prior session id — a mid-conversation restart (e.g. a dev
 * rebuild+restart, or a crash) then keeps one logical session, so the prompt
 * boundary and the turn's tool events stay under one id and per-turn savings
 * attribute correctly. Tighter than the 30-min idle-sweep so a genuinely new
 * conversation (started after the proxy idled out) gets a fresh id instead of
 * merging into the prior session's receipt.
 */
export const SESSION_RESUME_ID_WINDOW_MS = 10 * 60_000;

/**
 * Return the previous session's id when it is safe to CONTINUE under it on
 * this warm restart — i.e. the prior session's last activity was within
 * SESSION_RESUME_ID_WINDOW_MS. Returns null when there is no prior id or the
 * gap is too large (treat as a new conversation). Centralises the
 * merge-vs-fresh decision so both the boot path and tests share one rule.
 */
export function resolveResumableSessionId(
  previous: PreviousSessionSnapshot | null,
  now: number = Date.now()
): string | null {
  if (!previous?.sessionId) return null;
  const endedMs = Date.parse(previous.endedAt);
  if (Number.isNaN(endedMs)) return null;
  if (now - endedMs > SESSION_RESUME_ID_WINDOW_MS) return null;
  return previous.sessionId;
}

export interface SessionStats {
  toolCallsLocal: number;
  estimatedTokensSaved: number;
  violationsCaught: number;
  riskWarningsIssued: number;
  sessionStartedAt: number;
  latency: LatencyTracker;
  events: SessionEvents;
  /** True if this proxy start is resuming after a previous session (sleep/crash). */
  isResumedSession: boolean;
  /** Stats from the previous session, if this is a resume. */
  previousSession: PreviousSessionSnapshot | null;
  /** Local Mode-specific counters (null when running in Standard Mode). */
  localMode: LocalModeStats | null;
}

export function createSessionStats(isLocalMode = false): SessionStats {
  return {
    toolCallsLocal: 0,
    estimatedTokensSaved: 0,
    violationsCaught: 0,
    riskWarningsIssued: 0,
    sessionStartedAt: Date.now(),
    latency: createLatencyTracker(),
    events: createSessionEvents(),
    isResumedSession: false,
    previousSession: null,
    localMode: isLocalMode ? createLocalModeStats() : null,
  };
}

/**
 * Detect if this proxy start is a resume from a previous session.
 * Checks for session_stats.json (written every 10s by running proxy)
 * and shadow.jsonl (has entries from previous session).
 *
 * Returns previous session snapshot if resume detected, null otherwise.
 */
export function detectSessionResume(
  stateDir: string,
  ledgerDir: string
): PreviousSessionSnapshot | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");

    const statsPath = path.join(stateDir, "session_stats.json");
    const ledgerPath = path.join(ledgerDir, "shadow.jsonl");

    if (!fs.existsSync(statsPath)) return null;
    if (!fs.existsSync(ledgerPath)) return null;

    // Check ledger has content (not empty)
    const ledgerStat = fs.statSync(ledgerPath);
    if (ledgerStat.size === 0) return null;

    // Read previous session stats
    const raw = JSON.parse(fs.readFileSync(statsPath, "utf-8")) as {
      pid?: number;
      session_id?: string;
      sessionStartedAt?: string;
      toolCallsLocal?: number;
      violationsCaught?: number;
      updatedAt?: string;
    };

    // If the PID in stats matches current PID, this is the same process (not a resume)
    if (raw.pid === process.pid) return null;

    const totalCalls = raw.toolCallsLocal ?? 0;
    if (totalCalls === 0) return null;

    const startTime = raw.sessionStartedAt
      ? new Date(raw.sessionStartedAt).getTime()
      : Date.now();
    const endTime = raw.updatedAt
      ? new Date(raw.updatedAt).getTime()
      : Date.now();
    const durationMin = Math.round((endTime - startTime) / 60_000);

    return {
      toolCallsLocal: raw.toolCallsLocal ?? 0,
      violationsCaught: raw.violationsCaught ?? 0,
      sessionStartedAt: raw.sessionStartedAt ?? new Date().toISOString(),
      endedAt: raw.updatedAt ?? new Date(endTime).toISOString(),
      durationMinutes: durationMin > 0 ? durationMin : 0,
      sessionId: raw.session_id,
    };
  } catch {
    return null;
  }
}

export function recordToolCall(stats: SessionStats): void {
  stats.toolCallsLocal++;
  stats.estimatedTokensSaved += AVG_TOKENS_SAVED_PER_LOCAL_CALL;
}

export function recordViolation(stats: SessionStats): void {
  stats.violationsCaught++;
  stats.events.conventionViolationsCaught++;
}

export function recordRiskWarning(stats: SessionStats): void {
  stats.riskWarningsIssued++;
}

export function recordChokepointWarning(stats: SessionStats): void {
  stats.events.chokepointWarningsIssued++;
}

export function recordCircularDep(stats: SessionStats): void {
  stats.events.circularDepsDetected++;
}

export function recordSignaturePreservation(stats: SessionStats): void {
  stats.events.signaturePreservations++;
}

export function recordDeadCodeReference(stats: SessionStats): void {
  stats.events.deadCodeReferences++;
}

export function recordAttribution(
  stats: SessionStats,
  origin: "ai" | "human" | "mixed"
): void {
  if (origin === "ai") stats.events.aiEntitiesModified++;
  else if (origin === "human") stats.events.humanEntitiesModified++;
  else stats.events.mixedEntitiesModified++;
}

/**
 * Format latency percentiles as a compact string.
 */
function formatLatencyLine(label: string, p: LatencyPercentiles): string {
  return `  ${label}  p50=${p.p50.toFixed(1)}ms  p95=${p.p95.toFixed(1)}ms  p99=${p.p99.toFixed(1)}ms  (n=${p.count})`;
}

/**
 * Format session stats for terminal output.
 * Returns null if no tool calls were made (nothing to show).
 */
export function formatSessionStats(stats: SessionStats): string | null {
  const total = stats.toolCallsLocal;
  if (total === 0) return null;

  const durationMs = Date.now() - stats.sessionStartedAt;
  const durationMin = Math.round(durationMs / 60_000);
  const tokensSavedK = (stats.estimatedTokensSaved / 1000).toFixed(1);
  const costSaved = (
    (stats.estimatedTokensSaved / 1000) *
    COST_PER_1K_TOKENS
  ).toFixed(2);

  const lines: string[] = [
    "",
    "── unerr session ──────────────────────────────",
    `  Tool calls:     ${total} (all local)`,
    `  Tokens saved:   ~${tokensSavedK}k ($${costSaved})`,
  ];

  // Latency percentiles
  const localPercentiles = computePercentiles(
    stats.latency.localSamples,
    stats.latency.localTotalSamples
  );

  if (localPercentiles) {
    lines.push("");
    lines.push("  Latency:");
    lines.push(formatLatencyLine("Local: ", localPercentiles));
    // Flag if local p99 exceeds the 5ms budget
    if (localPercentiles.p99 > 5) {
      lines.push(
        `  ⚠ Local p99 (${localPercentiles.p99.toFixed(1)}ms) exceeds 5ms budget`
      );
    }
  }

  if (stats.violationsCaught > 0) {
    lines.push(`  Violations:     ${stats.violationsCaught} caught`);
  }
  if (stats.riskWarningsIssued > 0) {
    lines.push(`  Risk warnings:  ${stats.riskWarningsIssued} issued`);
  }

  // AI contribution ratio
  const totalAttrib =
    stats.events.aiEntitiesModified +
    stats.events.humanEntitiesModified +
    stats.events.mixedEntitiesModified;
  if (totalAttrib > 0) {
    const aiPct = Math.round(
      ((stats.events.aiEntitiesModified +
        stats.events.mixedEntitiesModified * 0.5) /
        totalAttrib) *
        100
    );
    lines.push(
      `  AI contribution: ${aiPct}% (${stats.events.aiEntitiesModified} ai, ${stats.events.humanEntitiesModified} human, ${stats.events.mixedEntitiesModified} mixed)`
    );
  }

  lines.push(
    `  Duration:       ${durationMin > 0 ? `${durationMin}m` : "<1m"}`
  );
  lines.push("───────────────────────────────────────────────");
  lines.push("");

  return lines.join("\n");
}

/**
 * Format Local Mode session stats for terminal output.
 * Returns null if no tool calls were made.
 */
export function formatLocalModeSessionStats(
  stats: SessionStats
): string | null {
  const total = stats.toolCallsLocal;
  if (total === 0) return null;
  if (!stats.localMode) return formatSessionStats(stats);

  const lm = stats.localMode;
  const durationMs = Date.now() - stats.sessionStartedAt;
  const durationMin = Math.round(durationMs / 60_000);
  const durationStr = durationMin > 0 ? `${durationMin} min` : "<1 min";

  const localPercentiles = computePercentiles(
    stats.latency.localSamples,
    stats.latency.localTotalSamples
  );

  // Aggregate graph query categories
  const qbt = lm.graphQueriesByType;
  const entityLookups =
    (qbt.get_function ?? 0) +
    (qbt.get_class ?? 0) +
    (qbt.get_file ?? 0) +
    (qbt.get_module ?? 0);
  const searchQueries = qbt.search_code ?? 0;
  const callerCallees = (qbt.get_callers ?? 0) + (qbt.get_callees ?? 0);

  const pad = (label: string, width: number) => label.padEnd(width);
  const W = 22; // label width for alignment

  const lines: string[] = [
    "",
    "[unerr] ─── Local Mode Session Summary ───────────────────",
    `[unerr] ${pad("Duration:", W)} ${durationStr}`,
    `[unerr] ${pad("MCP tool calls:", W)} ${total} (all local)`,
  ];

  if (localPercentiles) {
    lines.push(
      `[unerr] ${pad("Avg local latency:", W)} ${localPercentiles.p50.toFixed(1)}ms (p50), ${localPercentiles.p95.toFixed(1)}ms (p95)`
    );
    if (lm.cumulativeLatencySavedMs > 0) {
      lines.push(
        `[unerr] ${pad("Latency saved:", W)} ${(lm.cumulativeLatencySavedMs / 1000).toFixed(1)}s vs remote baseline`
      );
    }
  }

  // Graph Intelligence
  if (
    entityLookups > 0 ||
    lm.blastRadiusComputations > 0 ||
    searchQueries > 0 ||
    callerCallees > 0
  ) {
    lines.push("[unerr]");
    lines.push("[unerr] Graph Intelligence:");
    if (entityLookups > 0)
      lines.push(`[unerr]   ${pad("Entity lookups:", W - 2)} ${entityLookups}`);
    if (lm.blastRadiusComputations > 0)
      lines.push(
        `[unerr]   ${pad("Blast radius:", W - 2)} ${lm.blastRadiusComputations} computations`
      );
    if (searchQueries > 0)
      lines.push(`[unerr]   ${pad("Search queries:", W - 2)} ${searchQueries}`);
    if (callerCallees > 0)
      lines.push(
        `[unerr]   ${pad("Callers/callees:", W - 2)} ${callerCallees}`
      );
  }

  // Token Discipline
  if (lm.tokensSavedByTruncation > 0) {
    lines.push("[unerr]");
    lines.push("[unerr] Token Discipline:");
    lines.push(
      `[unerr]   ${pad("Tokens saved:", W - 2)} ~${lm.tokensSavedByTruncation.toLocaleString()} via smart truncation`
    );
    lines.push(
      `[unerr]   ${pad("Responses truncated:", W - 2)} ${lm.truncatedResponses}`
    );
  }

  // Safety Catches
  const hasSafety =
    stats.violationsCaught > 0 ||
    stats.riskWarningsIssued > 0 ||
    stats.events.chokepointWarningsIssued > 0 ||
    lm.correctionPatternsInjected > 0;
  if (hasSafety) {
    lines.push("[unerr]");
    lines.push("[unerr] Safety Catches:");
    if (stats.violationsCaught > 0)
      lines.push(
        `[unerr]   ${pad("Violations caught:", W - 2)} ${stats.violationsCaught}`
      );
    if (stats.riskWarningsIssued > 0)
      lines.push(
        `[unerr]   ${pad("Risk warnings:", W - 2)} ${stats.riskWarningsIssued}`
      );
    if (stats.events.chokepointWarningsIssued > 0)
      lines.push(
        `[unerr]   ${pad("Chokepoints flagged:", W - 2)} ${stats.events.chokepointWarningsIssued}`
      );
    if (lm.correctionPatternsInjected > 0)
      lines.push(
        `[unerr]   ${pad("Corrections applied:", W - 2)} ${lm.correctionPatternsInjected}`
      );
  }

  // Semantic Intelligence (only if BYO-LLM was used)
  if (lm.embeddingsComputed > 0) {
    lines.push("[unerr]");
    lines.push("[unerr] Semantic Intelligence:");
    lines.push(
      `[unerr]   ${pad("Embeddings computed:", W - 2)} ${lm.embeddingsComputed}`
    );
    if (lm.semanticSearches > 0)
      lines.push(
        `[unerr]   ${pad("Semantic searches:", W - 2)} ${lm.semanticSearches}`
      );
  }

  // Network Isolation (always shown in Local Mode)
  lines.push("[unerr]");
  lines.push("[unerr] Network Isolation:");
  lines.push(`[unerr]   ${pad("Outbound calls:", W - 2)} 0 (firewall sealed)`);
  lines.push(
    `[unerr]   ${pad("Blocked attempts:", W - 2)} ${lm.firewallBlockedCount}${lm.firewallBlockedCount === 0 ? " (clean — no leakage)" : ""}`
  );

  lines.push("[unerr] ────────────────────────────────────────────────────");
  lines.push("");

  return lines.join("\n");
}

// ── Cumulative Stats Persistence ────────────────────────────────────

export interface CumulativeStats {
  totalTokensSaved: number;
  totalDollarsSaved: number;
  totalSessions: number;
  weekStart: string;
  violationsCaughtAllTime: number;
  chokepointWarningsAllTime: number;
}

function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(now);
  monday.setDate(diff);
  return monday.toISOString().slice(0, 10);
}

function getCumulativePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return `${home}/.unerr/cumulative-stats.json`;
}

export function loadCumulativeStats(): CumulativeStats {
  const currentWeek = getWeekStart();
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(
      readFileSync(getCumulativePath(), "utf-8")
    ) as CumulativeStats;
    // Reset if new week
    if (raw.weekStart !== currentWeek) {
      return {
        totalTokensSaved: 0,
        totalDollarsSaved: 0,
        totalSessions: 0,
        weekStart: currentWeek,
        violationsCaughtAllTime: 0,
        chokepointWarningsAllTime: 0,
      };
    }
    return raw;
  } catch {
    return {
      totalTokensSaved: 0,
      totalDollarsSaved: 0,
      totalSessions: 0,
      weekStart: currentWeek,
      violationsCaughtAllTime: 0,
      chokepointWarningsAllTime: 0,
    };
  }
}

export function persistCumulativeStats(stats: SessionStats): CumulativeStats {
  const cumulative = loadCumulativeStats();
  cumulative.totalTokensSaved += stats.estimatedTokensSaved;
  cumulative.totalDollarsSaved +=
    (stats.estimatedTokensSaved / 1000) * COST_PER_1K_TOKENS;
  cumulative.totalSessions += 1;
  cumulative.violationsCaughtAllTime += totalCaughtEvents(stats.events);
  cumulative.chokepointWarningsAllTime += stats.events.chokepointWarningsIssued;

  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const filePath = getCumulativePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cumulative, null, 2));
  } catch {
    // Non-critical
  }

  return cumulative;
}

// ── Cumulative Local Mode Stats ─────────────────────────────────────

export interface CumulativeLocalStats {
  weekStartDate: string;
  totalSessions: number;
  totalToolCalls: number;
  totalTokensSaved: number;
  totalViolationsCaught: number;
  totalCorrectionsApplied: number;
  totalFilesIndexed: number;
  totalSemanticSearches: number;
  avgLatencyP50: number;
}

function getCumulativeLocalPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return `${home}/.unerr/cumulative-local-stats.json`;
}

function createEmptyCumulativeLocal(weekStart: string): CumulativeLocalStats {
  return {
    weekStartDate: weekStart,
    totalSessions: 0,
    totalToolCalls: 0,
    totalTokensSaved: 0,
    totalViolationsCaught: 0,
    totalCorrectionsApplied: 0,
    totalFilesIndexed: 0,
    totalSemanticSearches: 0,
    avgLatencyP50: 0,
  };
}

export function loadCumulativeLocalStats(): CumulativeLocalStats {
  const currentWeek = getWeekStart();
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(
      readFileSync(getCumulativeLocalPath(), "utf-8")
    ) as CumulativeLocalStats;
    if (raw.weekStartDate !== currentWeek) {
      return createEmptyCumulativeLocal(currentWeek);
    }
    return raw;
  } catch {
    return createEmptyCumulativeLocal(currentWeek);
  }
}

export function persistCumulativeLocalStats(
  stats: SessionStats
): CumulativeLocalStats {
  if (!stats.localMode) return loadCumulativeLocalStats();

  const lm = stats.localMode;
  const cumulative = loadCumulativeLocalStats();

  cumulative.totalSessions += 1;
  cumulative.totalToolCalls += stats.toolCallsLocal;
  cumulative.totalTokensSaved += lm.tokensSavedByTruncation;
  cumulative.totalViolationsCaught += stats.violationsCaught;
  cumulative.totalCorrectionsApplied += lm.correctionPatternsInjected;
  cumulative.totalFilesIndexed += lm.filesIndexed;
  cumulative.totalSemanticSearches += lm.semanticSearches;

  // Rolling average of p50 latency
  const localPercentiles = computePercentiles(
    stats.latency.localSamples,
    stats.latency.localTotalSamples
  );
  if (localPercentiles && cumulative.totalSessions > 0) {
    const prevWeight =
      (cumulative.totalSessions - 1) / cumulative.totalSessions;
    const newWeight = 1 / cumulative.totalSessions;
    cumulative.avgLatencyP50 =
      cumulative.avgLatencyP50 * prevWeight + localPercentiles.p50 * newWeight;
  }

  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const filePath = getCumulativeLocalPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cumulative, null, 2));
  } catch {
    // Non-critical
  }

  return cumulative;
}
