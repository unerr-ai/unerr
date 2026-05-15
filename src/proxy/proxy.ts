/**
 * Unified Proxy Loop — the heart of the Local-First Intelligence Proxy.
 *
 * Combines serve (MCP server), index (auto-index on startup), and watch (file watcher)
 * into a single long-lived process.
 *
 * Boot sequence:
 *   1. PID lock → single-instance enforcement
 *   2. Graph bootstrap → load CozoDB, pull if missing/stale
 *   3. MCP server → stdio transport, 13 tools registered
 *   4. Session stats → in-memory counters, print on shutdown
 *
 * CRITICAL: All logging goes to stderr. stdout is reserved for MCP JSON-RPC.
 */

import {
  existsSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { aliasAndValidate } from "./arg-validator.js";
import { PidLock } from "./pid-lock.js";
import {
  type SessionStats,
  createSessionStats,
  detectSessionResume,
  formatLocalModeSessionStats,
  recordBlastRadius,
  recordChokepointWarning,
  recordCircularDep,
  recordCommunityContext,
  recordCorrectionInjection,
  recordDeadCodeReference,
  recordGraphQuery,
  recordIndexingResult,
  recordLatency,
  recordLatencyAdvantage,
  recordRiskWarning,
  recordSignaturePreservation,
  recordToolCall,
  recordViolation,
} from "./session-stats.js";
import { StartupRenderer } from "./startup-renderer.js";
import { ToolUsageTracker, reorderToolsByCluster } from "./tool-clusters.js";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";

import { installFileLogger } from "../utils/file-logger.js";
import { formatUnknownError } from "../utils/format-error.js";
import { stringifyMcpToolJson } from "../utils/mcp-content-json.js";
import { startupLog } from "../utils/startup-log.js";
import {
  type LifecycleActor,
  createLifecycleActor,
} from "./lifecycle-actor.js";

/** stderr-only logger. stdout is MCP territory. */
const log = {
  info: (msg: string) => process.stderr.write(`[unerr] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerr] WARN: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[unerr] ERROR: ${msg}\n`),
};

export interface ProxyOptions {
  /** Specific repo ID (auto-detected from .unerr/config.json if omitted) */
  repoId?: string;
  /** Enable predictive context pre-fetching */
  prefetch?: boolean;
  /** Sprint 5.3: HTTP port for Streamable HTTP transport (0 = disabled) */
  httpPort?: number;
  /** Running as a daemon-managed child (suppresses startup renderer, PID lock is per-repo) */
  daemonChild?: boolean;
}

// ── Layer 9: Fact tool handlers for long-lived proxy ────────────────

type FactStoreType = import(
  "../intelligence/temporal-facts.js"
).TemporalFactStore;
type SignalShowStoreType = import(
  "../intelligence/signal-show-store.js"
).SignalShowStore;
let proxyFactStore: FactStoreType | null | undefined = undefined; // undefined = not yet initialized
let proxyShowStore: SignalShowStoreType | null = null;

async function getProxyFactStore(
  unerrDir: string
): Promise<FactStoreType | null> {
  if (proxyFactStore !== undefined) return proxyFactStore;
  try {
    const { TemporalFactStore } = await import(
      "../intelligence/temporal-facts.js"
    );
    const cwd = join(unerrDir, "..");
    proxyFactStore = await TemporalFactStore.create(cwd);
    return proxyFactStore;
  } catch {
    proxyFactStore = null;
    return null;
  }
}

async function handleRecordFactProxy(
  args: Record<string, unknown>,
  unerrDir: string,
  shadowLedger: import("../tracking/shadow-ledger.js").ShadowLedger,
  effectiveness?: {
    tracker: import(
      "../tracking/persistence-effectiveness.js"
    ).PersistenceEffectivenessTracker;
    turn: number;
  }
): Promise<{
  content: Array<{ type: string; text: string }>;
  _meta?: unknown;
  /** MCP CallToolResult flag — when true, clients surface the response as a failed tool call. */
  isError?: boolean;
}> {
  const factStore = await getProxyFactStore(unerrDir);
  if (!factStore) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Fact store not available. Ensure .unerr/ directory exists.",
          }),
        },
      ],
    };
  }
  try {
    const { executeRecordFact } = await import(
      "../tools/intelligence/record-fact.js"
    );
    const result = await executeRecordFact(
      args as {
        content: string;
        fact_type: "procedural" | "semantic" | "negative" | "convention";
        scope: string;
        subject: string;
      },
      factStore,
      shadowLedger.getSessionId()
    );
    if (effectiveness) {
      effectiveness.tracker.recordSignalFired({
        kind: "fact_recorded",
        signal_id: result.fact_id,
        entity_key: (args.subject as string | undefined) ?? null,
        turn: effectiveness.turn,
      });
    }
    shadowLedger.record(
      "record_fact",
      args,
      { fact_id: result.fact_id },
      "unknown",
      ""
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // isError:true is the only channel MCP clients (Claude Code, Cursor)
    // surface as a failed tool call in the agent's conversation. Without
    // it, an error body looks like a normal successful response and the
    // agent reads it as data.
    process.stderr.write(`[unerr] record_fact failed: ${errMsg}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: errMsg }) }],
      isError: true,
    };
  }
}

async function handleRecallFactsProxy(
  args: Record<string, unknown>,
  unerrDir: string,
  effectiveness?: {
    tracker: import(
      "../tracking/persistence-effectiveness.js"
    ).PersistenceEffectivenessTracker;
    turn: number;
  }
): Promise<{
  content: Array<{ type: string; text: string }>;
  _meta?: unknown;
  /** MCP CallToolResult flag — when true, clients surface the response as a failed tool call. */
  isError?: boolean;
}> {
  const factStore = await getProxyFactStore(unerrDir);
  if (!factStore) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            facts: [],
            message: "Fact store not available",
          }),
        },
      ],
    };
  }
  try {
    const scope = args.scope as string;
    const factType = (args.fact_type as string) ?? "all";
    const minConfidence = (args.min_confidence as number) ?? 0.3;
    const rotationMode =
      (args.rotation as "decay" | "fifo" | "none" | undefined) ?? "decay";
    const { applyDiversityQuota, rankFactsWithRotation, resolveFactLimit } =
      await import("./fact-ranking.js");
    const requestedLimit = resolveFactLimit(args.limit);

    let facts: Awaited<ReturnType<typeof factStore.recallNegative>>;
    if (factType === "negative") {
      facts = await factStore.recallNegative(minConfidence);
    } else {
      facts = await factStore.recallByScope(scope, minConfidence);
      if (factType !== "all") {
        facts = facts.filter((f) => f.fact_type === factType);
      }
    }

    const useRotation = rotationMode !== "none" && proxyShowStore !== null;
    const ranked = rankFactsWithRotation(facts, {
      getShowCount: useRotation
        ? (id) => proxyShowStore?.getEffectiveShowCount(id) ?? 0
        : undefined,
      getLastShownMs: useRotation
        ? (id) => proxyShowStore?.getLastShownMs(id) ?? 0
        : undefined,
    });
    const total = ranked.length;
    const sliced = applyDiversityQuota(ranked, requestedLimit);

    // (Removed: rotation-impact counter only used by the dropped ur|rot prefix.)

    if (proxyShowStore) {
      for (const f of sliced) {
        proxyShowStore.recordShown(f.fact_id, scope ?? "");
      }
    }
    if (effectiveness) {
      for (const f of sliced) {
        effectiveness.tracker.recordSignalFired({
          kind:
            f.fact_type === "negative" ? "negative_warned" : "fact_recalled",
          signal_id: f.fact_id,
          entity_key: f.subject ?? null,
          turn: effectiveness.turn,
        });
      }
    }

    const response = sliced.map((f) => ({
      fact_id: f.fact_id,
      type: f.fact_type,
      content: f.content,
      confidence: Math.round(f.effective_confidence * 100) / 100,
      subject: f.subject,
      source: f.source,
      reinforced: f.reinforcement_count,
    }));

    const body: Record<string, unknown> = {
      facts: response,
      total,
      returned: response.length,
    };
    if (total > response.length) {
      body.more_available = total - response.length;
    }

    // Table row #23 CUT-FLUFF — `ur|rot` was pure internal debug
    // ("N facts deprioritized — rotation surfaced fresh picks"). The agent
    // could not act on it; rotation is a server-side concept. Body already
    // contains the rotated picks; no prefix needed.
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] recall_facts failed: ${errMsg}\n`);
    return {
      content: [
        { type: "text", text: JSON.stringify({ facts: [], error: errMsg }) },
      ],
      isError: true,
    };
  }
}

/**
 * Start the unified proxy loop. This is the main entry point.
 * Returns a cleanup function for testing.
 */
/**
 * Migrate agent permission config: remove "Read" from deny list.
 * Read must remain available for the Edit workflow.
 */
function migrateAgentPermissions(cwd: string): void {
  try {
    const settingsPath = join(cwd, ".claude", "settings.json");
    if (!existsSync(settingsPath)) return;
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const deny = settings?.permissions?.deny;
    if (!Array.isArray(deny)) return;
    const readIdx = deny.indexOf("Read");
    if (readIdx < 0) return;
    deny.splice(readIdx, 1);
    fsWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    process.stderr.write(
      "[unerr] Migrated permissions: removed Read from deny list (required for Edit workflow)\n"
    );
  } catch {
    // Non-critical — settings migration is best-effort
  }
}

export async function startProxy(opts: ProxyOptions = {}): Promise<{
  shutdown: () => Promise<void>;
  stats: SessionStats;
}> {
  // Mirror stderr to a rotating .log so crash traces during startup land on
  // disk even when the process is detached (DM-3 auto-spawn).
  installFileLogger({
    filePath: join(process.cwd(), ".unerr", "logs", "unerr.log"),
    maxBytes: 5_000_000,
    keep: 5,
  });

  const stats = createSessionStats(true);
  const startup = new StartupRenderer();
  if (!opts.daemonChild) {
    startup.mount();
  }

  // Migrate agent permissions on every startup (idempotent)
  migrateAgentPermissions(process.cwd());

  const lifecycle = createLifecycleActor(process.cwd());
  lifecycle.send({ type: "START_DETECT" });

  startup.setLocalMode(true);

  // ── Step 1: PID Lock ─────────────────────────────────────────────

  const stateDir = join(process.cwd(), ".unerr", "state");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const pidLock = new PidLock(stateDir);
  const lockResult = await pidLock.acquire();

  if (!lockResult.acquired) {
    log.info(
      `Proxy already running (PID ${lockResult.existingPid}). Secondary IDEs can connect via UDS at .unerr/state/proxy.sock`
    );
    process.exit(0);
  }

  if (lockResult.outcome === "stale_recovered") {
    log.warn("Recovered from stale PID file (previous proxy crashed)");
  }

  startupLog.header();
  startupLog.step(
    `PID ${process.pid} ${startupLog.fmt.muted(`· health localhost:${lockResult.healthPort}`)}`
  );

  // ── Step 1b: Session Resume Detection ────────────────────────────

  const ledgerDir = join(process.cwd(), ".unerr", "ledger");
  const previousSession = detectSessionResume(stateDir, ledgerDir);
  if (previousSession) {
    stats.isResumedSession = true;
    stats.previousSession = previousSession;
    const prevTotal = previousSession.toolCallsLocal;
    startupLog.sessionResumed(prevTotal, previousSession.durationMinutes);
  }

  // Track proxy capability — may degrade to PARSE if CozoDB unavailable
  let proxyMode: import("../intelligence/query-router.js").ProxyMode = "local";
  let proxyModeReason = "All intelligence runs locally";

  // ── Step 2: Discover repos ───────────────────────────────────────

  startup.addStep("Repository", "active");
  let repoIds: string[] = [];
  if (opts.repoId) {
    repoIds = [opts.repoId];
  } else {
    // Auto-detect from local .unerr/config.json
    const configPath = join(process.cwd(), ".unerr", "config.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
          repoId?: string;
        };
        if (config.repoId) repoIds = [config.repoId];
      } catch {
        /* fallthrough to manifest discovery */
      }
    }
    // Fallback: discover from manifests
    const manifestsDir = join(process.cwd(), ".unerr", "manifests");
    if (repoIds.length === 0 && existsSync(manifestsDir)) {
      repoIds = readdirSync(manifestsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
    }
  }

  // ── Step 3b: Auto-Bootstrap if no repos found ───────────────────

  if (repoIds.length === 0) {
    // Generate a deterministic local repoId from git remote or dir name
    const { createHash } = await import("node:crypto");
    let repoIdentifier = process.cwd();
    try {
      const { getRemoteUrl } = await import("../utils/git.js");
      const remote = await getRemoteUrl(process.cwd());
      if (remote) repoIdentifier = remote;
    } catch {
      // No git remote — use cwd
    }
    const localRepoId = createHash("sha256")
      .update(repoIdentifier)
      .digest("hex")
      .slice(0, 12);
    repoIds = [localRepoId];
    startupLog.done(
      `Repository ${startupLog.fmt.cyan(localRepoId)} ${startupLog.fmt.muted(`(from ${repoIdentifier === process.cwd() ? "directory" : "git remote"})`)}`
    );
  }

  // Update repository step
  if (repoIds.length > 0) {
    startup.updateStep("Repository", "done", repoIds[0] ?? "");
  } else {
    startup.updateStep("Repository", "error", "No repo found");
  }

  lifecycle.send({
    type: "DETECT_COMPLETE",
    needsSetup: repoIds.length === 0,
    repoId: repoIds[0],
  });

  // ── Step 4: Graph Bootstrap (skipped in PARSE mode) ──────────────

  startup.addStep(
    "Graph loaded",
    (proxyMode as string) === "parse" ? "pending" : "active"
  );
  let localGraph:
    | import("../intelligence/local-graph.js").CozoGraphStore
    | null = null;
  let parseIndex: import("./auto-bootstrap.js").ParseModeIndex | null = null;
  // L11: Background indexing flag — hoisted for access after MCP server.connect()
  let needsBackgroundIndex = false;

  if ((proxyMode as string) !== "parse") {
    const projectRoot = process.cwd();

    try {
      const { openPersistentDb } = await import(
        "../intelligence/persistent-db.js"
      );
      const { db, isNew, dbPath } = await openPersistentDb(projectRoot);

      const { CozoGraphStore } = await import("../intelligence/local-graph.js");
      const graphStart = Date.now();
      localGraph = await CozoGraphStore.create(db);

      const graphOpenMs = Date.now() - graphStart;

      if (!isNew && (await localGraph.isPopulated())) {
        // ── Persistent DB: graph already fully populated ──────────────
        // All entities, edges, communities, conventions, rules survive across restarts.
        // No snapshot loading, no re-detection — instant availability.
        const projStats = await localGraph.getLocalProjectStats();
        const rules = await localGraph.getRules();
        const ruleCount = rules?.length ?? 0;
        const communityResult = await localGraph.db.run(
          "?[count(id)] := *communities[id, _, _, _]"
        );
        const communityCount = (communityResult.rows[0]?.[0] as number) ?? 0;
        const patternResult = await localGraph.db.run(
          "?[count(key)] := *patterns[key, _, _, _, _, _, _]"
        );
        const patternCount = (patternResult.rows[0]?.[0] as number) ?? 0;

        startup.setLocalIndexStats({
          fileCount: projStats.fileCount,
          entityCount: projStats.entityCount,
          edgeCount: projStats.edgeCount,
          indexingTimeMs: graphOpenMs,
          communityCount,
          conventionCount: patternCount,
          ruleCount,
        });

        const hottest = projStats.topFiles?.[0];
        startupLog.graphLoaded({
          entities: projStats.entityCount,
          edges: projStats.edgeCount,
          files: projStats.fileCount,
          communities: communityCount,
          patterns: patternCount,
          rules: ruleCount,
          ms: graphOpenMs,
          hottestFile: hottest?.filePath,
          hottestCount: hottest?.entityCount,
        });
        startupLog.perf(
          `${startupLog.fmt.cyan("Persistent graph")} ${startupLog.fmt.muted("— zero recomputation, all intelligence preserved")}`
        );

        // Always reindex on startup to ensure graph data (end_line, etc.) is fresh
        needsBackgroundIndex = true;
        startupLog.step(
          `${startupLog.fmt.muted("Background reindex will refresh graph data after MCP ready")}`
        );
      } else {
        // ── Fresh DB or empty: needs initial indexing ─────────────────
        // Check for existing msgpack snapshot to migrate from
        const { loadLocalSnapshot } = await import(
          "../intelligence/local-snapshot.js"
        );
        const snapshotStart = Date.now();
        const migrated = await loadLocalSnapshot(projectRoot, localGraph);

        if (migrated) {
          // One-time migration: snapshot → persistent DB
          const snapshotMs = Date.now() - snapshotStart;
          const { buildSearchIndex } = await import(
            "../intelligence/search-index.js"
          );
          await buildSearchIndex(localGraph.db);
          const { runCommunityDetection, runConventionDetection } =
            await import("../intelligence/local-indexer.js");
          const communityCount = await runCommunityDetection(localGraph);
          const { patternCount, ruleCount } = await runConventionDetection(
            localGraph,
            repoIds[0] as string
          );

          const projStats = await localGraph.getLocalProjectStats();
          startup.setLocalIndexStats({
            fileCount: projStats.fileCount,
            entityCount: projStats.entityCount,
            edgeCount: projStats.edgeCount,
            indexingTimeMs: snapshotMs,
            communityCount,
            conventionCount: patternCount,
            ruleCount,
          });

          const hottest = projStats.topFiles?.[0];
          startupLog.graphLoaded({
            entities: projStats.entityCount,
            edges: projStats.edgeCount,
            files: projStats.fileCount,
            communities: communityCount,
            patterns: patternCount,
            rules: ruleCount,
            ms: snapshotMs,
            hottestFile: hottest?.filePath,
            hottestCount: hottest?.entityCount,
          });
          startupLog.done(
            `Migrated snapshot to persistent graph ${startupLog.fmt.muted(`→ ${dbPath}`)}`
          );

          // Layer 9: Generate temporal facts from conventions after snapshot migration
          try {
            const migrationUnerrDir = join(process.cwd(), ".unerr");
            const factStoreForMigration =
              await getProxyFactStore(migrationUnerrDir);
            if (factStoreForMigration) {
              const { detectLocalConventions } = await import(
                "../intelligence/local-convention-detector.js"
              );
              const { generateFromConventions, runFactGenerationPipeline } =
                await import("../intelligence/fact-generator.js");
              const detection = await detectLocalConventions(localGraph.db);
              if (detection.conventions.length > 0) {
                const convResult = await generateFromConventions(
                  factStoreForMigration,
                  detection.conventions
                );
                if (convResult.created > 0 || convResult.reinforced > 0) {
                  log.info(
                    `Fact generator: ${convResult.created} convention facts created, ${convResult.reinforced} reinforced`
                  );
                }
              }
              const pipelineResults = await runFactGenerationPipeline(
                factStoreForMigration,
                migrationUnerrDir
              );
              for (const r of pipelineResults) {
                if (r.created > 0 || r.reinforced > 0) {
                  log.info(
                    `Fact generator [${r.source}]: ${r.created} created, ${r.reinforced} reinforced`
                  );
                }
              }
            }
          } catch {
            // Non-critical — fact generation failure doesn't block startup
          }
        } else {
          // No snapshot available — full index needed
          needsBackgroundIndex = true;
          startupLog.step(
            `${startupLog.fmt.muted("First run — full index will start after MCP ready")}`
          );
        }
      }
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
            ? JSON.stringify(err)
            : String(err);
      log.warn(
        `Failed to open persistent graph: ${errMsg}. Falling back to PARSE mode.`
      );
      proxyMode = "parse";
      proxyModeReason = "CozoDB unavailable. Running in parse-only mode.";
    }
  }

  // Health grade computation — deferred to after MCP ready (Task 6.3)
  let healthResult:
    | import("../intelligence/health-grade.js").HealthGradeResult
    | null = null;
  if (localGraph && proxyMode !== "parse") {
    startup.updateStep("Graph loaded", "done");
    lifecycle.send({ type: "GRAPH_LOADED" });
  } else if (proxyMode === "parse") {
    startup.updateStep("Graph loaded", "pending", "PARSE mode");
  }

  // PARSE mode: create empty index now — populate asynchronously after MCP ready (Task 6.3)
  if (proxyMode === "parse") {
    const { ParseModeIndex } = await import("./auto-bootstrap.js");
    parseIndex = new ParseModeIndex();
  }

  // ── Step 5: Router ─────────────────────────────────────────────

  let ruleEvaluator:
    | typeof import("../intelligence/rule-evaluator.js").evaluateRules
    | undefined;
  if (localGraph) {
    try {
      const ruleEvalModule = await import("../intelligence/rule-evaluator.js");
      ruleEvaluator = ruleEvalModule.evaluateRules;
    } catch {
      // Rule evaluator not available — check_rules will be unavailable
    }
  }

  // In PARSE mode, create a minimal graph stub that delegates to ParseModeIndex
  const graphForRouter =
    localGraph ?? (await createParseGraphStub(parseIndex!));

  const { QueryRouter } = await import("../intelligence/query-router.js");
  const router = new QueryRouter(graphForRouter, ruleEvaluator);
  router.setMode(proxyMode, proxyModeReason);
  // Layer 7: Wire event bus for dashboard SSE transport
  const { eventBus } = await import("../server/event-bus.js");
  router.setEventBus(eventBus);
  // Sprint 2: Wire session events for value counter (Task 2.7)
  router.setSessionEvents(stats.events);

  // Sprint S1: Wire output compression & quality loop
  const { createSessionDedup } = await import("./session-dedup.js");
  const { createCompressionQualityMonitor } = await import(
    "./compression-quality-monitor.js"
  );
  const sessionDedup = createSessionDedup();
  const compressionMonitor = createCompressionQualityMonitor();
  router.setSessionDedup(sessionDedup);
  router.setCompressionMonitor(compressionMonitor);

  // Sprint S2: Wire session health monitor & exploration cost accumulator
  const { createSessionHealthMonitor } = await import(
    "../intelligence/session-health-monitor.js"
  );
  const { createExplorationAccumulator } = await import(
    "../intelligence/exploration-cost.js"
  );
  const healthMonitor = createSessionHealthMonitor();
  const explorationAccumulator = createExplorationAccumulator();
  router.setHealthMonitor(healthMonitor);
  router.setExplorationAccumulator(explorationAccumulator);

  // Sprint S3: Wire context rot detector
  const { createContextRotDetector } = await import(
    "./context-rot-detector.js"
  );
  const contextRotDetector = createContextRotDetector();
  router.setContextRotDetector(contextRotDetector);

  // Sprint S4: Wire token accounting & visibility
  const { createTokenCounter } = await import("./token-counter.js");
  const { createEfficiencyTracker } = await import("./efficiency-tracker.js");
  const tokenCounter = createTokenCounter({ emitEveryN: 5 });
  // EfficiencyTracker created with placeholder — upgraded to TokenFlow-backed after tokenFlowWriter init
  let efficiencyTracker = createEfficiencyTracker();
  router.setTokenCounter(tokenCounter);
  router.setEfficiencyTracker(efficiencyTracker);

  // Sprint 1.2: Wire fact store for _context injection
  const proxyFactStore = await getProxyFactStore(join(process.cwd(), ".unerr"));
  if (proxyFactStore) {
    router.setFactStore(proxyFactStore);
  }

  // Sprint 2: Health info wired in deferred init (Task 6.3)

  // ── Sprint S7: Persistent Context Wiring ────────────────────��───────

  // S7.2 + S7.3 + S7.4: Session resume with causal-bridge enrichment
  if (previousSession) {
    try {
      const { generateSessionResume } = await import(
        "../proxy/session-resume.js"
      );
      const { ShadowLedger: ResumeLedger } = await import(
        "../tracking/shadow-ledger.js"
      );
      const resumeLedger = new ResumeLedger(join(process.cwd(), ".unerr"));
      const ledgerEntries = resumeLedger.getRecentEntries(50);
      const resumeCtx = generateSessionResume(ledgerEntries);
      if (resumeCtx) {
        router.setSessionResumeContext({
          summary: resumeCtx.summary,
          filesModified: resumeCtx.filesModified,
          incompleteEntities: resumeCtx.incompleteEntities,
        });
        log.info(
          `Session resume context prepared (${resumeCtx.filesModified.length} files, ${resumeCtx.incompleteEntities.length} incomplete)`
        );
      }
    } catch {
      // Non-critical — session resume enrichment is best-effort
    }
  }

  // S7.5 + S7.8: Durability scorer — compute scores from ledger history
  try {
    const { createDurabilityScorer } = await import(
      "../intelligence/durability-scorer.js"
    );
    const durabilityScorer = createDurabilityScorer();
    const { ShadowLedger: DurLedger } = await import(
      "../tracking/shadow-ledger.js"
    );
    const durLedger = new DurLedger(join(process.cwd(), ".unerr"));
    const durEntries = durLedger.getRecentEntries(200);
    if (durEntries.length > 0) {
      durabilityScorer.computeScores(durEntries);
      router.setDurabilityScorer(durabilityScorer);
      const unstable = durabilityScorer.getTopUnstable(5);
      if (unstable.length > 0) {
        log.info(
          `Durability scorer active (${unstable.length} fragile entities tracked)`
        );
      }
    }
  } catch {
    // Non-critical — durability scoring is best-effort
  }

  // ── Sprint S8: Value Surfacing ──────────────────────────────────────
  // S8.1 + S8.5: Wire value guard (fires once per session when savings exceed threshold)
  const { createValueGuard } = await import("../config/value-surfacing.js");
  const valueGuard = createValueGuard();
  router.setValueGuard(valueGuard);

  // S7.6: Negative knowledge — load anti-patterns for injection
  try {
    const { detectInstableEntities } = await import(
      "../intelligence/negative-knowledge.js"
    );
    const { ShadowLedger: NkLedger } = await import(
      "../tracking/shadow-ledger.js"
    );
    const nkLedger = new NkLedger(join(process.cwd(), ".unerr"));
    const nkEntries = nkLedger.getRecentEntries(200);
    if (nkEntries.length > 0) {
      const antiPatterns = detectInstableEntities(nkEntries);
      if (antiPatterns.length > 0) {
        router.setAntiPatterns(
          antiPatterns.map((p) => ({
            entityKey: p.entityKey,
            pattern: p.pattern,
            reason: p.reason,
          }))
        );
        log.info(
          `Negative knowledge loaded (${antiPatterns.length} anti-patterns)`
        );
      }
    }
  } catch {
    // Non-critical — negative knowledge is best-effort
  }

  // ── Q.1: Causal Bridge — entity history from prompt→commit→survival ──
  try {
    const { CausalBridge } = await import("../tracking/causal-bridge.js");
    const causalBridge = new CausalBridge(
      join(process.cwd(), ".unerr"),
      process.cwd()
    );
    router.setCausalBridge(causalBridge);
    log.info("Causal bridge wired (entity interaction history active)");
  } catch {
    // Non-critical — causal bridge is best-effort
  }

  // ── Q.3: Convention Learner — cross-session correction learning ──
  try {
    const { learnConventions } = await import(
      "../intelligence/convention-learner.js"
    );
    const { ShadowLedger: ConvLedger } = await import(
      "../tracking/shadow-ledger.js"
    );
    const convLedger = new ConvLedger(join(process.cwd(), ".unerr"));
    const convEntries = convLedger.getRecentEntries(100);
    if (convEntries.length > 0) {
      const learned = learnConventions(convEntries);
      if (learned.length > 0) {
        router.setLearnedConventions(
          learned.map((c) => ({
            id: c.id,
            name: c.name,
            pattern: c.pattern,
            confidence: c.confidence,
          }))
        );
        log.info(
          `Convention learner: ${learned.length} patterns detected from corrections`
        );
      }
    }
  } catch {
    // Non-critical — convention learning is best-effort
  }

  // ── Q.1: Prompt Durability Profiles — strategy recommendations ──
  try {
    const { computePromptDurabilityProfiles } = await import(
      "../tracking/prompt-durability.js"
    );
    const { ShadowLedger: DurProfLedger } = await import(
      "../tracking/shadow-ledger.js"
    );
    const durProfLedger = new DurProfLedger(join(process.cwd(), ".unerr"));
    const durProfEntries = durProfLedger.getRecentEntries(200);
    if (durProfEntries.length > 0) {
      const profiles = computePromptDurabilityProfiles(durProfEntries as any);
      if (profiles.length > 0) {
        router.setPromptDurabilityProfiles(
          profiles.map((p) => ({
            actionType: p.actionType,
            targetRisk: p.targetRisk,
            durability: p.durability,
            recommendation: p.recommendation,
          }))
        );
        log.info(`Prompt durability: ${profiles.length} profiles computed`);
      }
    }
  } catch {
    // Non-critical — prompt durability is best-effort
  }

  // ── Cross-Session Context Ledger — prevents re-delivering context ──
  try {
    const { createContextLedger } = await import(
      "../tracking/context-ledger.js"
    );
    const contextLedger = createContextLedger(join(process.cwd(), ".unerr"));
    contextLedger.load();
    contextLedger.prune();
    router.setContextLedger(contextLedger);
    log.info(
      `Context ledger loaded (${contextLedger.getDeliveredCount()} prior deliveries)`
    );
  } catch {
    // Non-critical — cross-session dedup is best-effort
  }

  // ── Intent Token Tracker — groups tool calls by intent ──
  try {
    const { createIntentTokenTracker } = await import(
      "../tracking/intent-token-tracker.js"
    );
    const { eventBus: intentEventBus } = await import("../server/event-bus.js");
    const intentTracker = createIntentTokenTracker({
      dashboardSink: (payload) => {
        intentEventBus.emit("intent", payload);
      },
    });
    router.setIntentTracker(intentTracker);
    log.info("Intent token tracker active");
  } catch {
    // Non-critical — intent tracking is best-effort
  }

  // ── Step 5c (L12.4): Skill Self-Healing on Boot ─────────────────
  // Check IDE skill directory — reinstall from cascade if empty.
  try {
    const { detectIde } = await import("../utils/detect.js");
    const { ensureSkillsPresent } = await import("../skills/resolver.js");
    const ide = await detectIde(process.cwd());
    const skillsInstalled = await ensureSkillsPresent({
      ide,
      cwd: process.cwd(),
    });
    if (skillsInstalled > 0) {
      log.info(`Self-healed ${skillsInstalled} skills for ${ide}`);
    }
  } catch (err: unknown) {
    log.warn(
      `Skill self-healing failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Step 7: MCP Server (stdio) ───────────────────────────────────

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const server = new Server(
    { name: "unerr-local", version: "0.1.3" },
    { capabilities: { tools: {} } }
  );

  // Tool definitions imported from shared tool-definitions.ts (single source of truth)
  const toolDefinitions = [...TOOL_DEFINITIONS];

  // S7: Tool usage tracker for semantic cluster reordering
  const toolUsageTracker = new ToolUsageTracker();

  // Sprint 9.7: Dynamic tool injection — inject block rules into tool descriptions
  // Sprint 11: Dynamic deep dive tool loading based on project state
  type ToolDef = {
    name: string;
    description: string;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  let cachedInjectedTools: ToolDef[] | null = null;
  let cachedBlockRuleKeys: Set<string> = new Set();
  let cachedDeepDiveState = "none";

  /**
   * Boundary tool-call validator. Looks up the tool's schema (base +
   * deep-dive) and runs alias normalization + required-field enforcement
   * via arg-validator. Returns a structured failure on missing/invalid
   * args; null on success. Must be invoked from BOTH stdio and UDS
   * dispatch paths (see comment at the stdio handler).
   */
  const runBoundaryValidation = (
    toolName: string,
    toolArgs: Record<string, unknown>
  ): { error: string; required: string[]; details: string } | null => {
    let def: ToolDef | undefined = toolDefinitions.find(
      (t) => t.name === toolName
    );
    if (!def) {
      try {
        // biome-ignore format: typeof import() must stay on one line for TS parsing
        const { DEEP_DIVE_TOOL_DEFINITIONS } = require("../intelligence/deep-dive-tools.js") as typeof import("../intelligence/deep-dive-tools.js");
        def = (DEEP_DIVE_TOOL_DEFINITIONS as readonly ToolDef[]).find(
          (t) => t.name === toolName
        );
      } catch {
        /* deep-dive not available — base validation is enough */
      }
    }
    if (!def) return null;
    return aliasAndValidate(def, toolArgs);
  };

  async function getInjectedTools(): Promise<ToolDef[]> {
    if (!localGraph) return toolDefinitions;
    try {
      // biome-ignore format: typeof import() must stay on one line for TS parsing
      const { injectRuleContext, needsRefresh, getBlockRules } = require("../intelligence/tool-injector.js") as typeof import("../intelligence/tool-injector.js");
      // biome-ignore format: typeof import() must stay on one line for TS parsing
      const { DEEP_DIVE_TOOL_DEFINITIONS, NAVIGATION_TOOL_NAMES } = require("../intelligence/deep-dive-tools.js") as typeof import("../intelligence/deep-dive-tools.js");

      const currentDeepDiveState = await localGraph.getDeepDiveProjectState();
      const deepDiveStateChanged = currentDeepDiveState !== cachedDeepDiveState;

      if (
        cachedInjectedTools &&
        !(await needsRefresh(localGraph, cachedBlockRuleKeys)) &&
        !deepDiveStateChanged
      ) {
        return cachedInjectedTools;
      }

      // Build base tools + conditionally include deep dive tools
      let baseTools: ToolDef[] = [...toolDefinitions];

      if (currentDeepDiveState === "approved") {
        // Post-approval: 4 navigation tools
        const navTools = (
          DEEP_DIVE_TOOL_DEFINITIONS as readonly ToolDef[]
        ).filter((t) =>
          (NAVIGATION_TOOL_NAMES as readonly string[]).includes(t.name)
        );
        baseTools = [...baseTools, ...navTools];
      } else if (currentDeepDiveState === "building") {
        // Implementation phase: all 8 tools
        baseTools = [
          ...baseTools,
          ...(DEEP_DIVE_TOOL_DEFINITIONS as readonly ToolDef[]),
        ];
      }
      // "none" and "pre_approval": no deep dive tools

      cachedInjectedTools = (await injectRuleContext(
        baseTools,
        localGraph
      )) as ToolDef[];
      cachedBlockRuleKeys = new Set(
        (await getBlockRules(localGraph)).map((r: { key: string }) => r.key)
      );
      cachedDeepDiveState = currentDeepDiveState;
      return cachedInjectedTools;
    } catch {
      return toolDefinitions;
    }
  }

  // S7: Reorder tools by semantic cluster priority based on recent usage
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: reorderToolsByCluster(await getInjectedTools(), toolUsageTracker),
  }));

  // ── Step 7a: Shadow Ledger + Intent Correlator ─────────────────

  const { ShadowLedger } = await import("../tracking/shadow-ledger.js");
  const { IntentCorrelator } = await import("../tracking/intent-correlator.js");
  const unerrDirForLedger = join(process.cwd(), ".unerr");
  const shadowLedger = new ShadowLedger(unerrDirForLedger);
  const intentCorrelator = new IntentCorrelator(unerrDirForLedger);

  log.info(
    `Shadow ledger active (session ${shadowLedger.getSessionId().slice(0, 8)})`
  );

  // ST-1c: Timeline subsystem (kill-switch UNERR_TIMELINE_V2=0). Additive,
  // never touches existing facts.db / graph.db code paths.
  const { startTimelineBootstrap } = await import(
    "../timeline/timeline-bootstrap.js"
  );
  const timelineHandle = await startTimelineBootstrap({
    projectRoot: process.cwd(),
    ledger: shadowLedger,
    log: (level, msg) =>
      level === "warn" ? log.warn(msg) : log.info(`[timeline] ${msg}`),
    // UX-2: resolve agent name lazily — `agentNameByClient` is populated later
    // by the UDS initialize handler, and `server.getClientVersion()` resolves
    // once the stdio client completes its MCP handshake.
    getAgentName: () => server.getClientVersion?.()?.name ?? undefined,
  });

  // ST-4: Nightly intent-stitch job (runs at idle, never blocking). Additive,
  // separate from the existing pruneDecayed cron on facts.db.
  let timelineIntentStitchInterval: NodeJS.Timeout | null = null;
  let timelineSignalPruneInterval: NodeJS.Timeout | null = null;
  if (timelineHandle) {
    const { runIntentStitch } = await import("../timeline/intent-detector.js");
    const { pruneStaleSignals } = await import(
      "../timeline/signal-reinforcer.js"
    );
    const stitchPeriodMs = 60 * 60_000; // hourly is fine; nightly would skip many windows
    timelineIntentStitchInterval = setInterval(() => {
      runIntentStitch(timelineHandle.store).catch((err: unknown) => {
        log.warn(
          `Timeline intent-stitch failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, stitchPeriodMs);
    // Best-effort initial run so first session has an intent attached.
    runIntentStitch(timelineHandle.store).catch(() => {});

    // ST-5: Hourly signal prune. Operates only on timeline.db.derived_signals;
    // Layer 9 pruneDecayed on facts.db is untouched.
    const prunePeriodMs = 60 * 60_000;
    timelineSignalPruneInterval = setInterval(() => {
      pruneStaleSignals(timelineHandle.store).catch((err: unknown) => {
        log.warn(
          `Timeline signal prune failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, prunePeriodMs);
  }

  // ST-6: Daily shadow-ledger archive. Splits shadow.jsonl into
  // recent (<7 days) + gzipped archive. Pure I/O on the ledger directory;
  // no other subsystem touched.
  const { archiveShadowLedger } = await import(
    "../tracking/ledger-archiver.js"
  );
  const archiveIntervalMs = 24 * 60 * 60_000;
  const ledgerArchiveInterval = setInterval(() => {
    try {
      const r = archiveShadowLedger(unerrDirForLedger);
      if (r.archived > 0) {
        log.info(
          `Ledger archive: rotated ${r.archived} entries → ${r.archivePath ?? "?"}`
        );
      }
    } catch (err: unknown) {
      log.warn(
        `Ledger archive failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, archiveIntervalMs);
  // Fire once on boot so existing >7d entries get archived without waiting.
  try {
    archiveShadowLedger(unerrDirForLedger);
  } catch {
    /* best-effort on boot */
  }

  // Sprint 4: Initialize narrative capture (daemon mode)
  let narrativeCapture:
    | import("../intelligence/session-narrative.js").SessionNarrativeCapture
    | null = null;
  if (proxyFactStore) {
    try {
      const { SessionNarrativeCapture } = await import(
        "../intelligence/session-narrative.js"
      );
      narrativeCapture = new SessionNarrativeCapture(
        proxyFactStore,
        shadowLedger
      );
    } catch {
      // Non-critical
    }
  }

  // Persistent rotation store — facts.db `signal_shows` relation. Survives
  // restart and coordinates show-counts across parallel `unerr --mcp` sessions
  // in the same repo (per-session rows so writes never contend).
  if (proxyFactStore) {
    try {
      const { SignalShowStore } = await import(
        "../intelligence/signal-show-store.js"
      );
      proxyShowStore = new SignalShowStore(
        proxyFactStore.getDb(),
        shadowLedger.getSessionId()
      );
      await proxyShowStore.start();
      router.setSignalShowStore(proxyShowStore);
      process.once("beforeExit", () => {
        proxyShowStore?.close().catch(() => {});
      });
    } catch (err) {
      log.warn(
        `Signal show store init failed (rotation degrades to in-memory): ${err instanceof Error ? err.message : "unknown"}`
      );
    }
  }

  // Sprint 5: Pattern analysis call counter (periodic trigger every 20 calls)
  let patternAnalysisCallCount = 0;

  // ── Layer 10: Token Flow Writer — unified savings attribution ────
  const { TokenFlowWriter } = await import("../tracking/token-flow.js");
  const tokenFlowWriter = new TokenFlowWriter(
    unerrDirForLedger,
    shadowLedger.getSessionId()
  );
  process.env.UNERR_SESSION_ID = shadowLedger.getSessionId();
  // RC3 fix: Write session ID to file for exec processes
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(unerrDirForLedger, "state", "session.id"),
      shadowLedger.getSessionId(),
      "utf-8"
    );
  } catch {
    /* best effort */
  }
  router.setTokenFlow(tokenFlowWriter);
  efficiencyTracker = createEfficiencyTracker(tokenFlowWriter);
  router.setEfficiencyTracker(efficiencyTracker);

  // Persistent memory effectiveness tracker — emits verdict events when
  // fact/convention/resume injections close their observation window.
  const { PersistenceEffectivenessTracker } = await import(
    "../tracking/persistence-effectiveness.js"
  );
  const effectivenessTracker = new PersistenceEffectivenessTracker(
    tokenFlowWriter
  );
  router.setEffectivenessTracker(effectivenessTracker);
  // Close windows on every turn boundary so verdicts land near-real-time.
  shadowLedger.getTurnSegmenter().onTurnClose(() => {
    effectivenessTracker.closeWindow(router.sessionContext.getToolCallCount());
  });

  // ── Sprint 10: Working Snapshots, Circuit Breaker, Quality Signals ──

  const { WorkingSnapshotStore } = await import(
    "../tracking/working-snapshots.js"
  );
  const workingSnapshotStore = new WorkingSnapshotStore(unerrDirForLedger);

  const { LedgerCircuitBreaker } = await import(
    "../tracking/circuit-breaker.js"
  );
  const circuitBreaker = new LedgerCircuitBreaker();
  // S9.1: Wire circuit breaker into query router for loop detection
  router.setCircuitBreaker(circuitBreaker);

  const { QualitySignalTracker } = await import(
    "../tracking/quality-signals.js"
  );
  const qualitySignalTracker = new QualitySignalTracker(unerrDirForLedger);

  let resumeMetaEmitted = false;

  // ── Layer 4: Behavior Engine (BA-1 + BA-2 + BA-3) ──────────────

  const { BehaviorDispatcher } = await import("../behaviors/framework.js");
  const { LoopCircuitBreaker } = await import("../behaviors/loop-breaker.js");
  const { SessionContinuityBehavior } = await import(
    "../behaviors/session-continuity.js"
  );
  const { CascadeConsistencyGuard } = await import(
    "../behaviors/cascade-guard.js"
  );
  const { IncompleteWorkDetector } = await import(
    "../behaviors/incomplete-work.js"
  );
  const { ConventionDriftPrevention } = await import(
    "../behaviors/convention-drift.js"
  );
  const { AutoDocBehavior } = await import("../behaviors/auto-doc.js");
  const { ArchitectureBoundaryGuard } = await import(
    "../behaviors/architecture-guard.js"
  );
  const { ChangeNarrativeBehavior } = await import(
    "../behaviors/change-narrative.js"
  );

  const behaviorDispatcher = new BehaviorDispatcher();

  const loopBreaker = new LoopCircuitBreaker();
  behaviorDispatcher.register(loopBreaker);

  const sessionContinuity = new SessionContinuityBehavior();
  sessionContinuity.attachLedger(shadowLedger);
  behaviorDispatcher.register(sessionContinuity);

  const cascadeGuard = new CascadeConsistencyGuard();
  if (localGraph) cascadeGuard.attachGraph(localGraph);
  behaviorDispatcher.register(cascadeGuard);

  const incompleteWork = new IncompleteWorkDetector();
  incompleteWork.attachLedger(shadowLedger);
  incompleteWork.attachCascadeGuard(cascadeGuard);
  incompleteWork.setUnerrDir(unerrDirForLedger);
  if (localGraph) incompleteWork.attachGraph(localGraph);
  behaviorDispatcher.register(incompleteWork);

  const conventionDrift = new ConventionDriftPrevention();
  if (localGraph) conventionDrift.attachGraph(localGraph);
  behaviorDispatcher.register(conventionDrift);

  const autoDoc = new AutoDocBehavior();
  if (localGraph) autoDoc.attachGraph(localGraph);
  behaviorDispatcher.register(autoDoc);

  const architectureGuard = new ArchitectureBoundaryGuard();
  if (localGraph) architectureGuard.attachGraph(localGraph);
  behaviorDispatcher.register(architectureGuard);

  const changeNarrative = new ChangeNarrativeBehavior();
  changeNarrative.attachBehaviors({
    cascadeGuard,
    conventionDrift,
    incompleteWork,
    architectureGuard,
    loopBreaker,
    autoDoc,
  });
  behaviorDispatcher.register(changeNarrative);

  log.info(
    `Behavior engine active (${behaviorDispatcher.getRegisteredBehaviors().length} behaviors registered)`
  );

  // Task 6.3: Deferred initialization tracking
  let deferredInitComplete = false;
  let branchContext:
    | import("../tracking/branch-context.js").BranchContext
    | null = null;

  // ══════════════════════════════════════════════════════════════════
  // Stdio tools/call handler (primary MCP client connected directly)
  //
  // IMPORTANT: Any tool intercepted here (before router.execute()) MUST
  // also be intercepted in the UDS handler below (transportMux.setHandler).
  // Bridged IDE clients via `unerr --mcp` hit the UDS handler, not this one.
  // Forgetting to mirror dispatch causes "Unknown tool" errors for bridged clients.
  // ══════════════════════════════════════════════════════════════════
  server.setRequestHandler(
    CallToolRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (request: any) => {
      const { name, arguments: args = {} } = request.params;

      // ── Boundary validation: alias normalization + required-field check ──
      // Centralized in arg-validator so every tool with a schema-level
      // `required: [...]` is enforced uniformly. Catches the silent-failure
      // pattern where missing/aliased params reached handlers, ran queries
      // with undefined filters, and returned empty results that agents
      // mistook for "graph has no data" — driving drift to grep fallback.
      const validationFailure = runBoundaryValidation(name, args);
      if (validationFailure) {
        // Boundary failures (missing required args, type mismatches) are real
        // errors — flag with isError:true so MCP clients surface them in the
        // agent conversation instead of treating the message as a normal
        // tool result body.
        process.stderr.write(
          `[unerr] tools/call validation failed for ${name}: ${JSON.stringify(validationFailure)}\n`
        );
        return {
          content: [{ type: "text", text: JSON.stringify(validationFailure) }],
          isError: true,
        };
      }

      // S7: Track tool usage for semantic cluster reordering
      toolUsageTracker.record(name);

      // ── Layer 4: Pre-tool-use behavioral hooks ──
      const behaviorCtx = {
        toolName: name,
        args,
        sessionId: shadowLedger.getSessionId(),
        entityKey: (args.key as string) ?? (args.entity as string) ?? undefined,
        filePath:
          (args.path as string) ??
          (args.file_path as string) ??
          (args.file as string) ??
          undefined,
      };
      const preOutput = await behaviorDispatcher.firePreToolUse(behaviorCtx);
      if (preOutput?.halt) {
        // Layer 10: Record behavior automation savings (prevented a full tool call)
        if (tokenFlowWriter) {
          const haltContent = preOutput._context
            ? JSON.stringify(preOutput._context)
            : "";
          const avoidedTokens = 3200;
          const deliveredTokens = Math.ceil(haltContent.length / 4);
          tokenFlowWriter.record({
            session_id: tokenFlowWriter.sessionId,
            turn: stats.toolCallsLocal + 1,
            mechanism: "behavior_automation",
            tool: name,
            tokens_without: avoidedTokens,
            tokens_with: deliveredTokens,
            tokens_saved: Math.max(0, avoidedTokens - deliveredTokens),
            detail: { behavior: preOutput.behaviorId, action: "halted" },
          });
        }

        return {
          content: [
            {
              type: "text",
              text: stringifyMcpToolJson(preOutput._context),
            },
          ],
          _meta: { format: "json", ...(preOutput._meta ?? {}) },
          ...(preOutput._context ? { _context: preOutput._context } : {}),
        };
      }

      // Shadow ledger tools disabled — not exposed in tool definitions
      // (unerr_mark_working, unerr_revert_to_working_state, unerr_get_timeline handlers removed)

      // ── ST-2: Session-narrative marker tools ──
      {
        const { isMarkerTool, handleMarkerCall } = await import(
          "../tools/intelligence/timeline-markers.js"
        );
        if (isMarkerTool(name)) {
          if (!timelineHandle) {
            process.stderr.write(
              `[unerr] ${name} called but timeline subsystem is disabled\n`
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error:
                      "marker tools require timeline subsystem (UNERR_TIMELINE_V2!=0)",
                  }),
                },
              ],
              isError: true,
            };
          }
          let branchVal = "main";
          let headShaVal = "";
          try {
            const { getCurrentBranch, getHeadSha } = await import(
              "../utils/git.js"
            );
            branchVal = (await getCurrentBranch(process.cwd())) ?? branchVal;
            headShaVal = (await getHeadSha(process.cwd())) ?? "";
          } catch {
            /* defaults */
          }
          return handleMarkerCall(name, args as Record<string, unknown>, {
            ledger: shadowLedger,
            store: timelineHandle.store,
            branch: branchVal,
            headSha: headShaVal,
          });
        }
      }

      // ── Layer 9: record_fact + recall_facts ──
      if (name === "record_fact" || name === "recall_facts") {
        const factResult =
          name === "record_fact"
            ? await handleRecordFactProxy(
                args,
                unerrDirForLedger,
                shadowLedger,
                {
                  tracker: effectivenessTracker,
                  turn: router.sessionContext.getToolCallCount(),
                }
              )
            : await handleRecallFactsProxy(args, unerrDirForLedger, {
                tracker: effectivenessTracker,
                turn: router.sessionContext.getToolCallCount(),
              });
        const { applyWireCap: applyWireCapFact } = await import(
          "./wire-cap.js"
        );
        const rawText = factResult.content?.[0]?.text;
        let parsed: unknown = null;
        if (rawText) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            /* non-JSON, skip cap */
          }
        }
        if (parsed) {
          const { body: cappedBody, pageHint } = applyWireCapFact(
            name,
            parsed,
            args
          );
          const pageBlock = pageHint ? `${pageHint}\n\n` : "";
          // Forward isError so error responses from the fact handler reach
          // the agent as failed tool calls, not as opaque JSON bodies.
          return {
            content: [
              {
                type: "text",
                text: pageBlock + stringifyMcpToolJson(cappedBody),
              },
            ],
            ...(factResult.isError ? { isError: true } : {}),
          };
        }
        return factResult;
      }

      // Sprint 11: Deep Dive MCP tools — handle locally
      if (localGraph) {
        const { handleDeepDiveTool } = await import(
          "../intelligence/deep-dive-tools.js"
        );
        const deepDiveResult = await handleDeepDiveTool(name, args, localGraph);
        if (deepDiveResult) {
          recordToolCall(stats);
          recordLatency(stats.latency, 0);
          pidLock.recordToolCall();
          if (stats.localMode) recordGraphQuery(stats.localMode, name);
          const branch = branchContext?.currentBranch ?? "unknown";
          const headSha = branchContext?.headSha ?? "";
          shadowLedger.record(
            name,
            args,
            { tool: name, source: "local" },
            branch,
            headSha
          );
          return deepDiveResult;
        }
      }

      // MCP tools: Layer 6 wire formats (columnar / json) are applied inside QueryRouter.execute.
      // Wrap in try/catch so any throw lands as isError:true on the wire
      // instead of the SDK's generic JSON-RPC error, which some clients
      // surface less prominently than a tool-level error.
      let result: Awaited<ReturnType<typeof router.execute>>;
      try {
        result = await router.execute(name, args);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[unerr] router.execute(${name}) threw: ${errMsg}\n`
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: errMsg, tool: name }),
            },
          ],
          isError: true,
        };
      }

      // Track session stats + latency
      recordToolCall(stats);
      recordLatency(stats.latency, result._meta.latency_ms);
      pidLock.recordToolCall();
      // Local Mode: track per-tool graph query counts
      if (stats.localMode && result._meta.source === "local") {
        recordGraphQuery(stats.localMode, name);
      }
      // Local Mode: track blast radius computations
      if (stats.localMode && result._meta.entity_risk) {
        recordBlastRadius(stats.localMode);
      }
      // Local Mode: track community context injections
      if (stats.localMode && result._meta.community) {
        recordCommunityContext(stats.localMode);
      }
      // Local Mode: accumulate latency advantage vs remote baseline (200ms baseline)
      if (stats.localMode && result._meta.source === "local") {
        recordLatencyAdvantage(
          stats.localMode,
          Math.max(0, 200 - result._meta.latency_ms)
        );
      }
      if (result._meta.entity_risk?.risk_level === "high") {
        recordRiskWarning(stats);
        // Track chokepoint warning when blast radius is high
        if ((result._meta.entity_risk?.fan_in ?? 0) > 10) {
          recordChokepointWarning(stats);
        }
      }
      // Track dead code references (fan_in=0 entities)
      if (result._meta.entity_risk?.fan_in === 0) {
        recordDeadCodeReference(stats);
      }

      // Track convention violations from check_rules results
      if (name === "check_rules" && result.content != null) {
        const checkResult = result.content as {
          violations?: Array<{ ruleKey: string; autoFixed?: boolean }>;
        };
        const viols = checkResult.violations;
        if (viols && viols.length > 0) {
          void import("../server/event-bus.js").then(({ eventBus }) => {
            eventBus.emit("violation", {
              source: "check_rules",
              count: viols.length,
              rules: viols.slice(0, 24).map((v) => v.ruleKey),
            });
          });
          for (let i = 0; i < viols.length; i++) {
            recordViolation(stats);
          }
        }
      }

      // Track circular dependency detection from import analysis
      if (name === "get_imports" && result.content != null) {
        const imports = result.content as Array<{ imported_file: string }>;
        if (Array.isArray(imports)) {
          // Detect circular: file A imports B and B imports A
          const importedFiles = new Set(imports.map((e) => e.imported_file));
          const filePath = args?.file_path as string | undefined;
          if (filePath) {
            // Check if any imported file also imports this file
            for (const target of importedFiles) {
              if (target === filePath) {
                recordCircularDep(stats);
                break;
              }
            }
          }
        }
      }

      // Track signature preservation when drift shows modified entities
      if (result._meta.drift?.entityStatus === "modified") {
        recordSignaturePreservation(stats);
      }

      // Record in Shadow Ledger
      const branch = branchContext?.currentBranch ?? "unknown";
      const headSha = branchContext?.headSha ?? "";
      const resultSummary: Record<string, unknown> = {
        source: result._meta.source,
        found: result.content != null,
      };
      if (Array.isArray(result.content)) {
        resultSummary.count = result.content.length;
      }
      shadowLedger.record(name, args, resultSummary, branch, headSha);

      // Sprint 4: Capture edit narratives as episodic facts
      const NARRATIVE_EDIT_TOOLS = new Set([
        "file_write",
        "write_file",
        "edit_file",
        "str_replace_editor",
        "Write",
        "Edit",
      ]);
      if (narrativeCapture && NARRATIVE_EDIT_TOOLS.has(name)) {
        const recentEntries = shadowLedger.getRecentEntries(10);
        const lastEntry = recentEntries[recentEntries.length - 1];
        if (lastEntry) {
          setImmediate(() =>
            narrativeCapture?.captureEditNarrative(lastEntry).catch(() => {})
          );
        }
      }

      // Sprint 5: Periodic pattern analysis (every 20 tool calls)
      patternAnalysisCallCount++;
      if (
        patternAnalysisCallCount % 20 === 0 &&
        proxyFactStore &&
        shadowLedger
      ) {
        setImmediate(async () => {
          try {
            const { analyzeSessionPatterns } = await import(
              "../intelligence/session-pattern-analyzer.js"
            );
            const entries = shadowLedger?.getRecentEntries(20);
            await analyzeSessionPatterns({
              ledgerEntries: entries,
              factStore: proxyFactStore!,
              sessionId: shadowLedger?.getSessionId(),
            });
          } catch {
            /* non-critical */
          }
        });
      }

      // S7.1: Auto-snapshot trigger evaluation (post-tool-call)
      try {
        const { shouldAutoSnapshot } = await import(
          "../tracking/auto-snapshot-triggers.js"
        );
        const fanInThreshold = result._meta.entity_risk?.fan_in ?? 0;
        if (
          shouldAutoSnapshot(
            name,
            args,
            resultSummary,
            fanInThreshold > 8 ? fanInThreshold : undefined
          )
        ) {
          const snapshotBranch = branchContext?.currentBranch ?? "unknown";
          const snapshotSha = branchContext?.headSha ?? "";
          workingSnapshotStore.create({
            commitSha: snapshotSha,
            reason: `auto: ${name}`,
            branch: snapshotBranch,
            timelineBranch: workingSnapshotStore.getTimelineBranch(),
            sessionId: shadowLedger.getSessionId(),
          });
        }
      } catch {
        // Auto-snapshot is non-critical
      }

      // Task 6.3: Flag partial initialization on early responses
      const meta: Record<string, unknown> = { ...result._meta };
      if (!deferredInitComplete) {
        meta.initialization = "partial";
      }

      // Inject session_resumed on first MCP response after resume
      if (stats.isResumedSession && !resumeMetaEmitted) {
        meta.session_resumed = true;
        if (stats.previousSession) {
          const prev = stats.previousSession;
          meta.previous_session = {
            tool_calls: prev.toolCallsLocal,
            duration_minutes: prev.durationMinutes,
          };
        }
        effectivenessTracker.recordSignalFired({
          kind: "resume_injected",
          signal_id: shadowLedger.getSessionId(),
          entity_key: null,
          turn: router.sessionContext.getToolCallCount(),
        });
        resumeMetaEmitted = true;
      }

      // ── Layer 4: Post-tool-use behavioral hooks ──
      const postCtx = {
        ...behaviorCtx,
        result: result as unknown as Record<string, unknown>,
      };
      const postOutput = await behaviorDispatcher.firePostToolUse(postCtx);
      let contextPayload = result._context ?? {};
      if (postOutput?._context) {
        contextPayload = { ...contextPayload, ...postOutput._context };
      }
      if (postOutput?._meta) {
        Object.assign(meta, postOutput._meta);
      }

      // Tier-3: clients filter `_meta`/`_context`. Migrate anti-drift signals
      // into body text. Wire-cap already ran inside QueryRouter (pre-format)
      // and stashed page hint on meta._unerr_page_hint — consume it here.
      const { buildSignalPrefix } = await import("./response-envelope.js");
      const entityKey =
        ((args as Record<string, unknown>).entity_key as string | undefined) ??
        ((args as Record<string, unknown>).entity as string | undefined) ??
        ((args as Record<string, unknown>).key as string | undefined) ??
        ((args as Record<string, unknown>).name as string | undefined) ??
        ((args as Record<string, unknown>).file_path as string | undefined) ??
        null;
      const signalFooter = buildSignalPrefix(
        meta,
        contextPayload as unknown as Record<string, unknown>,
        entityKey
      );
      const pageHint = (meta as Record<string, unknown>)._unerr_page_hint as
        | string
        | undefined;
      const bodyText =
        typeof result.content === "string"
          ? result.content
          : stringifyMcpToolJson(result.content);
      const pageBlock = pageHint ? `\n${pageHint}` : "";
      const footerBlock = signalFooter ? `\n${signalFooter.trimEnd()}` : "";
      const bodyEnd = bodyText.endsWith("\n") ? "" : "\n";
      // Final assembly: data → page-hint → signal footer (signals trail).
      const finalText = bodyText + bodyEnd + pageBlock + footerBlock;

      return {
        content: [{ type: "text", text: finalText }],
      };
    }) as any
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  lifecycle.send({ type: "INDEX_COMPLETE" });
  lifecycle.send({ type: "MCP_READY" });

  // ── Step 7a-2: UDS Transport for Multi-Client (Task 7.2) ──────

  const { TransportMux } = await import("./transport-mux.js");
  const sockPath = join(stateDir, "proxy.sock");
  const transportMux = new TransportMux(sockPath);

  /** Map clientId → agent name (captured from MCP initialize handshake) */
  const agentNameByClient = new Map<string, string>();

  // Sprint 10.5: Add custom HTTP handler for /commit-context (git trailer injection)
  transportMux.setCustomHttpHandler("/commit-context", (_url) => {
    // biome-ignore format: keep import() type on one line for TS compat
    const { getCommitTrailers } = require("../tracking/git-trailers.js") as typeof import("../tracking/git-trailers.js");
    const branch = branchContext?.currentBranch ?? "unknown";
    const timelineBranch = workingSnapshotStore.getTimelineBranch();
    const trailers = getCommitTrailers(shadowLedger, timelineBranch, branch);
    return JSON.stringify(trailers);
  });

  transportMux.setHandler(async (clientId, message) => {
    // MCP protocol: handle initialize handshake for bridged clients
    if (message.method === "initialize") {
      // Capture agent name from clientInfo (e.g. "claude-code", "cursor")
      const clientName = (
        message.params as { clientInfo?: { name?: string } } | undefined
      )?.clientInfo?.name;
      if (clientName) {
        agentNameByClient.set(clientId, clientName);
      }
      return {
        jsonrpc: "2.0" as const,
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "unerr-local", version: "0.1.3" },
        },
      };
    }

    // MCP protocol: acknowledge initialized notification
    if (message.method === "notifications/initialized") {
      // Notifications don't get responses, but we need to not error
      return { jsonrpc: "2.0" as const };
    }

    if (message.method === "tools/list") {
      return {
        jsonrpc: "2.0" as const,
        result: { tools: await getInjectedTools() },
      };
    }

    // ══════════════════════════════════════════════════════════════════
    // UDS tools/call handler
    //
    // CRITICAL ARCHITECTURE NOTE: This handler MUST mirror the stdio
    // handler's dispatch chain (see CallToolRequestSchema handler above).
    //
    // When `unerr --mcp` detects a running proxy, it bridges stdin/stdout
    // to this UDS socket via bridge.ts. Tool calls from bridged IDEs
    // arrive HERE, not at the stdio handler. Any tool intercepted before
    // router.execute() in the stdio handler MUST also be intercepted here,
    // otherwise it hits QueryRouter which returns "Unknown tool" because
    // these tools are NOT in the LOCAL_TOOLS set.
    //
    // Tools that need interception (not in QueryRouter.LOCAL_TOOLS):
    //   - record_fact, recall_facts  (Layer 9: temporal fact store)
    //   - unerr_mark_working         (Shadow ledger: working snapshots)
    //   - unerr_revert_to_working_state  (Shadow ledger: revert)
    //   - unerr_get_timeline         (Shadow ledger: timeline view)
    //   - Deep dive tools            (Sprint 11: handled by handleDeepDiveTool)
    //
    // When adding new tools to TOOL_DEFINITIONS, ensure they are ALSO
    // dispatched here if they are not handled by QueryRouter.executeLocal().
    // ══════════════════════════════════════════════════════════════════
    if (message.method === "tools/call") {
      const params = message.params as
        | { name: string; arguments?: Record<string, unknown> }
        | undefined;
      if (!params?.name) {
        return {
          jsonrpc: "2.0" as const,
          error: { code: -32602, message: "Missing tool name" },
        };
      }

      const { name, arguments: toolArgs = {} } = params;

      // ── Boundary validation (mirrors stdio handler) ──
      // Bridged IDE clients via `unerr --mcp` hit THIS handler, not the
      // stdio one. Forgetting to mirror lets the silent-failure pattern
      // resurface for every IDE user. See arg-validator + the stdio dup.
      const udsValidationFailure = runBoundaryValidation(name, toolArgs);
      if (udsValidationFailure) {
        process.stderr.write(
          `[unerr] tools/call validation failed for ${name} (uds): ${JSON.stringify(udsValidationFailure)}\n`
        );
        return {
          jsonrpc: "2.0" as const,
          result: {
            content: [
              { type: "text", text: JSON.stringify(udsValidationFailure) },
            ],
            isError: true,
          },
        };
      }

      // Track tool usage for semantic cluster reordering (mirrors stdio handler)
      toolUsageTracker.record(name);

      // ── ST-2: Session-narrative marker tools (UDS path) ──
      {
        const { isMarkerTool, handleMarkerCall } = await import(
          "../tools/intelligence/timeline-markers.js"
        );
        if (isMarkerTool(name)) {
          if (!timelineHandle) {
            process.stderr.write(
              `[unerr] ${name} called but timeline subsystem is disabled (uds)\n`
            );
            return {
              jsonrpc: "2.0" as const,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error:
                        "marker tools require timeline subsystem (UNERR_TIMELINE_V2!=0)",
                    }),
                  },
                ],
                isError: true,
              },
            };
          }
          let branchVal = "main";
          let headShaVal = "";
          try {
            const { getCurrentBranch, getHeadSha } = await import(
              "../utils/git.js"
            );
            branchVal = (await getCurrentBranch(process.cwd())) ?? branchVal;
            headShaVal = (await getHeadSha(process.cwd())) ?? "";
          } catch {
            /* defaults */
          }
          const markerRes = await handleMarkerCall(
            name,
            toolArgs as Record<string, unknown>,
            {
              ledger: shadowLedger,
              store: timelineHandle.store,
              branch: branchVal,
              headSha: headShaVal,
            }
          );
          return { jsonrpc: "2.0" as const, result: markerRes };
        }
      }

      // ── Layer 9: record_fact + recall_facts (independent of graph) ──
      if (name === "record_fact" || name === "recall_facts") {
        const factResult =
          name === "record_fact"
            ? await handleRecordFactProxy(
                toolArgs,
                unerrDirForLedger,
                shadowLedger,
                {
                  tracker: effectivenessTracker,
                  turn: router.sessionContext.getToolCallCount(),
                }
              )
            : await handleRecallFactsProxy(toolArgs, unerrDirForLedger, {
                tracker: effectivenessTracker,
                turn: router.sessionContext.getToolCallCount(),
              });
        // Apply universal pagination cap so recall_facts surfaces page hints
        // when more facts are available beyond what the handler returned.
        const { applyWireCap: applyWireCapFact } = await import(
          "./wire-cap.js"
        );
        const rawText = factResult.content?.[0]?.text;
        let parsed: unknown = null;
        if (rawText) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            /* non-JSON, skip cap */
          }
        }
        if (parsed) {
          const { body: cappedBody, pageHint } = applyWireCapFact(
            name,
            parsed,
            toolArgs
          );
          const pageBlock = pageHint ? `${pageHint}\n\n` : "";
          // Forward isError so error responses from the fact handler reach
          // the agent as failed tool calls (UDS path mirrors stdio).
          return {
            jsonrpc: "2.0" as const,
            result: {
              content: [
                {
                  type: "text",
                  text: pageBlock + stringifyMcpToolJson(cappedBody),
                },
              ],
              ...(factResult.isError ? { isError: true } : {}),
            },
          };
        }
        return { jsonrpc: "2.0" as const, result: factResult };
      }

      // Shadow ledger tools disabled — not exposed in tool definitions
      // (unerr_mark_working, unerr_revert_to_working_state, unerr_get_timeline handlers removed)

      // ── Sprint 11: Deep Dive MCP tools (handled outside QueryRouter) ──
      if (localGraph) {
        const { handleDeepDiveTool } = await import(
          "../intelligence/deep-dive-tools.js"
        );
        const deepDiveResult = await handleDeepDiveTool(
          name,
          toolArgs,
          localGraph
        );
        if (deepDiveResult) {
          recordToolCall(stats);
          recordLatency(stats.latency, 0);
          pidLock.recordToolCall();
          if (stats.localMode) recordGraphQuery(stats.localMode, name);
          const branch = branchContext?.currentBranch ?? "unknown";
          const headSha = branchContext?.headSha ?? "";
          shadowLedger.record(
            name,
            toolArgs,
            { tool: name, source: "local", client: clientId },
            branch,
            headSha
          );
          return { jsonrpc: "2.0" as const, result: deepDiveResult };
        }
      }

      // ── All remaining tools: QueryRouter.execute (graph-backed) ──
      // Tools in QueryRouter.LOCAL_TOOLS: get_entity, get_file, get_references,
      // get_imports, search_code, get_rules, get_business_context, get_conventions,
      // file_read, file_outline, and deep dive blueprint tools.
      // Wrap in try/catch so any throw lands as isError:true (UDS mirror of stdio).
      let result: Awaited<ReturnType<typeof router.execute>>;
      try {
        result = await router.execute(name, toolArgs);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[unerr] router.execute(${name}) threw (uds): ${errMsg}\n`
        );
        return {
          jsonrpc: "2.0" as const,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: errMsg, tool: name }),
              },
            ],
            isError: true,
          },
        };
      }

      // Track stats from UDS clients the same way as stdio clients
      recordToolCall(stats);
      recordLatency(stats.latency, result._meta.latency_ms);
      pidLock.recordToolCall();
      if (stats.localMode && result._meta.source === "local") {
        recordGraphQuery(stats.localMode, name);
      }
      if (stats.localMode && result._meta.entity_risk) {
        recordBlastRadius(stats.localMode);
      }
      if (stats.localMode && result._meta.source === "local") {
        recordLatencyAdvantage(
          stats.localMode,
          Math.max(0, 200 - result._meta.latency_ms)
        );
      }

      // Record in Shadow Ledger with client-specific session context
      const branch = branchContext?.currentBranch ?? "unknown";
      const headSha = branchContext?.headSha ?? "";
      shadowLedger.record(
        name,
        toolArgs,
        {
          source: result._meta.source,
          found: result.content != null,
          client: clientId,
        },
        branch,
        headSha
      );

      // Tier-3: _meta/_context stripped. Wire-cap ran in QueryRouter and
      // stashed any pageHint on meta._unerr_page_hint — consume it here.
      const { buildSignalPrefix: buildSignalPrefix2 } = await import(
        "./response-envelope.js"
      );
      const entityKey2 =
        ((toolArgs as Record<string, unknown>).entity_key as
          | string
          | undefined) ??
        ((toolArgs as Record<string, unknown>).entity as string | undefined) ??
        ((toolArgs as Record<string, unknown>).key as string | undefined) ??
        ((toolArgs as Record<string, unknown>).name as string | undefined) ??
        ((toolArgs as Record<string, unknown>).file_path as
          | string
          | undefined) ??
        null;
      const signalFooter2 = buildSignalPrefix2(
        result._meta as Record<string, unknown>,
        result._context as Record<string, unknown> | undefined,
        entityKey2
      );
      const pageHint2 = (result._meta as Record<string, unknown>)
        ._unerr_page_hint as string | undefined;
      const bodyText2 =
        typeof result.content === "string"
          ? result.content
          : stringifyMcpToolJson(result.content);
      const pageBlock2 = pageHint2 ? `\n${pageHint2}` : "";
      const footerBlock2 = signalFooter2 ? `\n${signalFooter2.trimEnd()}` : "";
      const bodyEnd2 = bodyText2.endsWith("\n") ? "" : "\n";
      return {
        jsonrpc: "2.0" as const,
        result: {
          content: [
            {
              type: "text",
              text: bodyText2 + bodyEnd2 + pageBlock2 + footerBlock2,
            },
          ],
        },
      };
    }

    return {
      jsonrpc: "2.0" as const,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    };
  });

  transportMux.start();

  // ── Step 7a-3: HTTP Transport (Task 5.3) ────────────────────────
  let httpTransportHandle:
    | import("./http-transport.js").HttpTransportHandle
    | null = null;
  if (opts.httpPort && opts.httpPort > 0) {
    try {
      const { startHttpTransport } = await import("./http-transport.js");
      httpTransportHandle = await startHttpTransport({
        port: opts.httpPort,
        mcpServer: server,
        log: log.info,
      });
      log.info(`HTTP transport ready on port ${httpTransportHandle.port}`);
    } catch (err: unknown) {
      log.warn(
        `HTTP transport failed to start: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Step 7b: Branch Context + Drift Tracker ────────────────────

  const { computeBranchContextAsync, getCurrentBranch, startBranchPoller } =
    await import("../tracking/branch-context.js");
  branchContext = await computeBranchContextAsync();
  router.setBranchContext(branchContext);

  let _driftTracker:
    | import("../tracking/drift-tracker.js").DriftTracker
    | null = null;
  let stopBranchPoller: (() => void) | null = null;

  // L11.4: DriftTracker initialization extracted into a function.
  // Called immediately when snapshot is loaded, or deferred to onComplete when background indexing.
  async function initDriftTracker(): Promise<void> {
    if (!localGraph || repoIds.length === 0) return;
    try {
      const { DriftTracker } = await import("../tracking/drift-tracker.js");
      const { FileHashManager } = await import(
        "../tracking/file-hash-state.js"
      );
      const unerrDir = join(process.cwd(), ".unerr");
      const fileHashManager = new FileHashManager(unerrDir);

      _driftTracker = new DriftTracker(
        { projectRoot: process.cwd(), repoId: repoIds[0] as string, unerrDir },
        localGraph,
        fileHashManager
      );

      // L9.4: Wire DriftTracker into QueryRouter for sync_local_diff overlay writes
      router.setDriftTracker(_driftTracker);

      const { eventBus } = await import("../server/event-bus.js");
      _driftTracker.setDriftEventSink((payload) => {
        eventBus.emit("drift", payload);
      });

      // L2.5: Swap-on-idle graph rebuild via GraphHolder.
      // DriftTracker notifies GraphHolder of file changes → idle timer → full rebuild
      // into a fresh CozoDB instance → atomic swap to all consumers.
      const { GraphHolder } = await import("../intelligence/graph-holder.js");
      const { indexLocalProject } = await import(
        "../intelligence/local-indexer.js"
      );
      const repoId = repoIds[0] as string;
      const cwd = process.cwd();

      const graphHolder = new GraphHolder(localGraph);

      // Factory: reindexes into the existing persistent graph.
      // CozoDB :put is upsert — data stays queryable during rebuild.
      // Orphan cleanup at end of indexLocalProject removes stale entities.
      graphHolder.setRebuildFactory(async () => {
        const result = await indexLocalProject(cwd, localGraph, repoId);
        return { graph: localGraph, result };
      });

      // Incremental factory — processes only changed files, no full reindex.
      const { indexFilesIncremental } = await import(
        "../intelligence/incremental-indexer.js"
      );
      graphHolder.setIncrementalFactory(async (changedFiles) => {
        return indexFilesIncremental(cwd, changedFiles, localGraph, repoId);
      });

      // Swap callbacks — propagate new graph to all consumers
      graphHolder.onSwap((newGraph) => {
        router.swapGraph(newGraph);
      });
      graphHolder.onSwap((newGraph) => {
        _driftTracker?.swapGraph(newGraph);
      });
      // Behaviors
      graphHolder.onSwap((newGraph) => {
        cascadeGuard.attachGraph(newGraph);
        incompleteWork.attachGraph(newGraph);
        conventionDrift.attachGraph(newGraph);
        autoDoc.attachGraph(newGraph);
        architectureGuard.attachGraph(newGraph);
      });

      // NOTE: DriftTracker → GraphHolder notification intentionally NOT wired.
      // The NativeWatcher below directly notifies GraphHolder with file paths,
      // so a DriftTracker bridge would cause double-fire (duplicate incremental runs).

      // Wire NativeWatcher to detect file changes (both LLM tool writes and user edits).
      // Feeds into DriftTracker (overlay updates) + GraphHolder (idle timer for rebuild).
      const { createNativeWatcher } = await import(
        "../tracking/native-watcher.js"
      );
      const { filterIndexableEvents } = await import(
        "../intelligence/indexer/watch-integration.js"
      );
      const nativeWatcher = createNativeWatcher({
        projectRoot: cwd,
        debounceMs: 100,
        onEvents: (events) => {
          const indexable = filterIndexableEvents(events);
          if (indexable.length === 0) return;
          // Notify GraphHolder of file change (resets idle timer, tracks paths for incremental)
          graphHolder.notifyFileChange(indexable);
          // Feed into DriftTracker for overlay updates
          const headSha = branchContext?.headSha ?? "unknown";
          _driftTracker
            ?.processFiles(indexable, headSha)
            .catch((err: unknown) => {
              process.stderr.write(
                `⚠ [watcher] Drift processing failed: ${formatUnknownError(err)}\n`
              );
            });
        },
      });
      nativeWatcher.start().catch((err: unknown) => {
        process.stderr.write(
          `⚠ [watcher] File watcher failed to start: ${err instanceof Error ? err.message : String(err)}\n`
        );
      });

      // Initialize branch snapshot manager (Task 6.2)
      const branchSnapshots = _driftTracker.initBranchSnapshots();
      // GC snapshots for deleted branches on startup
      branchSnapshots.garbageCollect();

      // Start branch poller — save/restore overlay on switch
      let _previousBranch = getCurrentBranch() ?? "unknown";
      stopBranchPoller = startBranchPoller((newBranch, newContext) => {
        log.info(`Branch switch detected: ${_previousBranch} → ${newBranch}`);
        router.setBranchContext(newContext);
        const prev = _previousBranch;
        _previousBranch = newBranch;
        _driftTracker
          ?.onBranchSwitch([], newContext.headSha, prev, newBranch)
          .catch((err: unknown) => {
            log.warn(
              `Branch switch drift failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
      });
    } catch (err: unknown) {
      log.warn(
        `Drift tracker not available: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Step 7b-2: Background Indexing + ora Spinner (L11.1/L11.3) ──

  if (needsBackgroundIndex && localGraph) {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const bgIndexer = new BackgroundIndexer();

    // Wire into router for partial graph responses (L11.2)
    router.setBackgroundIndexer(bgIndexer);

    // ora spinner on stderr — never touches stdout (MCP JSON-RPC only)
    const ora = (await import("ora")).default;
    const spinner = ora({
      text: "Indexing project...",
      stream: process.stderr,
    }).start();

    const localRepoId = repoIds[0] as string;

    bgIndexer.start(
      process.cwd(),
      localGraph,
      localRepoId,
      // onComplete
      async (result) => {
        // L4.1: Record indexing stats for Local Mode proof
        if (stats.localMode) {
          recordIndexingResult(stats.localMode, result);
        }
        spinner.succeed("Deep index complete");

        startupLog.graphLoaded({
          entities: result.entityCount,
          edges: result.edgeCount,
          files: result.fileCount,
          communities: result.communityCount,
          patterns: 0,
          rules: 0,
          ms: result.elapsedMs,
        });

        // Compute health grade now that the graph is populated
        try {
          const { computeHealthGrade } = await import(
            "../intelligence/health-grade.js"
          );
          healthResult = await computeHealthGrade(localGraph.db);
          if (healthResult) {
            router.setHealthInfo(healthResult.grade, {
              entities: healthResult.totalEntities,
              edges: healthResult.totalEdges,
              rules: healthResult.totalRules,
            });
            // startupLog.healthCard(healthResult); // Disabled until health metrics verified against drift state
          }
        } catch (err: unknown) {
          log.warn(
            `Health grade failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // Show MCP connection card with config snippet for manual agent setup
        try {
          const { AGENT_REGISTRY } = await import(
            "../config/agent-registry.js"
          );
          const fs = await import("node:fs");
          const pathMod = await import("node:path");
          const projectDir = process.cwd();
          const configured = AGENT_REGISTRY.filter((a) =>
            fs.existsSync(pathMod.join(projectDir, a.projectConfigPath))
          ).map((a) => a.name);
          startupLog.mcpConnectionCard(configured, projectDir);
        } catch (err: unknown) {
          log.warn(
            `MCP connection card failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // L11.4: Start DriftTracker ONLY after initial indexing completes (TL-31)
        initDriftTracker().catch((err: unknown) => {
          log.warn(
            `Post-index DriftTracker init failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });

        // Layer 9: Generate temporal facts from detected conventions after reindex
        try {
          const factStoreForGen = await getProxyFactStore(unerrDirForLedger);
          if (factStoreForGen) {
            const { detectLocalConventions } = await import(
              "../intelligence/local-convention-detector.js"
            );
            const { generateFromConventions } = await import(
              "../intelligence/fact-generator.js"
            );
            const detection = await detectLocalConventions(localGraph.db);
            if (detection.conventions.length > 0) {
              const convResult = await generateFromConventions(
                factStoreForGen,
                detection.conventions
              );
              if (convResult.created > 0 || convResult.reinforced > 0) {
                log.info(
                  `Fact generator: ${convResult.created} convention facts created, ${convResult.reinforced} reinforced`
                );
              }
            }
            // Also run session analysis pipeline
            const { runFactGenerationPipeline } = await import(
              "../intelligence/fact-generator.js"
            );
            const pipelineResults = await runFactGenerationPipeline(
              factStoreForGen,
              unerrDirForLedger
            );
            for (const r of pipelineResults) {
              if (r.created > 0 || r.reinforced > 0) {
                log.info(
                  `Fact generator [${r.source}]: ${r.created} created, ${r.reinforced} reinforced`
                );
              }
            }
          }
        } catch {
          // Non-critical — fact generation failure doesn't block operation
        }
      },
      // onError
      (err) => {
        spinner.fail(`Indexing failed: ${err.message}`);
        process.stderr.write(
          "  MCP continues with partial graph. Run 'unerr' again to retry.\n"
        );
      }
    );

    // Update spinner with progress every 200ms
    const progressInterval = setInterval(() => {
      if (!bgIndexer.isIndexing()) {
        clearInterval(progressInterval);
        return;
      }
      const p = bgIndexer.getProgress();
      const shortFile = p.currentFile
        ? p.currentFile.length > 40
          ? `...${p.currentFile.slice(-37)}`
          : p.currentFile
        : "";
      spinner.text = `${p.phase}: ${p.processed}/${p.total} (${p.pct}%) ${shortFile}`;
    }, 200);
  } else {
    // No background indexing needed — start DriftTracker immediately
    await initDriftTracker();
  }

  // ── Step 7c: Commit Watcher + Manifest ───────────────────────────

  const { WorkspaceManifest } = await import(
    "../tracking/workspace-manifest.js"
  );
  const workspaceManifest = repoIds[0]
    ? new WorkspaceManifest(
        join(process.cwd(), ".unerr"),
        repoIds[0],
        shadowLedger.getSessionId()
      )
    : null;

  const { CommitWatcher } = await import("../tracking/commit-watcher.js");
  const commitWatcher = new CommitWatcher(intentCorrelator, {
    cwd: process.cwd(),
    sessionId: shadowLedger.getSessionId(),
    onCommit: (_sha, _files, associated) => {
      if (associated > 0) {
        // Record attributions in manifest for committed correlations
        if (workspaceManifest) {
          const committed = intentCorrelator.getCommittedUnflushed();
          const branch = branchContext?.currentBranch ?? "unknown";
          for (const correlation of committed) {
            workspaceManifest.recordAttribution(correlation, branch);
          }
        }
      }
    },
  });
  // Set branch context + drift summary for git note encoding (Task 8.1)
  if (branchContext) {
    commitWatcher.setBranchContext(branchContext);
  }
  if (localGraph) {
    commitWatcher.setDriftSummaryFn(async () => {
      const s = await localGraph.getDriftSummary();
      return { added: s.added, modified: s.modified, deleted: s.deleted };
    });
  }
  commitWatcher.start();

  if (proxyMode === "parse") {
    const parseStats = parseIndex?.getStats();
    startup.addStep(
      "MCP ready",
      "done",
      `PARSE mode (${parseStats?.entityCount ?? 0} entities)`
    );
    log.info(
      `MCP server running on stdio — PARSE mode (${parseStats?.entityCount ?? 0} entities from ${parseStats?.fileCount ?? 0} files)`
    );
  } else {
    const localToolCount = 14;
    const rules = localGraph?.hasRules() ? await localGraph.getRules() : null;
    const ruleInfo = rules ? ` (${rules.length} rules loaded)` : "";
    startup.addStep("MCP ready", "done", `${localToolCount} local tools ready`);
    startup.setToolCount(localToolCount);
    startupLog.toolsReady(localToolCount, rules?.length ?? 0);
    startupLog.ready(localToolCount, proxyMode);
  }

  // Finalize startup display (Act 3)
  startup.setReady(proxyMode);
  startup.unmount();

  // ── Task 6.3: Deferred Initialization ─────────────────────────────
  // These run after MCP is already serving — first few tool calls may
  // lack health/PARSE data, which is acceptable (flagged via _meta.initialization).

  // Deferred: Health grade computation (non-PARSE mode)
  // Skip if background index is running — graph is empty until indexing completes.
  // In that case, health grade is computed in the bgIndexer onComplete callback.
  if (localGraph && proxyMode !== "parse" && !needsBackgroundIndex) {
    try {
      const { computeHealthGrade } = await import(
        "../intelligence/health-grade.js"
      );
      healthResult = await computeHealthGrade(localGraph.db);
      if (healthResult) {
        router.setHealthInfo(healthResult.grade, {
          entities: healthResult.totalEntities,
          edges: healthResult.totalEdges,
          rules: healthResult.totalRules,
        });
        // startupLog.healthCard(healthResult); // Disabled until health metrics verified against drift state
      }
    } catch (err: unknown) {
      log.warn(
        `Health grade failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Show MCP connection card on resume (matches first-run path)
    try {
      const { AGENT_REGISTRY } = await import("../config/agent-registry.js");
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const projectDir = process.cwd();
      const configured = AGENT_REGISTRY.filter((a) =>
        fs.existsSync(pathMod.join(projectDir, a.projectConfigPath))
      ).map((a) => a.name);
      startupLog.mcpConnectionCard(configured, projectDir);
    } catch (err: unknown) {
      log.warn(
        `MCP connection card failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Deferred: PARSE mode entity indexing
  if (proxyMode === "parse" && parseIndex) {
    try {
      const { extractEntitiesFromSource } = await import("./auto-bootstrap.js");
      const allFiles = readdirSync(process.cwd(), {
        recursive: true,
        encoding: "utf-8",
      }) as string[];
      const sourceFiles = allFiles.filter((f) => {
        if (!f.match(/\.(ts|tsx|js|jsx)$/)) return false;
        if (f.includes("node_modules")) return false;
        if (
          f.startsWith("dist/") ||
          f.startsWith(".git/") ||
          f.includes("/dist/")
        )
          return false;
        if (f.includes("coverage/")) return false;
        return true;
      });

      for (const file of sourceFiles.slice(0, 500)) {
        try {
          const content = readFileSync(join(process.cwd(), file), "utf-8");
          const entities = extractEntitiesFromSource(file, content);
          parseIndex.addEntities(entities);
        } catch {
          /* skip unreadable files */
        }
      }

      const indexStats = parseIndex.getStats();
      log.info(
        `PARSE index: ${indexStats.entityCount} entities from ${indexStats.fileCount} files`
      );
    } catch (err: unknown) {
      log.warn(
        `PARSE indexing failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Task 6.5: Pre-load tree-sitter WASM grammars (non-blocking)
  try {
    const { preloadGrammars } = await import(
      "../intelligence/ast-extractor.js"
    );
    await preloadGrammars();
    log.info("Tree-sitter WASM grammars pre-loaded");
  } catch (err: unknown) {
    log.warn(
      `Tree-sitter grammar pre-load failed (regex fallback active): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  deferredInitComplete = true;
  log.info("Deferred initialization complete");

  // ── Log Tailer: relay logs from exec/--mcp child processes ────────
  const { startLogTailer } = await import("./log-tailer.js");
  const logTailer = startLogTailer(process.cwd(), {
    // RC4 fix: Ingest child process token-flow events into proxy's writer
    // so they appear in SSE streams and in-memory aggregations
    onTokenFlowEvent: (entry) => {
      if (tokenFlowWriter) {
        try {
          tokenFlowWriter.ingestExternal(
            entry as unknown as import(
              "../tracking/token-flow.js"
            ).TokenFlowEvent
          );
        } catch {
          /* best effort */
        }
      }
    },
  });

  // ── Step 7c-2: Auto-configure git notes push (Task 8.7) ──────────

  try {
    const { gitQuery: gitQ, gitExec: gitE } = await import("../utils/exec.js");
    const notesPush =
      (await gitQ(
        ["config", "--local", "--get-all", "notes.push"],
        process.cwd()
      )) ?? "";

    if (!notesPush.includes("refs/notes/unerr")) {
      await gitE(
        ["config", "--local", "--add", "notes.push", "refs/notes/unerr"],
        { cwd: process.cwd() }
      );
      log.info("Auto-configured git notes push for intent tracking");
    }
  } catch {
    // Non-critical — notes just won't auto-push
  }

  // ── Step 7c-2b: Git Trailer Hook (Sprint 10.5) ───────────────────
  try {
    const { installPrepareCommitMsgHook } = await import(
      "../tracking/git-trailers.js"
    );
    installPrepareCommitMsgHook(process.cwd());
  } catch {
    // Non-critical
  }

  // ── Step 7d: Periodic stats snapshot (for `unerr status`) ─────
  const { writeFileSync: writeStatsFile } = await import("node:fs");
  const { computePercentiles } = await import("./session-stats.js"); // same dir

  const statsSnapshotPath = join(stateDir, "session_stats.json");
  const statsSnapshotInterval = setInterval(() => {
    try {
      const total = stats.toolCallsLocal;
      if (total === 0) return;
      const localP = computePercentiles(
        stats.latency.localSamples,
        stats.latency.localTotalSamples
      );
      const snapshot = {
        pid: process.pid,
        sessionStartedAt: stats.sessionStartedAt,
        toolCallsLocal: stats.toolCallsLocal,
        violationsCaught: stats.violationsCaught,
        riskWarningsIssued: stats.riskWarningsIssued,
        latency: {
          local: localP
            ? {
                p50: localP.p50,
                p95: localP.p95,
                p99: localP.p99,
                count: localP.count,
              }
            : null,
        },
        updatedAt: new Date().toISOString(),
      };
      writeStatsFile(
        statsSnapshotPath,
        JSON.stringify(snapshot, null, 2),
        "utf-8"
      );
    } catch {
      /* non-critical */
    }
  }, 10_000); // every 10s

  // ── Step 7d: Layer 7 Dashboard HTTP Server ──────────────────────
  // Non-blocking: runs after MCP is ready, failure doesn't affect proxy.
  let dashboardHandle: { port: number; close: () => void } | null = null;
  try {
    const { startDashboardServer } = await import("../server/http.js");
    const { detectIde: detectIdeDashboard } = await import(
      "../utils/detect.js"
    );
    const ideType = await detectIdeDashboard(process.cwd());

    const unerrDirForApi = join(process.cwd(), ".unerr");
    dashboardHandle = await startDashboardServer({
      system: {
        stats,
        cwd: process.cwd(),
        dashboardPort: 0, // Resolved during port scan
        startedAt: stats.sessionStartedAt,
        ide: ideType,
        getGraphStats: async () => {
          if (!localGraph) return { entities: 0, edges: 0, rules: 0 };
          const projectStats = await localGraph.getLocalProjectStats();
          return {
            entities: projectStats.entityCount,
            edges: projectStats.edgeCount,
            rules: projectStats.ruleCount,
          };
        },
      },
      intelligence: {
        localGraph,
        cwd: process.cwd(),
        unerrDir: unerrDirForApi,
        getRecentLedgerEntries: (limit) => shadowLedger.getRecentEntries(limit),
        getHealthGrade: async () => {
          if (healthResult) return healthResult;
          if (!localGraph || proxyMode === "parse") return null;
          try {
            const { computeHealthGrade } = await import(
              "../intelligence/health-grade.js"
            );
            return await computeHealthGrade(localGraph.db);
          } catch {
            return null;
          }
        },
        getSignalStats: () => router.getSignalStats(),
      },
      session: {
        stats,
        getEfficiencySnapshot: () => router.getEfficiencySnapshot(),
        getIntentGroups: () => router.getIntentGroups(),
        getRecentLedgerEntries: (limit) => shadowLedger.getRecentEntries(limit),
      },
      stream: { stats },
      stateDir,
      apiOnly: !!opts.daemonChild,
      tokenFlow: {
        unerrDir: unerrDirForApi,
        getTokenFlowWriter: () => tokenFlowWriter,
        getAgentName: (_sessionId: string) => {
          // Return most recent connected agent name (proxy has one active session)
          const last = [...agentNameByClient.values()].pop();
          return last ?? server.getClientVersion?.()?.name ?? undefined;
        },
      },
      reasoningQuality: {
        unerrDir: unerrDirForApi,
        getTokenFlowWriter: () => tokenFlowWriter,
        getAgentName: (_sessionId: string) => {
          const last = [...agentNameByClient.values()].pop();
          return last ?? server.getClientVersion?.()?.name ?? undefined;
        },
      },
      timeline: timelineHandle
        ? {
            store: timelineHandle.store,
            getRecentLedgerEntries: (limit: number) =>
              shadowLedger.getRecentEntries(limit),
          }
        : undefined,
      temporal: await (async () => {
        try {
          const { TemporalFactStore } = await import(
            "../intelligence/temporal-facts.js"
          );
          const { readdirSync, readFileSync } = await import("node:fs");
          const factStore = await TemporalFactStore.create(process.cwd());
          return {
            factStore,
            loadRecentSessions: (limit: number) => {
              try {
                const sessDir = join(unerrDirForApi, "sessions");
                const files = readdirSync(sessDir)
                  .filter((f: string) => f.endsWith(".jsonl"))
                  .sort()
                  .slice(-limit);
                return files.map((f: string) => {
                  const content = readFileSync(join(sessDir, f), "utf-8")
                    .trim()
                    .split("\n")
                    .pop()!;
                  return JSON.parse(content);
                });
              } catch {
                return [];
              }
            },
            emitEvent: (_type: string, _data: unknown) => {
              // SSE event bus — wired to dashboard EventSource
            },
          };
        } catch {
          return undefined;
        }
      })(),
    });

    if (dashboardHandle) {
      startupLog.dashboardReady(`http://127.0.0.1:${dashboardHandle.port}`);
    }
  } catch (err: unknown) {
    log.warn(
      `Dashboard server failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Step 8: Graceful Shutdown ────────────────────────────────────

  // Once-guard: shutdown can fire from SIGINT, SIGTERM, and direct callers.
  // We want exactly one full pass — subsequent calls return the same promise.
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      lifecycle.send({ type: "SHUTDOWN" });
      lifecycle.stop();
      logTailer.close();

      // Layer 4: Fire session-end behaviors
      behaviorDispatcher
        .fireSessionEnd({
          toolName: "__session_end__",
          args: {},
          sessionId: shadowLedger.getSessionId(),
        })
        .catch(() => {});

      // Close any still-open persistent-memory windows so their verdicts
      // land in the session summary instead of being dropped.
      try {
        effectivenessTracker.closeAll(router.sessionContext.getToolCallCount());
      } catch {
        /* best-effort — tracker errors must never block shutdown */
      }

      // Persist session stats via unified weekly accumulator (S8.4)
      const total = stats.toolCallsLocal;
      if (total > 0) {
        // Layer 10: Compute token flow summary for persistence + receipt
        let tokenFlowSummary:
          | import("../tracking/token-flow.js").SessionTokenSummary
          | null = null;
        let mechanismBreakdown: Record<string, number> | undefined;
        if (tokenFlowWriter) {
          try {
            const { aggregateSession: aggSession } =
              require("../tracking/token-flow.js") as typeof import(
                "../tracking/token-flow.js"
              );
            tokenFlowSummary = aggSession(
              tokenFlowWriter.getSessionEvents(),
              tokenFlowWriter.sessionId
            );
            if (Object.keys(tokenFlowSummary.by_mechanism).length > 0) {
              mechanismBreakdown = {};
              for (const [mech, data] of Object.entries(
                tokenFlowSummary.by_mechanism
              )) {
                mechanismBreakdown[mech] = data.tokens_saved;
              }
            }
          } catch {
            /* non-critical */
          }
        }

        // biome-ignore format: typeof import() must stay single-line for TS
        const { accumulateSession } = require("../tracking/weekly-accumulator.js") as typeof import("../tracking/weekly-accumulator.js");
        const { computePercentiles } =
          require("./session-stats.js") as typeof import("./session-stats.js");
        const localPercentiles = computePercentiles(
          stats.latency.localSamples,
          stats.latency.localTotalSamples
        );
        const effSnap = router.getEfficiencySnapshot();
        const unifiedStats = accumulateSession({
          tokensSaved:
            tokenFlowSummary?.total_tokens_saved ??
            stats.localMode?.tokensSavedByTruncation ??
            stats.estimatedTokensSaved,
          dollarsSaved: router.getSessionDollarsSaved(),
          toolCalls: stats.toolCallsLocal,
          violationsCaught: stats.violationsCaught,
          chokepointWarnings: stats.events.chokepointWarningsIssued,
          correctionsApplied: stats.localMode?.correctionPatternsInjected ?? 0,
          blastRadiusComputed: stats.localMode?.blastRadiusComputations ?? 0,
          efficiency:
            tokenFlowSummary?.efficiency_pct ?? effSnap?.efficiency ?? 0,
          latencyP50: localPercentiles?.p50 ?? 0,
          tokensByMechanism: mechanismBreakdown,
        });

        // Layer 10: Persist session history with token flow summary
        if (tokenFlowSummary && tokenFlowSummary.total_tokens_saved > 0) {
          try {
            const { appendSessionHistory } =
              require("../tracking/session-history.js") as typeof import(
                "../tracking/session-history.js"
              );
            const topMech = Object.entries(tokenFlowSummary.by_mechanism).sort(
              ([, a], [, b]) => b.tokens_saved - a.tokens_saved
            )[0];
            appendSessionHistory(join(process.cwd(), ".unerr"), {
              sessionId: shadowLedger.getSessionId(),
              startedAt: new Date(stats.sessionStartedAt).toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: Date.now() - stats.sessionStartedAt,
              toolCalls: stats.toolCallsLocal,
              tokensSaved: tokenFlowSummary.total_tokens_saved,
              tokensProcessed: tokenFlowSummary.total_tokens_without,
              efficiency: tokenFlowSummary.efficiency_pct,
              dollarsSaved: router.getSessionDollarsSaved(),
              modelId: "unknown",
              entityCount: 0,
              agentName:
                agentNameByClient.values().next().value ??
                server.getClientVersion?.()?.name ??
                undefined,
              tokenFlowSummary: {
                by_mechanism: Object.fromEntries(
                  Object.entries(tokenFlowSummary.by_mechanism).map(
                    ([k, v]) => [
                      k,
                      {
                        tokens_saved: v.tokens_saved,
                        event_count: v.event_count,
                      },
                    ]
                  )
                ),
                top_mechanism: topMech?.[0] ?? "none",
                efficiency_pct: tokenFlowSummary.efficiency_pct,
                total_tokens_saved: tokenFlowSummary.total_tokens_saved,
                total_tokens_delivered: tokenFlowSummary.total_tokens_with,
              },
            });
          } catch {
            /* non-critical */
          }
        }

        // Layer 10: Print session receipt
        if (tokenFlowSummary && tokenFlowSummary.total_tokens_saved > 0) {
          try {
            const { printSessionReceipt } =
              require("../tracking/session-receipt.js") as typeof import(
                "../tracking/session-receipt.js"
              );
            printSessionReceipt({
              summary: tokenFlowSummary,
              durationMs: Date.now() - stats.sessionStartedAt,
              toolCalls: stats.toolCallsLocal,
              weeklyTokensSaved: unifiedStats.weekly.tokensSaved,
              weeklySessions: unifiedStats.weekly.sessions,
            });
          } catch {
            /* non-critical */
          }
        }
        // Build CumulativeLocalStats shape for SessionSummaryCard backwards compat
        const cumulativeLocal = {
          weekStartDate: unifiedStats.weekly.weekStart,
          totalSessions: unifiedStats.weekly.sessions,
          totalToolCalls: unifiedStats.weekly.toolCalls,
          totalTokensSaved: unifiedStats.weekly.tokensSaved,
          totalViolationsCaught: unifiedStats.weekly.violationsCaught,
          totalCorrectionsApplied: unifiedStats.weekly.correctionsApplied,
          totalFilesIndexed: 0,
          totalSemanticSearches: 0,
          avgLatencyP50: unifiedStats.weekly.avgLatencyP50,
        };

        // S8.6: Build scorecard for session summary display
        // biome-ignore format: typeof import() must stay single-line for TS
        const { formatScorecard, formatCounterfactual } = require("../config/value-surfacing.js") as typeof import("../config/value-surfacing.js");
        const tokensSaved =
          stats.localMode?.tokensSavedByTruncation ??
          stats.estimatedTokensSaved;
        const dollarsSaved = router.getSessionDollarsSaved();
        const durationMs = Date.now() - stats.sessionStartedAt;
        const scorecardData = formatScorecard({
          toolCalls: stats.toolCallsLocal,
          tokensSaved,
          dollarsSaved,
          efficiency: effSnap?.efficiency ?? 0,
          durationMs,
          blastRadiusComputed: stats.localMode?.blastRadiusComputations ?? 0,
          conventionsInjected: stats.localMode?.communityContextsInjected ?? 0,
          outputsCompressed: stats.localMode?.truncatedResponses ?? 0,
          correctionsApplied: stats.localMode?.correctionPatternsInjected ?? 0,
          wrongApproachesPrevented: 0,
        });

        // S8.7: Counterfactual explanation
        const tokensWithout =
          tokensSaved > 0 ? Math.round(tokensSaved / 0.65) : 0;
        const counterfactualStr =
          tokensWithout > 0
            ? formatCounterfactual(tokensWithout, tokensWithout - tokensSaved)
            : undefined;

        try {
          const React = require("react") as any;
          const { SessionSummaryCard } =
            require("../components/SessionSummaryCard.js") as any;
          const { ThemeProvider } = require("../components/Theme.js") as any;
          const { renderToStderr } = require("../components/render.js") as any;
          const el = React.createElement(
            ThemeProvider,
            null,
            React.createElement(SessionSummaryCard, {
              stats,
              cumulativeLocal,
              scorecard: {
                efficiency: scorecardData.efficiency,
                dollarsSaved: scorecardData.dollarsSaved,
                tokensSaved: scorecardData.tokensSaved,
                counterfactual: counterfactualStr,
              },
            })
          );
          const inst = renderToStderr(el);
          inst.unmount();
        } catch {
          // Fallback to plain text if Ink rendering fails
          const localSummary = formatLocalModeSessionStats(stats);
          if (localSummary) process.stderr.write(localSummary);
        }
      }

      // Print drift summary if any
      if (localGraph) {
        try {
          const driftSummary = await localGraph.getDriftSummary();
          if (driftSummary.total > 0) {
            process.stderr.write(
              `[unerr] Drift: ${driftSummary.added} added, ${driftSummary.modified} modified, ${driftSummary.deleted} deleted\n`
            );
          }
        } catch {
          /* non-critical */
        }
      }

      // Sprint 10.7: Persist quality signals
      qualitySignalTracker.save();

      // Flush shadow ledger + print ledger summary
      shadowLedger.flush();
      const ledgerStats = shadowLedger.getStats();
      if (ledgerStats.totalEntries > 0) {
        const pendingCorrelations = intentCorrelator.getPendingCount();
        process.stderr.write(
          `[unerr] Ledger: ${ledgerStats.totalEntries} entries, ${ledgerStats.bufferSize} buffered, ${pendingCorrelations} pending correlations\n`
        );
      }

      // Sprint 4: Capture session narrative summary (works in both modes)
      if (narrativeCapture) {
        const sessionId = shadowLedger.getSessionId();
        narrativeCapture
          .captureSessionSummary(sessionId)
          .then((result) => {
            if (result.filesModified.length > 0) {
              process.stderr.write(
                `[unerr] Session narrative: ${result.narratives.length} edits across ${result.filesModified.length} file(s)\n`
              );
            }
          })
          .catch(() => {});
      }

      // Sprint 5: Run session pattern analyzer at shutdown
      if (proxyFactStore && ledgerStats.totalEntries > 0) {
        try {
          const { analyzeSessionPatterns } =
            require("../intelligence/session-pattern-analyzer.js") as typeof import(
              "../intelligence/session-pattern-analyzer.js"
            );
          const entries = shadowLedger.getRecentEntries(100);
          analyzeSessionPatterns({
            ledgerEntries: entries,
            factStore: proxyFactStore,
            sessionId: shadowLedger.getSessionId(),
          })
            .then((analysisResult) => {
              if (
                analysisResult.factsCreated > 0 ||
                analysisResult.factsReinforced > 0
              ) {
                process.stderr.write(
                  `[unerr] Session analysis: ${analysisResult.factsCreated} facts learned, ${analysisResult.factsReinforced} reinforced\n`
                );
              }
            })
            .catch(() => {});
        } catch {
          // Pattern analysis is non-critical
        }
      }

      // Leapfrog Sprint B: Run correction detector on this session's ledger entries
      if (localGraph && ledgerStats.totalEntries > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const correctionModule = require("../tracking/correction-detector.js");
          const detectCorrections = correctionModule.detectCorrections as (
            ledgerPath: string,
            opts?: { since_days?: number }
          ) => Array<{
            error_type: string;
            entity_key: string;
            correction_summary: string;
            confidence: number;
            occurrences: number;
            last_seen: string;
          }>;
          const ledgerPath = join(
            process.cwd(),
            ".unerr",
            "ledger",
            "shadow.jsonl"
          );
          const patterns = detectCorrections(ledgerPath, { since_days: 1 });
          if (patterns.length > 0) {
            localGraph.persistCorrections(patterns);
            // L4.1: Track correction patterns injected
            if (stats.localMode) {
              for (let i = 0; i < patterns.length; i++) {
                recordCorrectionInjection(stats.localMode);
              }
            }
            process.stderr.write(
              `[unerr] Learned ${patterns.length} correction pattern${patterns.length !== 1 ? "s" : ""} from this session\n`
            );

            // Layer 9: Generate negative knowledge facts from corrections
            try {
              const factStoreForShutdown =
                await getProxyFactStore(unerrDirForLedger);
              if (factStoreForShutdown) {
                const { generateFromNegativeKnowledge } = await import(
                  "../intelligence/fact-generator.js"
                );
                const corrections = patterns.map((p, i) => ({
                  id: `correction-${shadowLedger.getSessionId()}-${i}`,
                  entityKey: p.entity_key,
                  pattern: p.error_type,
                  reason: p.correction_summary,
                  detectedAt: p.last_seen,
                  rewindEntryId: shadowLedger.getSessionId(),
                  confidence: p.confidence,
                }));
                const negResult = await generateFromNegativeKnowledge(
                  factStoreForShutdown,
                  corrections
                );
                if (negResult.created > 0) {
                  process.stderr.write(
                    `[unerr] Fact generator: ${negResult.created} negative knowledge facts created\n`
                  );
                }
              }
            } catch {
              // Non-critical — fact generation doesn't block shutdown
            }
          }
        } catch {
          // Correction detection is non-critical — don't block shutdown
        }
      }

      // Layer 9: Run session analysis fact generation on shutdown
      try {
        const factStoreForSession = await getProxyFactStore(unerrDirForLedger);
        if (factStoreForSession) {
          const { runFactGenerationPipeline } = await import(
            "../intelligence/fact-generator.js"
          );
          const pipelineResults = await runFactGenerationPipeline(
            factStoreForSession,
            unerrDirForLedger
          );
          for (const r of pipelineResults) {
            if (r.created > 0 || r.reinforced > 0) {
              process.stderr.write(
                `[unerr] Fact generator [${r.source}]: ${r.created} created, ${r.reinforced} reinforced\n`
              );
            }
          }
        }
      } catch {
        // Non-critical — fact generation doesn't block shutdown
      }

      // Record orphaned intents (pending correlations that never got committed)
      if (workspaceManifest) {
        const orphans = intentCorrelator.getPending();
        if (orphans.length > 0) {
          workspaceManifest.recordOrphanedIntents(
            orphans.map((c) => ({
              rootIntentId: c.rootIntentId,
              prompt: c.prompt,
              toolChain: c.toolChain,
              files: c.files,
              createdAt: c.createdAt,
            }))
          );
        }

        const mStats = workspaceManifest.getStats();
        if (mStats.total > 0 || mStats.orphanedIntents > 0) {
          process.stderr.write(
            `[unerr] Manifest: ${mStats.total} attributions (${mStats.unflushed} unflushed, ${mStats.orphanedIntents} orphaned)\n`
          );
        }
      }

      // Cleanup
      clearInterval(statsSnapshotInterval);
      commitWatcher.stop();
      stopBranchPoller?.();
      // Task 7.2: Stop UDS transport (cleans up socket file)
      transportMux.stop();
      // Task 5.3: Stop HTTP transport
      httpTransportHandle?.close();
      // Layer 7: Stop dashboard server
      dashboardHandle?.close();
      // Remove stats snapshot file
      try {
        const { unlinkSync } = require("node:fs") as typeof import("node:fs");
        unlinkSync(statsSnapshotPath);
      } catch {
        /* ignore */
      }
      // Release persistent CozoDB native handles
      if (localGraph?.db.close) {
        localGraph.db.close();
      }
      // Release SQLite metrics handle(s).
      try {
        const { closeAllMetricsStores } =
          require("../tracking/metrics-store.js") as typeof import(
            "../tracking/metrics-store.js"
          );
        closeAllMetricsStores();
      } catch {
        /* metrics store may not have been opened this session */
      }
      // ST-4: Stop intent-stitch interval before releasing the store handle.
      if (timelineIntentStitchInterval) {
        clearInterval(timelineIntentStitchInterval);
      }
      // ST-5: Stop signal prune interval.
      if (timelineSignalPruneInterval) {
        clearInterval(timelineSignalPruneInterval);
      }
      // ST-6: Stop daily ledger-archive interval.
      clearInterval(ledgerArchiveInterval);
      // ST-1c: Release timeline subsystem (no-op if disabled or never started)
      timelineHandle?.stop();

      pidLock.release();
      log.info("Proxy stopped.");
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  return { shutdown, stats };
}

// ── Internal Helpers ──────────────────────────────────────────────────

/**
 * Create a minimal CozoGraphStore-compatible stub for PARSE mode.
 * Delegates entity lookups to the ParseModeIndex.
 */
async function createParseGraphStub(
  index: import("./auto-bootstrap.js").ParseModeIndex
): Promise<import("../intelligence/local-graph.js").CozoGraphStore> {
  const noop = async () => [];
  const noopVoid = async () => {};
  return {
    getEntity: async (key: string) => {
      const e = await index.getEntity(key);
      if (!e) return null;
      return {
        key: e.key,
        kind: e.kind,
        name: e.name,
        file_path: e.file_path,
        start_line: e.line_start,
        signature: e.signature,
        body: "",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
      };
    },
    getCallersOf: noop,
    getCalleesOf: noop,
    getEntitiesByFile: async (fp: string) =>
      (await index.getEntitiesByFile(fp)).map((e) => ({
        key: e.key,
        kind: e.kind,
        name: e.name,
        file_path: e.file_path,
        start_line: e.line_start,
        signature: e.signature,
        body: "",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
      })),
    searchEntities: async (q: string, limit?: number) =>
      index.search(q, limit).map((e) => ({
        key: e.key,
        kind: e.kind,
        name: e.name,
        file_path: e.file_path,
        start_line: e.line_start,
        signature: e.signature,
        body: "",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
      })),
    getImports: noop,
    hasRules: () => false,
    getRules: noop,
    getPatterns: noop,
    hasJustifications: () => false,
    getBusinessContext: async () => null,
    getConventions: noop,
    getDriftEntitiesForFile: noop,
    upsertDriftEntity: noopVoid,
    removeDriftEntity: noopVoid,
    clearDriftOverlay: noopVoid,
    getDriftSummary: async () => ({
      added: 0,
      modified: 0,
      deleted: 0,
      total: 0,
    }),
    healthCheck: () => ({ status: "parse_mode" as const, latencyMs: 0 }),
    isLoaded: () => true,
    loadSnapshot: noopVoid,
    loadRules: noopVoid,
    loadPatterns: noopVoid,
    loadJustifications: noopVoid,
    applyDelta: () => ({
      applied: 0,
      deleted: 0,
      edges: 0,
      justifications: 0,
      overlayExpired: 0,
    }),
  } as unknown as import("../intelligence/local-graph.js").CozoGraphStore;
}
