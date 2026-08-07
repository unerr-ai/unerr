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
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configureEmit } from "../events/enqueue.js";
import { PROXY_SEGMENT } from "../events/event-store.js";
// Static ESM imports, NOT require(): the tsup bundle is pure ESM, where
// require() hits esbuild's "Dynamic require is not supported" stub — these
// two are needed in SYNC contexts (runBoundaryValidation, the /commit-context
// HTTP handler) where `await import()` is unavailable. Both are light
// (definitions + node:fs only), so static import costs nothing at boot.
import {
  DEEP_DIVE_TOOL_DEFINITIONS,
  NAVIGATION_TOOL_NAMES,
} from "../intelligence/deep-dive-tools.js";
import { publishGraphStats } from "../intelligence/graph-readiness.js";
import { shouldEscalateSearchCodeToRecon } from "../intelligence/query-shape.js";
import { getCommitTrailers } from "../tracking/git-trailers.js";
import { getPromptsForSession } from "../tracking/prompt-trace.js";
import { createReconDetector } from "../tracking/turn-telemetry.js";
import { UNERR_VERSION } from "../version.js";
import { aliasAndValidate } from "./arg-validator.js";
import { lockAdvertisedCatalog } from "./catalog-lock.js";
// Zero-dependency protocol module — static import keeps the method name and the
// handler on one constant, so the UDS dispatch can never drift from the wire
// contract the hooks send.
import {
  COMPACTION_METHOD,
  type CompactionRequestParams,
  handleCompactionRequest,
} from "./compaction-protocol.js";
import {
  DISPATCH_DEADLINE_MS,
  raceToolExecution,
} from "./dispatch-deadline.js";
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
  resolveResumableSessionId,
} from "./session-stats.js";
import { StartupRenderer } from "./startup-renderer.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tool-definitions.js";
import {
  hiddenToolNames,
  validateAllToolDescriptions,
} from "./tool-descriptions.js";

import { installFileLogger } from "../utils/file-logger.js";
import { formatUnknownError } from "../utils/format-error.js";
import { stringifyMcpToolJson } from "../utils/mcp-content-json.js";
import { nodeUpgradeNotice } from "../utils/node-version.js";
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

/**
 * SIGKILL a wedged proxy pid (already identity-verified by `PidLock.acquire`
 * as a real unerr proxy, never on the plain "secondary" path) and wait for it
 * to fully exit, bounded ~3s. SIGKILL is terminal, so there is nothing to
 * escalate to — this just polls the signal-0 probe until it throws.
 */
async function killAndWaitForExit(
  pid: number,
  timeoutMs = 3_000
): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // exited
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Drift-write duration (ms) above which a `processFiles` call counts as slow. */
export const DRIFT_SLOW_WRITE_MS = 5_000;

/** Cooldown (ms) after a slow drift write before the next drain runs. */
export const DRIFT_COOLDOWN_MS = 30_000;

/**
 * True when the last drift `processFiles` write was slow (> `DRIFT_SLOW_WRITE_MS`)
 * and `now` is still inside its cooldown window. On a large graph (150MB+,
 * 40k+ entities) a single drift write can exceed 60s and stall the shared cozo
 * write path — this backs a drain off instead of piling another write behind it.
 */
export function shouldThrottleDrift(
  lastWriteMs: number,
  cooldownUntil: number,
  now: number = Date.now()
): boolean {
  return lastWriteMs > DRIFT_SLOW_WRITE_MS && now < cooldownUntil;
}

/**
 * Emit `search_code_dispatch` recording whether a `search_code` call
 * escalated to the `unerr_context` recon composite. This is the only
 * denominator for the recon-savings measurement — without it there is no way
 * to tell whether the recon path (vs the lean ranked-name search) is actually
 * being reached. Extracted as a standalone function so the emit/skip logic is
 * unit-testable apart from `dispatchToolCall`. Never load-bearing: any
 * failure here must not affect tool dispatch, and it never writes during
 * `VITEST` runs.
 */
export function recordSearchCodeDispatch(escalated: boolean): void {
  if (process.env.VITEST) return;
  try {
    startupLog.fileOnly("telemetry", "search_code_dispatch", { escalated });
  } catch {
    /* telemetry never load-bearing */
  }
}

export interface ProxyOptions {
  /** Specific repo ID (auto-detected from .unerr/config.json if omitted) */
  repoId?: string;
  /** Enable predictive context pre-fetching */
  prefetch?: boolean;
  /** Running as a daemon-managed child (suppresses startup renderer, PID lock is per-repo) */
  daemonChild?: boolean;
  /** Fired once the per-repo dashboard HTTP server is up (daemon child only). */
  onDaemonReady?: (info: { sock: string; port: number | null }) => void;
  /** Coding-agent id (from `--coding-agent=<id>` install-time flag). Most
   *  authoritative source for agent attribution; stamped on every event
   *  unless a per-client UDS handshake overrides it for that client. */
  codingAgent?: string;
}

type SignalShowStoreType = import(
  "../intelligence/signal-show-store.js"
).SignalShowStore;
let proxyShowStore: SignalShowStoreType | null = null;

// ── Cap A-2: symptom retrieval — trace recall handler ─────────────────────────

/**
 * Extract file-path and identifier anchor candidates from a raw prompt string.
 * Used to populate anchorHints for the code-anchor boost in recallTracesBySymptom.
 */
function extractAnchorHints(prompt: string): string[] {
  const hints: string[] = [];
  // File paths (src/...ts, src/...js, etc.)
  const fileRe = /(?:^|\s)(src\/[^\s<>'"]+(?:\.ts|\.js|\.mjs))/gm;
  for (const m of prompt.matchAll(fileRe)) {
    if (m[1]) hints.push(m[1]);
  }
  // CamelCase / PascalCase identifiers (likely entity keys)
  const identRe = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:[A-Z][a-z]+)+)\b/g;
  for (const m of prompt.matchAll(identRe)) {
    if (m[1]) hints.push(m[1]);
  }
  return hints;
}

/**
 * Handle `unerr_recall_traces` tool calls from the hook subprocess (Cap A-2).
 * Tokenizes the prompt, runs TF-IDF ranked symptom retrieval against the
 * timeline store, and returns the top traces as plain JSON. Degrades silently
 * to an empty list when the timeline or fact store is unavailable.
 */
async function handleUnerrRecallTracesProxy(
  args: Record<string, unknown>,
  timelineStore:
    | import("../timeline/timeline-store.js").CozoTimelineStore
    | null
    | undefined,
  anchorExists?: (anchor: string) => Promise<boolean>,
  onRecalled?: (count: number) => void
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const empty = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, data: { traces: [] } }),
      },
    ],
  };
  if (!timelineStore) return empty;

  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (!prompt) return empty;

  const rawLimit = args.limit;
  const limit =
    typeof rawLimit === "number" ? Math.max(1, Math.min(rawLimit, 5)) : 3;

  try {
    const { tokenize } = await import("../intelligence/search-index.js");
    const { recallTracesBySymptom } = await import(
      "../timeline/trace-recall.js"
    );
    const tokens = tokenize(prompt);
    const anchorHints = extractAnchorHints(prompt);
    const traces = await recallTracesBySymptom(
      timelineStore,
      tokens,
      limit,
      anchorHints,
      anchorExists
    );
    if (Array.isArray(traces) && traces.length > 0) {
      try {
        onRecalled?.(traces.length);
      } catch {
        /* best effort — reporting must never fail the recall */
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, data: { traces } }),
        },
      ],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] unerr_recall_traces failed: ${msg}\n`);
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: false, error: msg }) },
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
  getGraphStats: () => Promise<{
    entityCount: number | null;
    edgeCount: number | null;
  }>;
}> {
  // Mirror stderr to a rotating .log so crash traces during startup land on
  // disk even when the process is detached (DM-3 auto-spawn).
  installFileLogger({
    filePath: join(process.cwd(), ".unerr", "logs", "unerr.log"),
  });

  // Surface startup crashes loudly. Without these handlers a thrown DB
  // schema mismatch (or any sync error inside a top-level await chain) can
  // exit with code=1 silently — unerrd respawns endlessly with no clue.
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `[unerr] FATAL uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `[unerr] FATAL unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`
    );
    process.exit(1);
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
  let lockResult = await pidLock.acquire();

  if (!lockResult.acquired && lockResult.outcome === "wedged") {
    const wedgedPid = lockResult.existingPid;
    log.warn(
      `Wedged proxy PID ${wedgedPid} holds the lock but fails health; killing it before taking over`
    );
    if (wedgedPid !== undefined) {
      await killAndWaitForExit(wedgedPid);
    }
    lockResult = await pidLock.acquire();
  }

  if (!lockResult.acquired) {
    log.info(
      `Proxy already running (PID ${lockResult.existingPid}). Secondary IDEs can connect via UDS at .unerr/state/proxy.sock`
    );
    process.exit(0);
  }

  if (lockResult.outcome === "stale_recovered") {
    log.warn("Recovered from stale PID file (previous proxy crashed)");
  }

  // Warm the real BPE tokenizer off the critical path so the first token count
  // uses gpt-tokenizer (o200k_base) rather than the heuristic fallback. The
  // ~2 MB rank load is synchronous, so defer it past first output (<5s goal).
  setImmediate(() => {
    void import("../intelligence/token-estimator.js").then((m) =>
      m.warmTokenizer()
    );
  });

  startupLog.header();
  startupLog.step(
    `PID ${process.pid} ${startupLog.fmt.muted(`· health localhost:${lockResult.healthPort}`)}`
  );

  // Warn when running below the Node 24 floor. unerr's only SQLite driver is the
  // built-in node:sqlite (stable since Node 24), so below 24 the graph/WAL path
  // cannot open. This runtime notice is the durable channel for the requirement:
  // it survives npm v12 / pnpm install-script lockdown (a postinstall notice
  // would not). See utils/node-version.ts.
  const nodeNotice = nodeUpgradeNotice();
  if (nodeNotice) startupLog.warn(nodeNotice);

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
  // Absolute path to graph.db, hoisted to function scope so the reindex
  // factories and the shutdown path can checkpoint+truncate its WAL (the
  // `dbPath` destructured below is block-scoped to the open-db try).
  let graphDbPath: string | null = null;
  // Absolute path to the other cozo-managed db (timeline.db).
  // cozo-node@0.7.6 exposes no pragma/checkpoint API, so its WAL is truncated
  // out of band: once at boot (a guaranteed reader gap before cozo opens it)
  // and periodically while live via a detached TRUNCATE. Without this it is
  // never checkpointed and its WAL grows unbounded. Hoisted so the periodic
  // timer and shutdown can reach it.
  let timelineDbPath: string | null = null;
  let walCheckpointInterval: ReturnType<typeof setInterval> | null = null;
  let parseIndex: import("./auto-bootstrap.js").ParseModeIndex | null = null;
  // L11: Background indexing flag — hoisted for access after MCP server.connect()
  let needsBackgroundIndex = false;
  // Bug A: distinguishes a genuine cold index (fresh DB / snapshot migration /
  // no snapshot) from a populated persistent graph that should reindex ONLY the
  // files whose content changed since the last pass — or skip entirely. "full"
  // runs the whole pipeline; "incremental-if-stale" defers a staleness check to
  // after the MCP handshake and does the minimum work it finds.
  let indexMode: "full" | "incremental-if-stale" = "full";
  // True when this boot freshly created the repo's graph.db — the repo's
  // first-ever index. Drives the one-time `added` repo_activity event.
  let graphWasNew = false;

  if ((proxyMode as string) !== "parse") {
    const projectRoot = process.cwd();

    try {
      const { openPersistentDb } = await import(
        "../intelligence/persistent-db.js"
      );
      const { db, isNew, dbPath, wasRebuilt } = await openPersistentDb(
        projectRoot,
        {
          // Data-plane wedge backstop: the DB worker's circuit breaker saw
          // sustained consecutive request timeouts — every graph read/write is
          // dead while /health still answers, so the daemon's liveness probe
          // can never catch it. Recycle cleanly via the existing SIGTERM path
          // (handlers are installed below, long before the breaker can trip);
          // the daemon respawns the proxy on the next MCP frame and boot's
          // checkpointWal folds whatever WAL the wedge left behind.
          onPersistentDegradation: (consecutiveTimeouts) => {
            process.stderr.write(
              `[unerr] ✗ graph db data plane wedged (${consecutiveTimeouts} consecutive worker timeouts) — recycling proxy so the daemon respawns it fresh\n`
            );
            process.kill(process.pid, "SIGTERM");
          },
        }
      );
      graphDbPath = dbPath;
      graphWasNew = isNew;

      // timeline.db is cozo-managed and otherwise never checkpointed, so its
      // WAL grows unbounded across sessions. Reset any WAL left by the
      // previous session NOW — cozo's pool for this db is not open yet (the
      // timeline subsystem starts later), so this is a guaranteed reader gap
      // and TRUNCATE succeeds. Then a detached TRUNCATE every few minutes
      // bounds within-session growth by catching live reader gaps.
      // Best-effort: checkpointWal swallows errors and a not-yet-created db
      // is a no-op.
      timelineDbPath = join(projectRoot, ".unerr", "timeline.db");
      const { checkpointWal, checkpointWalDetached } = await import(
        "../intelligence/persistent-db.js"
      );
      await checkpointWal(timelineDbPath);
      const WAL_CHECKPOINT_INTERVAL_MS = 3 * 60_000;
      walCheckpointInterval = setInterval(() => {
        if (timelineDbPath) checkpointWalDetached(timelineDbPath);
        // graph.db also rides the periodic checkpoint, not only the
        // post-reindex one. A reindex-triggered checkpoint that runs DURING a
        // cozo write burst returns busy (reader pinned) and leaves the WAL at
        // its high-water mark; if the repo then goes idle, nothing reclaims it
        // until the next edit. The periodic detached TRUNCATE catches that
        // post-burst reader gap so steady-state graph.db-wal stays bounded.
        if (graphDbPath) checkpointWalDetached(graphDbPath);
      }, WAL_CHECKPOINT_INTERVAL_MS);
      walCheckpointInterval.unref?.();

      // Restart-overlap bridge. The pre-cozo boot checkpoint (createSqliteDb)
      // returns busy when a PREVIOUS proxy for this repo is still exiting and
      // holding graph.db, so a large WAL from the prior session survives the
      // boot and then sits until the first periodic tick — up to one full
      // WAL_CHECKPOINT_INTERVAL_MS where `du` shows the old high-water mark and
      // a fresh restart looks unfixed. Fire one detached checkpoint ~15s in: by
      // then the old proxy has exited and this proxy's readers are idle, so the
      // leftover (already-folded, zero-live-frame) WAL reclaims in seconds.
      const earlyWalCheckpoint = setTimeout(() => {
        if (timelineDbPath) checkpointWalDetached(timelineDbPath);
        if (graphDbPath) checkpointWalDetached(graphDbPath);
      }, 15_000);
      earlyWalCheckpoint.unref?.();

      const { CozoGraphStore } = await import("../intelligence/local-graph.js");
      const graphStart = Date.now();
      localGraph = await CozoGraphStore.create(db);

      const graphOpenMs = Date.now() - graphStart;

      if (!isNew && !wasRebuilt && (await localGraph.isPopulated())) {
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

        // Bug A: the persistent graph already holds every entity, edge,
        // community, convention and rule. Don't pay an unconditional full
        // reindex on every restart — that starves the event loop for tens of
        // seconds and, across several warm-started repos, races the MCP
        // client's request timeout. Defer a content-hash staleness check past
        // the handshake and reindex only the files that actually changed (or
        // skip when none did). See src/intelligence/staleness.ts.
        needsBackgroundIndex = true;
        indexMode = "incremental-if-stale";
        startupLog.step(
          `${startupLog.fmt.muted("Will reindex only changed files after MCP ready (skips when graph is current)")}`
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

          // Snapshot migration populates from stale data — schedule background
          // reindex so the graph reflects current files, orphans are pruned,
          // and the drift overlay is cleared (Phase 6.3 of indexLocalProject).
          needsBackgroundIndex = true;
          log.info(
            "Snapshot migration complete — scheduling background reindex to refresh graph"
          );
          startupLog.step(
            `${startupLog.fmt.muted("Background reindex will refresh graph after MCP ready")}`
          );
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
  // Sprint 2: Wire session events for value counter (Task 2.7)
  router.setSessionEvents(stats.events);

  // CROSS_REPO_INTELLIGENCE Sprint 3: wire the federation coordinator so
  // `scope:'workspace'` and implicit cross-repo path routing can reach sibling
  // repos. Peer discovery + ensure go back through the daemon over UDS; when no
  // daemon is reachable (standalone proxy) the coordinator degrades to home-only.
  // The pro-tier gate lives in the daemon's `peers` handler, so this is wired
  // unconditionally — free tier gets a refusal, not a missing capability.
  // Hoisted to function scope (not the block below) so the unerr/blast_radius
  // control handler can federate the pre-edit cascade (Sprint 6.1).
  let federationCoordinatorRef:
    | import("../intelligence/federation/coordinator.js").FederationCoordinator
    | null = null;
  let monikerIndexRef:
    | import("../intelligence/federation/moniker-index.js").MonikerIndex
    | null = null;
  // CROSS_REPO_INTELLIGENCE Sprint 6.3: assigned once the behavior writer exists
  // (below); refreshMonikerIndex fires it after every index load/reindex so a
  // peer that moved/renamed/deleted an exported symbol surfaces as dangling
  // cross-repo references. Null until wired — the first load triggers it once.
  let runCrossRepoDriftSweep: (() => void) | null = null;
  // Sprint 6.4: live federated peer package names, refreshed by each drift sweep
  // (its fan-out already learns every answering peer's package). Read synchronously
  // by the unerr/blast_radius handler to flag a new import reaching into a sibling
  // repo's internals — no per-edit fan-out. Empty until the first sweep answers.
  const peerPackagesRef = new Set<string>();
  {
    const { createFederationCoordinator } = await import(
      "../intelligence/federation/coordinator.js"
    );
    const {
      daemonSockPath,
      getPeers: getDaemonPeers,
      ensureRepo,
      isEnsureRepoRefused,
    } = await import("../daemon/client.js");
    const federationCoordinator = createFederationCoordinator({
      getPeers: (homeRepo) => getDaemonPeers(daemonSockPath(), homeRepo),
      ensurePeer: async (peer) => {
        try {
          const r = await ensureRepo(daemonSockPath(), peer.path);
          return isEnsureRepoRefused(r) ? null : r.sock;
        } catch {
          return null;
        }
      },
    });
    federationCoordinatorRef = federationCoordinator;
    router.setFederationCoordinator(federationCoordinator);
  }

  // CROSS_REPO_INTELLIGENCE Sprint 4: load this repo's SCIP moniker index so
  // cross-repo `get_references` can name the focus entity across a repo
  // boundary and answer peers' `xref_by_moniker` lookups. Refreshed on every
  // reindex (the orchestrator rewrites the artifact). Absent artifact (no SCIP
  // / not yet indexed) → null, cross-repo references degrade to home-only.
  const refreshMonikerIndex = async (): Promise<void> => {
    try {
      const { readMonikerIndex } = await import(
        "../intelligence/federation/moniker-index.js"
      );
      const index = readMonikerIndex(process.cwd());
      monikerIndexRef = index;
      router.setMonikerIndex(index);
      runCrossRepoDriftSweep?.();
    } catch {
      /* best-effort — a missing/corrupt artifact never breaks startup */
    }
  };
  await refreshMonikerIndex();

  // Sprint S1: Wire output compression & quality loop
  const { createSessionDedup } = await import("./session-dedup.js");
  const { createCompressionQualityMonitor } = await import(
    "./compression-quality-monitor.js"
  );
  const sessionDedup = createSessionDedup({ cwd: process.cwd() });
  const compressionMonitor = createCompressionQualityMonitor();
  router.setSessionDedup(sessionDedup);
  router.setCompressionMonitor(compressionMonitor);

  // Sprint S2: Wire session health monitor
  const { createSessionHealthMonitor } = await import(
    "../intelligence/session-health-monitor.js"
  );
  const healthMonitor = createSessionHealthMonitor();
  router.setHealthMonitor(healthMonitor);

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
          previousSessionEndedAt: previousSession.endedAt
            ? new Date(previousSession.endedAt).getTime()
            : undefined,
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
    const intentTracker = createIntentTokenTracker();
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
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server(
    { name: "unerr-local", version: UNERR_VERSION },
    { capabilities: { tools: {} } }
  );

  // Tool definitions imported from shared tool-definitions.ts (single source of truth)
  const toolDefinitions = [...TOOL_DEFINITIONS];

  // Validate every (tool, state) description against its token budget. Moved
  // off module-load time (tool-descriptions.ts) so `gpt-tokenizer` loads only
  // here, once, instead of on every `unerr` invocation. Runs before the MCP
  // server registers any request handler below, so no tools/list response can
  // ever serve an unvalidated description.
  await validateAllToolDescriptions();

  // The S7 usage-driven cluster reorder (`ToolUsageTracker` +
  // `reorderToolsByCluster`) was removed from the `tools/list` path 2026-07:
  // it re-sorted the advertised catalog by how often each cluster had been
  // called this session, so the serialized tool block — which sits at the front
  // of the provider cache prefix — changed bytes after roughly the third tool
  // call and re-billed the whole context. See `catalog-lock.ts`.

  // Sprint 0: recon-pattern detector — flags when a turn's tool sequence
  // matches the recall→search→outline→read→entity chain that `unerr recon`
  // is meant to collapse. Emits at most once per episode to events.jsonl.
  const reconDetector = createReconDetector();

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
      def = (DEEP_DIVE_TOOL_DEFINITIONS as readonly ToolDef[]).find(
        (t) => t.name === toolName
      );
    }
    if (!def) return null;
    return aliasAndValidate(def, toolArgs);
  };

  // Single-flight guard: concurrent tools/list calls and the fire-and-forget
  // background refresh must not stack duplicate, reindex-contending queries.
  let injectedToolsRefreshInFlight: Promise<void> | null = null;

  // Graph-touching build of the injected tool list. May stall for tens of
  // seconds while the post-boot background reindex (needsBackgroundIndex) holds
  // the CozoDB graph, so callers on the tools/list hot path MUST race it
  // against a budget rather than await it directly (see getInjectedTools).
  // Populates the cache on success; `localGraph` is re-read at call time so a
  // graph swap mid-build is observed.
  async function buildInjectedTools(): Promise<ToolDef[]> {
    const graph = localGraph;
    if (!graph) return toolDefinitions;
    // await import, NOT require(): pure-ESM tsup bundle (require() throws).
    const { injectRuleContext, getBlockRules } = await import(
      "../intelligence/tool-injector.js"
    );

    const currentDeepDiveState = await graph.getDeepDiveProjectState();

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

    const injected = (await injectRuleContext(baseTools, graph)) as ToolDef[];
    cachedInjectedTools = injected;
    cachedBlockRuleKeys = new Set(
      (await getBlockRules(graph)).map((r: { key: string }) => r.key)
    );
    cachedDeepDiveState = currentDeepDiveState;
    return injected;
  }

  // Refresh the enriched cache off the response path. Swallows errors and is
  // single-flighted, so a busy (reindexing) graph just defers the refresh to a
  // later call instead of ever blocking tools/list.
  function refreshInjectedToolsInBackground(): void {
    if (injectedToolsRefreshInFlight) return;
    const graph = localGraph;
    if (!graph) return;
    injectedToolsRefreshInFlight = (async () => {
      try {
        const { needsRefresh } = await import(
          "../intelligence/tool-injector.js"
        );
        const stateChanged =
          (await graph.getDeepDiveProjectState()) !== cachedDeepDiveState;
        if (stateChanged || (await needsRefresh(graph, cachedBlockRuleKeys))) {
          await buildInjectedTools();
        }
      } catch {
        /* non-critical — keep serving the last good cache */
      } finally {
        injectedToolsRefreshInFlight = null;
      }
    })();
  }

  /**
   * Tool list for the `tools/list` response. MUST return promptly — it MUST
   * NOT block on CozoDB. On every snapshot boot the proxy schedules a
   * background full reindex (needsBackgroundIndex, runs "after MCP ready") that
   * holds the graph for tens of seconds; the previous implementation awaited
   * getDeepDiveProjectState()/needsRefresh() on every call (before the cache
   * check), so during that window tools/list exceeded the MCP client's request
   * timeout (-32001), the client registered zero tools, and restarting just
   * re-entered the same window. Strategy:
   *   - cache hit  → return instantly; refresh enrichment off the hot path.
   *   - cache miss → race the build against a short budget; on stall serve the
   *     base definitions now and let the build self-populate the cache for the
   *     next call.
   */
  const COLD_TOOLS_BUILD_BUDGET_MS = 2500;
  async function getInjectedTools(): Promise<ToolDef[]> {
    if (!localGraph) return toolDefinitions;

    if (cachedInjectedTools) {
      refreshInjectedToolsInBackground();
      return cachedInjectedTools;
    }

    // Cold path (cache not yet populated, e.g. right after boot): the build
    // self-populates the cache when it eventually resolves, so even if it loses
    // the race the next call benefits. `.catch` keeps a slow-then-failing build
    // from surfacing as an unhandled rejection after the race already settled.
    const build = buildInjectedTools().catch(() => toolDefinitions);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<ToolDef[]>((resolve) => {
      timer = setTimeout(
        () => resolve(toolDefinitions),
        COLD_TOOLS_BUILD_BUDGET_MS
      );
    });
    try {
      return await Promise.race([build, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Advertisement/validation split (Sprint 8b keystone): the advertised
  // `tools/list` slice drops demoted (hidden) tools, while `toolDefinitions`
  // (used by runBoundaryValidation) and the families registry keep the full
  // catalog. A retired tool stays dispatchable by name (hook UDS path) but
  // never reaches the model's view. Computed once — the hidden set is
  // module-load-stable. `unerr_track` and the mark_* marker tools were
  // removed entirely (2026-07).
  const HIDDEN_TOOL_NAMES = new Set(hiddenToolNames());
  async function getAdvertisedTools(): Promise<ToolDef[]> {
    const tools = await getInjectedTools();
    return HIDDEN_TOOL_NAMES.size === 0
      ? tools
      : tools.filter((t) => !HIDDEN_TOOL_NAMES.has(t.name));
  }

  // stdio `tools/list`. The answer is pinned to the canonical catalog — the
  // exact array `bridge-catalog.ts` serves — so a bridge fallback reply and a
  // proxy reply are byte-identical and neither re-writes the cache prefix.
  // `getAdvertisedTools()` is still evaluated: it keeps the enrichment cache
  // warm and gives `lockAdvertisedCatalog` a real candidate to report on, so a
  // future change that tries to alter the advertised surface (a deep-dive tool
  // appearing, injected rule text, a reorder) is named on stderr instead of
  // silently costing a full context rewrite.
  //
  // Two mutators were removed from this path rather than merely refused:
  //   - `renderToolsListForExposure(gateway.exposedTools())` — tier-2
  //     `get_references` rendered its LOCKED placeholder until an edit or read
  //     unlocked it, then flipped to the active text mid-session. The gateway
  //     still gates DISPATCH (soft-refuse); only the description stops moving.
  //   - `reorderToolsByCluster(..., toolUsageTracker)` — session-usage-ordered.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: lockAdvertisedCatalog(await getAdvertisedTools()),
  }));

  // ── Step 7a: Shadow Ledger + Intent Correlator ─────────────────

  const { ShadowLedger } = await import("../tracking/shadow-ledger.js");
  const { IntentCorrelator } = await import("../tracking/intent-correlator.js");
  const unerrDirForLedger = join(process.cwd(), ".unerr");
  // Warm-restart continuity: when the previous proxy ended within the resume
  // window (dev rebuild+restart, crash, idle bounce), CONTINUE under its
  // session id instead of minting a fresh one. Without this, a restart
  // mid-conversation re-keys the session, so the prompt boundary and the
  // turn's tool events land under different ids and per-turn savings render
  // as 0. See resolveResumableSessionId in session-stats.ts for the window.
  const resumableSessionId = resolveResumableSessionId(stats.previousSession);
  const shadowLedger = new ShadowLedger(
    unerrDirForLedger,
    resumableSessionId ? { sessionId: resumableSessionId } : {}
  );
  const intentCorrelator = new IntentCorrelator(unerrDirForLedger);

  log.info(
    resumableSessionId
      ? `Shadow ledger resumed (session ${shadowLedger.getSessionId().slice(0, 8)}, warm restart)`
      : `Shadow ledger active (session ${shadowLedger.getSessionId().slice(0, 8)})`
  );

  // P0-3: Wire the tier-aware exposure gateway. Owns SessionState +
  // ToolExposureStore + TelemetryRecorder; consulted by QueryRouter on every dispatch.
  const { RouterGateway } = await import("./router-gateway.js");
  const routerGateway = new RouterGateway(
    unerrDirForLedger,
    shadowLedger.getSessionId()
  );
  router.setRouterGateway(routerGateway);

  // P0-5: Rotate stale metrics.jsonl from previous day on startup.
  routerGateway
    .rotateMetrics((err) => {
      log.warn(`Telemetry rotation failed: ${err}`);
    })
    .catch(() => {});

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

  // Reclaim per-session nudge flag files in .unerr/state/. One file is minted
  // per session and nothing else deletes them, so they accreted unbounded (we
  // found 890). A dead session's file is read by nothing, so the sweep deletes
  // every non-active flag file; the live session's file is spared.
  try {
    const { sweepNudgeFlags } = await import("./nudge-state.js");
    const swept = sweepNudgeFlags(process.cwd());
    if (swept > 0) {
      log.info(
        `Nudge-flag sweep: reclaimed ${swept} stale session flag file(s)`
      );
    }
  } catch {
    /* best-effort on boot */
  }

  // Persistent rotation store — timeline.db `signal_shows` relation. Survives
  // restart and coordinates show-counts across parallel `unerr --mcp` sessions
  // in the same repo (per-session rows so writes never contend).
  if (timelineHandle) {
    try {
      const { SignalShowStore } = await import(
        "../intelligence/signal-show-store.js"
      );
      proxyShowStore = new SignalShowStore(
        timelineHandle.store.getDb(),
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

  // ── Layer 10: Token Flow Writer — unified savings attribution ────
  const { TokenFlowWriter } = await import("../tracking/token-flow.js");
  const { resolveAgentId } = await import("../config/agent-registry.js");
  const { detectAgentNameFromEnv } = await import("../utils/detect.js");
  // Canonical turn source: TurnSegmenter inside ShadowLedger. The writer
  // asks for the current turn at record() time so every row stamps the
  // exact turn the agent was in — no more competing counters.
  const sessionTurnProvider = () =>
    shadowLedger
      .getTurnSegmenter()
      .getCurrentTurnNumber(shadowLedger.getSessionId());
  // Initial agent for the standalone (stdio) path. Per-client bridged
  // calls override this via the UDS initialize handshake below.
  const initialAgent = resolveAgentId({
    codingAgent: opts.codingAgent ?? null,
    clientInfoName: null,
    detectFromEnv: () => detectAgentNameFromEnv(),
  });
  const tokenFlowWriter = new TokenFlowWriter(
    unerrDirForLedger,
    shadowLedger.getSessionId(),
    { turnProvider: sessionTurnProvider, agent: initialAgent }
  );
  process.env.UNERR_SESSION_ID = shadowLedger.getSessionId();
  // Exec-process attribution: shell-compressor (spawned from agent shell)
  // reads UNERR_AGENT to stamp the row with the right coding-agent id.
  // UNERR_TURN is updated per-tool-call below so out-of-band exec output
  // attaches to the live turn instead of falling back to 0.
  process.env.UNERR_AGENT = initialAgent;
  // Telemetry producer context (rev-3): install the ambient EmitContext so the
  // global `emit()` every producer calls (shadow ledger, router telemetry,
  // facts, markers, drift, transcripts) writes a contract-shaped line to this
  // repo's `.unerr/events/proxy.jsonl`. Stable process-wide fields only —
  // repoRoot / segment / source / default agent. Per-event session_id,
  // native_session_id, turn, and tool_use_id ride each emit() call because one
  // proxy serves many bridge sessions, so there is no single ambient session.
  // Without this, emit() no-ops and every global-emit producer silently drops.
  // repo / branch / commit are stamped at drain from the daemon's push context.
  configureEmit({
    repoRoot: process.cwd(),
    segment: PROXY_SEGMENT,
    source: `unerr-cli@${UNERR_VERSION}`,
    agent: initialAgent,
  });
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
  // Mirror the live turn to a file the same way session.id is mirrored above.
  // Exec processes (shell compressor, hook-runner) are spawned by the IDE
  // shell, not the proxy, so they never inherit the proxy's UNERR_TURN env
  // update — without this file every shell-compression row stamps turn=0.
  // `persistLiveTurn` is called at the tools/call boundary below; it only
  // touches disk when the turn actually advances (≤ once per turn, not per
  // tool call), keeping the dispatch path off the synchronous-write hot loop.
  const currentTurnPath = join(unerrDirForLedger, "state", "current.turn");
  let lastPersistedTurn = -1;
  const persistLiveTurn = (turn: number): void => {
    if (turn === lastPersistedTurn) return;
    lastPersistedTurn = turn;
    try {
      fsWriteFileSync(currentTurnPath, String(turn), "utf-8");
    } catch {
      /* best effort — env var UNERR_TURN remains the primary channel */
    }
  };
  persistLiveTurn(sessionTurnProvider());
  router.setTokenFlow(tokenFlowWriter);
  efficiencyTracker = createEfficiencyTracker(tokenFlowWriter);
  router.setEfficiencyTracker(efficiencyTracker);

  // Behavior events writer — verb-noun counters for PREVENT-class wins
  // (graph_query_served, loop_broken, cascade_guard, drift_consumed, ...).
  // Pairs with TokenFlowWriter (COMPRESS-class) for the full picture.
  const { BehaviorEventWriter } = await import(
    "../tracking/behavior-events.js"
  );
  const behaviorEventWriter = new BehaviorEventWriter(
    unerrDirForLedger,
    shadowLedger.getSessionId(),
    { turnProvider: sessionTurnProvider, agent: initialAgent }
  );
  router.setBehaviorEvents(behaviorEventWriter);

  // SESSION_ID_CORRELATION: per-bridge session identity. One proxy serves N
  // bridges (one per coding-agent conversation) over UDS; the single
  // ShadowLedger session id can no longer name a conversation. The registry
  // resolves each `clientId` to the per-bridge UUID the bridge announced in
  // `unerr/hello`, and attaches the agent's own `native_session_id` (written to
  // the shared sessions file by the prompt hook) so proxy-side and hook-side
  // events of one conversation group under the same key. Falls back to the
  // ledger's session id for the standalone (stdio, no-clientId) path.
  const { ProxySessionRegistry } = await import("./session-registry.js");
  const sessionRegistry = new ProxySessionRegistry(
    unerrDirForLedger,
    shadowLedger.getSessionId()
  );

  // CROSS_REPO_INTELLIGENCE Sprint 6.3: wire the cross-repo drift sweep now that
  // the behavior writer exists. Each call fans the batch `moniker_def` query out
  // to peers (Pro tier; free refuses → no-op) and records a `cross_repo_drift`
  // event when a referenced peer symbol no longer resolves. Fire-and-forget so a
  // slow/unreachable peer never blocks startup or a reindex swap; refreshMonikerIndex
  // invokes it after every index load. The initial load above ran before this
  // assignment, so kick one sweep here to cover that first index.
  runCrossRepoDriftSweep = () => {
    void (async () => {
      try {
        const { detectCrossRepoDrift } = await import(
          "../intelligence/federation/cross-repo-drift.js"
        );
        const drift = await detectCrossRepoDrift(
          monikerIndexRef,
          federationCoordinatorRef,
          process.cwd()
        );
        // Sprint 6.4: cache the live sibling package set for the import-breach
        // check. Replace wholesale so a peer that left the workspace drops out.
        peerPackagesRef.clear();
        for (const pkg of drift.peerPackages) peerPackagesRef.add(pkg);
        if (drift.dangling.length === 0) return;
        behaviorEventWriter.record({
          session_id: behaviorEventWriter.sessionId,
          type: "cross_repo_drift",
          tool: null,
          entity_key: null,
          response_bytes: null,
          detail: {
            dangling: drift.dangling.length,
            partial: drift.partial,
            findings: drift.dangling.slice(0, 10).map((d) => ({
              moniker: d.moniker,
              package: d.package,
              name: d.name,
              sites: d.sites,
            })),
          },
        });
      } catch {
        /* best-effort — a drift sweep never breaks the proxy */
      }
    })();
  };
  runCrossRepoDriftSweep();

  // Emit a single cross_session_resume event at boot when this proxy run
  // is resuming a prior session. Drives Surface 1 attribution + footer
  // ("loaded earlier session").
  if (stats.isResumedSession && stats.previousSession) {
    behaviorEventWriter.record({
      session_id: behaviorEventWriter.sessionId,
      turn: 0,
      type: "cross_session_resume",
      tool: null,
      entity_key: null,
      response_bytes: null,
      detail: {
        prior_tool_calls: stats.previousSession.toolCallsLocal,
        prior_duration_minutes: stats.previousSession.durationMinutes,
        retrieved: [{ kind: "resume" }],
        returned_count: 1,
        used: true,
      },
    });

    // Mirror the resume strip into instruction-only agents (Cursor,
    // Cline, Codex, Gemini CLI, GitHub Copilot CLI). Claude Code gets
    // it live via the SessionStart hook; these agents have no hook
    // surface, so we drop the strip into a file the IDE auto-loads.
    // Best-effort and non-blocking — boot does not wait on this.
    (async () => {
      try {
        const { writeSessionStateForAllAgents } = await import(
          "./session-state-writer.js"
        );
        await writeSessionStateForAllAgents(process.cwd(), {
          unerrDir: unerrDirForLedger,
        });
      } catch {
        /* best-effort — instruction-only agents fall back to file-mod heuristics */
      }
    })();
  }

  // Bridge defuddle suppression into the BehaviorEventWriter so the dashboard
  // shows how often nwsapi rejects one of defuddle's selectors (a non-fatal
  // log-noise source). First occurrence per signature prints one summary
  // line to stderr; every occurrence — including the first — increments the
  // counter so trend lines stay accurate.
  const { setDefuddleNoiseSink } = await import("../tools/web/extract.js");
  setDefuddleNoiseSink((signature, firstOccurrence) => {
    behaviorEventWriter.record({
      session_id: behaviorEventWriter.sessionId,
      turn: stats.toolCallsLocal,
      type: "defuddle_selector_skipped",
      tool: "fetch_url",
      entity_key: null,
      response_bytes: null,
      detail: { signature, first_occurrence: firstOccurrence },
    });
  });

  // C3 line_survival_rollup producer. Daily, network-free git arithmetic
  // counting (per author cohort × 30/90d window) lines authored vs lines
  // still present in HEAD, written as behavior_events rows the cloud-push
  // behavior drainer copies through the HR-2 firewall (counts/enums only).
  // Same cadence/shape as the ST-6 ledger-archive job above.
  const [{ computeAndRecordLineSurvival }, { openMetricsStore }] =
    await Promise.all([
      import("../tracking/line-survival.js"),
      import("../tracking/metrics-store.js"),
    ]);
  const lineSurvivalIntervalMs = 24 * 60 * 60_000;
  const runLineSurvival = () => {
    void computeAndRecordLineSurvival({
      cwd: process.cwd(),
      sink: openMetricsStore(unerrDirForLedger),
      sessionId: behaviorEventWriter.sessionId,
      agent: initialAgent,
    }).catch((err: unknown) => {
      log.warn(
        `Line-survival rollup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  };
  const lineSurvivalInterval = setInterval(
    runLineSurvival,
    lineSurvivalIntervalMs
  );
  // Fire once on boot so the first session contributes a rollup without
  // waiting a full day. Best-effort and non-blocking.
  runLineSurvival();

  // Repo-lifecycle telemetry — spool a `started` repo_activity event (and, on
  // the repo's first-ever index, an `added`) carrying the unerr-standpoint
  // profile, so the cloud gets a true timeline of this repo's life with unerr.
  // Best-effort and non-blocking: the emit never delays boot, and a graph
  // that's still warming yields a row without a profile rather than an error.
  void (async () => {
    if (!localGraph) return;
    const { emitRepoActivity } = await import("../tracking/repo-activity.js");
    const store = openMetricsStore(unerrDirForLedger);
    const context = {
      agent: initialAgent,
      sessionId: behaviorEventWriter.sessionId,
    };
    if (graphWasNew) {
      await emitRepoActivity(store, "added", { graph: localGraph, context });
    }
    await emitRepoActivity(store, "started", { graph: localGraph, context });
  })().catch(() => {
    /* lifecycle telemetry is best-effort — never surface to the user */
  });

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

  // Unerr session ids that have already emitted an `agent_attached`
  // repo_activity event, so a bridge reconnect doesn't double-count one
  // coding-agent conversation as two attaches.
  const attachedSessions = new Set<string>();

  // ── Layer 4: Behavior Engine (BA-1 + BA-2 + BA-3) ──────────────

  const { BehaviorDispatcher } = await import("../behaviors/framework.js");
  const { LoopCircuitBreaker } = await import("../behaviors/loop-breaker.js");
  // Three behaviors retired in the 2026-05 behavior-automation audit, all
  // because their dispatcher-driven edit gates never fired (edits are Claude
  // Code client tools — Edit/Write — that never traverse the MCP path the
  // dispatcher sees) and their work is now done by process-agnostic engines
  // invoked from the pre-/post-edit hooks:
  //   - session-continuity → superseded by generateSessionResumePayload
  //     (session-persistence.ts) which emits the visible [unerr:session-resume].
  //   - cascade-guard → superseded by edit-impact.ts (computeEditImpact) over
  //     the unerr/blast_radius UDS method, queried by the pre-edit hook.
  //   - architecture-guard → superseded by boundary-check.ts
  //     (computeBoundaryViolations), folded into the same UDS round-trip.
  const { IncompleteWorkDetector } = await import(
    "../behaviors/incomplete-work.js"
  );

  const behaviorDispatcher = new BehaviorDispatcher();

  const loopBreaker = new LoopCircuitBreaker();
  behaviorDispatcher.register(loopBreaker);

  // P2.2: scope the edit-log to this proxy lifetime — the post-edit hook
  // appends edits during the session; onSessionEnd reconciles them. Clearing at
  // boot means a fresh session never inherits a prior session's edits.
  const { clearEditLog } = await import("../tracking/session-edit-log.js");
  clearEditLog(unerrDirForLedger);

  const incompleteWork = new IncompleteWorkDetector();
  incompleteWork.setUnerrDir(unerrDirForLedger);
  if (localGraph) incompleteWork.attachGraph(localGraph);
  incompleteWork.setBehaviorEvents(behaviorEventWriter);
  behaviorDispatcher.register(incompleteWork);

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
  // ══════════════════════════════════════════════════════════════════
  // Unified tools/call dispatch — SINGLE source of truth.
  //
  // BOTH the stdio handler (directly-connected client) and the UDS handler
  // (bridged IDE via `unerr --mcp`) route every tools/call through this one
  // function. Previously each transport re-implemented the ~300-line dispatch
  // chain, and the two had silently DIVERGED: the UDS path skipped pre/post
  // behavioral hooks, narrative capture, pattern analysis, auto-snapshot, and
  // session_resumed injection. Bridged clients are the PRIMARY real-world path,
  // so that divergence meant the guardrail behaviors never ran for most users.
  // Collapsing to one closure fixes both the "forgot to mirror dispatch →
  // Unknown tool" footgun and the behavioral divergence. Graph tools still flow
  // through QueryRouter.execute; non-graph tools (markers, recall_notes,
  // turn_summary, surface2, facts, deep-dive) are intercepted here as before.
  // `ctx.clientId` is set only for UDS clients → threads into ledger attribution.
  // ══════════════════════════════════════════════════════════════════
  async function dispatchToolCall(
    requestedName: string,
    requestedArgs: Record<string, unknown>,
    ctx: { clientId?: string }
  ): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
    _meta?: unknown;
    _context?: unknown;
  }> {
    // Mutable locals so a task-shaped search_code call can re-target the
    // dispatch to unerr_context without reassigning the parameters
    // (noParameterAssign). All code below reads these.
    let name = requestedName;
    let args = requestedArgs;
    // Advance the canonical turn counter at the tools/call boundary so
    // every writer.record() inside this dispatch stamps the correct turn
    // before ShadowLedger.record() (which happens AFTER tool execution).
    shadowLedger.getTurnSegmenter().noteTurnOpen(shadowLedger.getSessionId());
    // Mirror live turn into env so out-of-band exec processes (shell
    // compressor, hook-runner) attach their rows to the active turn. Env
    // reaches only proxy-spawned children; persistLiveTurn mirrors it to
    // state/current.turn so IDE-spawned exec processes can read it too.
    const liveTurn = sessionTurnProvider();
    process.env.UNERR_TURN = String(liveTurn);
    persistLiveTurn(liveTurn);

    // SESSION_ID_CORRELATION: resolve this client's conversation identity once
    // per dispatch. `session_id` is the per-bridge UUID announced in
    // `unerr/hello`; `native_session_id` is the agent's own id (written to the
    // shared sessions file by the prompt hook). Both ride every writer.record()
    // below so proxy-side and hook-side rows of one conversation group under
    // `coalesce(native_session_id, session_id)`. Falls back to the ledger id on
    // the standalone (no-clientId) path.
    const sessionIdentity = sessionRegistry.resolve(
      ctx.clientId,
      process.cwd()
    );

    // ── search_code recon escalation: task-shaped query → unerr_context ──
    // A bare-symbol query keeps the lean ranked-name search (the cheap default
    // that protects the E.1 prefix baseline); a natural-language task query
    // ("where is retry handled", "add a retry to the boot path") re-targets to
    // the recon composite so the agent gets notes + bodies + callers +
    // conventions in ONE call instead of a search→read→search fan-out. This is
    // the adoption fix: the recon path is now reached through the tool the agent
    // already reaches for, not an opt-in second tool. Any explicit profile flag
    // (detail/include_body/want) means "resolve ONE entity" — keep that lean.
    // `scope:'workspace'` keeps the lean federated search (unerr_context does
    // not fan out to siblings). Re-targeting before boundary validation lets the
    // unerr_context `prompt` requirement be satisfied by the carried query.
    if (name === "search_code") {
      const escalateToRecon = shouldEscalateSearchCodeToRecon(args);
      recordSearchCodeDispatch(escalateToRecon);
      if (escalateToRecon) {
        // Task-shaped query, no overriding intent → re-target to the recon
        // composite so the agent gets notes + bodies + callers + conventions
        // in ONE call. The predicate excludes profile flags, workspace scope,
        // AND an explicit `mode:'literal'|'regex'` content search (which must
        // run as a file scan, never silently become an entity recon bundle).
        name = "unerr_context";
        args = { ...args, prompt: args.query };
      }
    }

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
      // Fire post-tool behaviors on the failing call so the loop detector can
      // count repeated bad-arg failures and emit a redirect at threshold.
      // Tool calls that execute and return isError:true already reach
      // firePostToolUse at ~line 3280 — validation failures returned before
      // that point, so this fires exactly once per failure (no double-count).
      const valErrText = JSON.stringify(validationFailure);
      const valPostCtx = {
        toolName: name,
        args,
        sessionId: shadowLedger.getSessionId(),
        entityKey: (args.key as string) ?? (args.entity as string) ?? undefined,
        filePath:
          (args.path as string) ??
          (args.file_path as string) ??
          (args.file as string) ??
          undefined,
        result: {
          isError: true,
          content: [{ type: "text", text: valErrText }],
        },
      };
      const valPostOutput =
        await behaviorDispatcher.firePostToolUse(valPostCtx);
      return {
        content: [{ type: "text", text: valErrText }],
        isError: true,
        ...(valPostOutput?._context
          ? { _context: valPostOutput._context }
          : {}),
        ...(valPostOutput?._meta ? { _meta: valPostOutput._meta } : {}),
      };
    }

    // Sprint 0: emit one recon-pattern event per episode (file-only — no
    // stderr, so it never enters the agent's tool-result context).
    const reconEvent = reconDetector.note(name);
    if (reconEvent) {
      startupLog.fileOnly("telemetry", "recon_pattern_hit", {
        ...reconEvent,
        session_id: shadowLedger.getSessionId(),
      });
    }

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
      // PREVENT-class: a behavior halted the tool call before it ran. We
      // cannot honestly measure "what the halted call would have cost" —
      // the old `avoidedTokens = 3200` constant was a fabrication. Record
      // a discrete intervention event instead so the dashboard surfaces
      // *what was prevented*, not a guessed token number.
      behaviorEventWriter.record({
        session_id: sessionIdentity.sessionId,
        native_session_id: sessionIdentity.nativeSessionId,
        turn: stats.toolCallsLocal + 1,
        type: "intervention_halted",
        tool: name,
        entity_key: behaviorCtx.entityKey ?? behaviorCtx.filePath ?? null,
        response_bytes: preOutput._context
          ? JSON.stringify(preOutput._context).length
          : null,
        detail: {
          behavior_id: preOutput.behaviorId,
          policy: preOutput.behaviorId,
          action: "halted",
          ...(typeof preOutput._context?.reason === "string"
            ? { reason: preOutput._context.reason }
            : {}),
          ...(behaviorCtx.filePath
            ? { target_file: behaviorCtx.filePath }
            : {}),
          ...(behaviorCtx.entityKey
            ? { target_entity: behaviorCtx.entityKey }
            : {}),
        },
      });

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

    // ── Cap A-2: symptom retrieval (trace recall) ──
    if (name === "unerr_recall_traces") {
      return handleUnerrRecallTracesProxy(
        args,
        timelineHandle?.store,
        // Staleness gate: a past incident whose anchor no longer resolves in
        // this repo's graph is history about deleted code — not injected.
        (anchor: string) => router.anchorExists(anchor),
        // Cap A reporting: record one `trace_recalled` per recall that surfaced
        // ≥1 past incident, so the receipt's Remembered recap credits the reuse.
        (count: number) => {
          behaviorEventWriter.record({
            session_id: sessionIdentity.sessionId,
            native_session_id: sessionIdentity.nativeSessionId,
            turn: stats.toolCallsLocal + 1,
            type: "trace_recalled",
            tool: "unerr_recall_traces",
            entity_key: null,
            response_bytes: null,
            detail: { count },
          });
        }
      );
    }

    // ── Warm recon composite: unerr_context (Sprint 1b) ──
    // Mirrors `unerr recon` in-process: one call collapses the discovery
    // fan-out (search + references + conventions). Graph shapes come raw via
    // router.executeRaw.
    if (name === "unerr_context") {
      const { handleUnerrContextProxy } = await import(
        "./unerr-context-handler.js"
      );
      const contextResult = await handleUnerrContextProxy(
        args as Record<string, unknown>,
        {
          runRaw: (tool, toolArgs) => router.executeRaw(tool, toolArgs),
          repoCwd: dirname(unerrDirForLedger),
          // E4 Layer A sink: surface the modeled round-trip savings as the
          // SavingsOriginSplit "context bundling" origin (token_flow_event, sync)
          // and as the §4 accounting row (compression_event, event_kind
          // 'context_bundle'). The token_flow detail carries the Layer-B manifest
          // (delivered/expand keys) for the post-hoc reconciliation route.
          recordBundleSavings: (model) => {
            tokenFlowWriter.record({
              session_id: sessionIdentity.sessionId,
              native_session_id: sessionIdentity.nativeSessionId,
              mechanism: "context_bundle",
              tool: "unerr_context",
              tokens_without: model.original_tokens,
              tokens_with: model.delivered_tokens,
              tokens_saved: model.rerequest_saved_tokens,
              detail: {
                sources_collapsed: model.sources_collapsed,
                round_trips_modeled: model.round_trips_modeled,
                expand_items: model.expand_items,
                manifest_items: model.manifest_items,
                delivered_entity_keys: model.delivered_entity_keys,
                delivered_files: model.delivered_files,
                expand_keys: model.expand_keys,
              },
            });
            // Fire-and-forget: the compression-log import is async; a throw is
            // swallowed (telemetry is never load-bearing).
            void (async () => {
              try {
                const { appendCompressionLog } = await import(
                  "./shell-compression-log.js"
                );
                appendCompressionLog(dirname(unerrDirForLedger), {
                  ts: new Date().toISOString(),
                  command: "unerr_context",
                  category: "context_bundle",
                  confidence: 1,
                  rawBytes: model.original_tokens,
                  compressedBytes: model.delivered_tokens,
                  savedPct:
                    model.original_tokens > 0
                      ? Math.max(
                          0,
                          model.rerequest_saved_tokens / model.original_tokens
                        )
                      : 0,
                  omniFallback: false,
                  reversible: {
                    original_tokens: model.original_tokens,
                    delivered_tokens: model.delivered_tokens,
                    mechanism: "context_bundle",
                    event_kind: "context_bundle",
                  },
                });
              } catch {
                /* telemetry never load-bearing */
              }
            })();
          },
        }
      );
      // No-graph escape hatch: recon composes search_code + get_references
      // under the hood, so an absent or below-threshold graph makes this call
      // as worthless as calling search_code directly — same signal, same gate.
      const { applyNoGraphEscapeHatch } = await import(
        "../intelligence/query-router.js"
      );
      return applyNoGraphEscapeHatch(contextResult, dirname(unerrDirForLedger));
    }

    // ── Close-out summary: unerr_turn_summary ──
    if (name === "unerr_turn_summary") {
      const { handleTurnSummaryProxy } = await import(
        "./turn-summary-handler.js"
      );
      return handleTurnSummaryProxy(
        unerrDirForLedger,
        shadowLedger.getSessionId(),
        sessionTurnProvider()
      );
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
          {
            tool: name,
            source: "local",
            ...(ctx.clientId ? { client: ctx.clientId } : {}),
          },
          branch,
          headSha
        );
        return deepDiveResult;
      }
    }

    // ── Edit/write tool (file_edit — one tool, edit + whole-file write modes) ──
    // The unerr-owned edit path (OWN_EDIT_TOOL.md B4). Runs in THIS process, so
    // it never needs the host agent's read-tracking gate the way the built-in
    // Edit/Write do. These are not graph queries, so they bypass
    // QueryRouter.execute and its read-enrichment entirely — they carry their
    // own correctness (quote-tolerant match, staleness guard, encoding/CRLF
    // preservation) in edit-core.ts. The blast-radius / signature gate is
    // PRESERVED out-of-band: the Claude Code PreToolUse hook matches `file_edit`
    // (claude-settings-hooks.ts) and denies-once when callers are at risk,
    // exactly as it does for the built-in Edit. The rendered diff is written
    // out-of-band to the file log; the tool_result is a one-line confirmation.
    if (name === "file_edit") {
      const { fileEditTool } = await import("../tools/coding/index.js");
      const t0 = performance.now();
      const out = await fileEditTool.execute(args, {
        cwd: process.cwd(),
        graph: localGraph ?? undefined,
      });
      const text =
        typeof out.content === "string"
          ? out.content
          : stringifyMcpToolJson(out.content);

      recordToolCall(stats);
      recordLatency(stats.latency, performance.now() - t0);
      pidLock.recordToolCall();

      // Shadow-ledger the edit + capture the edit narrative (Sprint 4), so the
      // unerr-owned edit path feeds the same timeline as the built-in editor.
      const branch = branchContext?.currentBranch ?? "unknown";
      const headSha = branchContext?.headSha ?? "";
      shadowLedger.record(
        name,
        args,
        {
          tool: name,
          source: "local",
          edited: out.isError !== true,
          ...(ctx.clientId ? { client: ctx.clientId } : {}),
        },
        branch,
        headSha
      );
      // Record the edit so the deterministic end-of-turn "files changed" receipt
      // can list every file touched this turn with its line numbers — host-emitted
      // (Stop hook), so it never depends on the model echoing the change. The tool
      // returns metadata.edit_summary (out-of-band, filtered from model context).
      const editSummary = (
        out.metadata as { edit_summary?: Record<string, unknown> } | undefined
      )?.edit_summary;
      if (out.isError !== true && editSummary) {
        behaviorEventWriter.record({
          session_id: sessionIdentity.sessionId,
          native_session_id: sessionIdentity.nativeSessionId,
          turn: stats.toolCallsLocal + 1,
          type: "code_edit_applied",
          tool: name,
          entity_key:
            typeof editSummary.file === "string" ? editSummary.file : null,
          response_bytes: null,
          detail: {
            file_path: editSummary.file,
            mode: editSummary.mode,
            added: editSummary.added,
            removed: editSummary.removed,
            ranges: editSummary.ranges,
          },
        });
      }

      return {
        content: [{ type: "text", text }],
        ...(out.isError ? { isError: true } : {}),
      };
    }

    // MCP tools: Layer 6 wire formats (columnar / json) are applied inside QueryRouter.execute.
    // Wrap in try/catch so any throw lands as isError:true on the wire
    // instead of the SDK's generic JSON-RPC error, which some clients
    // surface less prominently than a tool-level error.
    let result: Awaited<ReturnType<typeof router.execute>>;
    try {
      // Dispatch-level hard deadline (defense-in-depth). A tool that defeats its
      // own internal deadline (e.g. an offline fetch_url whose AbortController
      // never interrupts a stalled DNS/connect syscall) must not hang until the
      // MCP client's ~1800s abort and burn the whole agent-task budget. On
      // deadline we return a degraded, agent-actionable result and RETURN EARLY —
      // skipping every post-tool side effect (stats, ledger, behaviors) so the
      // timed-out call is never counted or double-fired. The abandoned execute
      // promise settles in the background; its late result is discarded.
      // `sessionIdentity` scopes per-conversation router state (file-body dedup)
      // to the client that made THIS call — threaded as an argument, never
      // parked on the router, so two concurrent MCP sessions can't read each
      // other's deliveries.
      const outcome = await raceToolExecution(
        router.execute(name, args, sessionIdentity),
        name
      );
      if (outcome.timedOut) {
        process.stderr.write(
          `[unerr] router.execute(${name}) exceeded ${DISPATCH_DEADLINE_MS}ms dispatch deadline — returning degraded result\n`
        );
        return outcome.degraded;
      }
      result = outcome.result;
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
    if (ctx.clientId) {
      resultSummary.client = ctx.clientId;
    }
    shadowLedger.record(name, args, resultSummary, branch, headSha);

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
    // Fault-2 repair: the `preOutput.halt` branch above is the ONLY consumer
    // of pre-tool behavior output — advisory (non-halt) pre-tool signals were
    // otherwise computed and dropped. Fold their _context/_meta in here so
    // pre-tool behaviors surface alongside post-tool output. Post-tool output
    // is merged after, so it wins on any key conflict.
    if (preOutput && !preOutput.halt) {
      if (preOutput._context) {
        contextPayload = { ...contextPayload, ...preOutput._context };
      }
      if (preOutput._meta) Object.assign(meta, preOutput._meta);
      // Cap B reporting: the loop-breaker's pre-trip redirect (halt:false) is
      // the only non-halting preOutput that carries a circuit_breaker block.
      // Record it as a `loop_redirect` behavior event so the receipt's
      // Flagged/Prevented recap surfaces the soft nudge — distinct from the
      // hard `loop_broken` the circuit trip records in QueryRouter.
      const cb = (preOutput._meta as Record<string, unknown> | undefined)
        ?.circuit_breaker as
        | { entity?: string; attempts?: number; message?: string }
        | undefined;
      if (preOutput.behaviorId === "loop_circuit_breaker" && cb) {
        behaviorEventWriter.record({
          session_id: sessionIdentity.sessionId,
          native_session_id: sessionIdentity.nativeSessionId,
          turn: stats.toolCallsLocal + 1,
          type: "loop_redirect",
          tool: name,
          entity_key: cb.entity ?? behaviorCtx.entityKey ?? null,
          response_bytes: null,
          detail: {
            policy: "loop_breaker",
            action: "redirected",
            attempts: cb.attempts ?? 0,
            ...(cb.entity ? { target_entity: cb.entity } : {}),
            ...(typeof cb.message === "string" ? { reason: cb.message } : {}),
          },
        });
      }
    }
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
    // file_read's three modes (full/range/entity) are plain, built-in-style
    // output — no `ur|`-prefixed signal line rides on file content.
    const signalFooter =
      name === "file_read"
        ? ""
        : buildSignalPrefix(
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

    // A3: Tier-1 in-band auth surfacing. Read the local auth state (no daemon
    // round-trip, no keychain) and attach the one `ur|act`/`ur|fct` line the
    // state warrants — deduped once per session per state via the shared
    // signal table. Never breaks a response: any failure yields no auth line.
    let authBlock = "";
    try {
      const { authState } = await import("../cloud/auth-state.js");
      const { authSurfaceSignal } = await import("../cloud/auth-surface.js");
      const sig = authSurfaceSignal(authState());
      if (sig) {
        const { getSignalDedup } = await import("./signal-dedup.js");
        if (
          getSignalDedup().shouldEmit(
            sig.tag,
            `auth:${sig.dedupKey}`,
            sig.content
          )
        ) {
          authBlock = `\nur|${sig.tag} ${sig.content}`;
        }
      }
    } catch {
      /* auth surfacing is best-effort — never break a tool response */
    }

    // U3: Tier-1 in-band auto-update surfacing. Render the persisted update
    // state (applied / available-not-auto-applying / rolled-back) into the one
    // `ur|act`/`ur|fct` line it warrants — deduped once per session per event
    // via the shared signal table. Best-effort: any failure yields no line.
    let updateBlock = "";
    try {
      const { updateSignal, shouldSurfaceAvailable } = await import(
        "../update/update-surface.js"
      );
      const sig = updateSignal();
      if (sig) {
        // The "available" line (notify-only install / policy notify) carries a
        // persistent daily throttle on top of the session dedup, so a Homebrew/
        // Volta user is not nagged every session. Applied/rolled-back stay on
        // the session dedup alone.
        const isAvailable = sig.dedupKey.startsWith("available:");
        let surface = true;
        let persistAvailable: (() => void) | null = null;
        if (isAvailable && sig.version) {
          const { readUpdateState, writeUpdateState } = await import(
            "../update/update-state.js"
          );
          const now = Date.now();
          const ver = sig.version;
          if (shouldSurfaceAvailable(readUpdateState(), ver, now)) {
            persistAvailable = () =>
              writeUpdateState({
                available_notified_at: now,
                available_notified_version: ver,
              });
          } else {
            surface = false;
          }
        }
        if (surface) {
          const { getSignalDedup } = await import("./signal-dedup.js");
          if (
            getSignalDedup().shouldEmit(
              sig.tag,
              `update:${sig.dedupKey}`,
              sig.content
            )
          ) {
            updateBlock = `\nur|${sig.tag} ${sig.content}`;
            persistAvailable?.();
          }
        }
      }
    } catch {
      /* update surfacing is best-effort — never break a tool response */
    }

    // Surface 2/3 tracking (user-prose channel): the call is retained ONLY
    // for its internal side-effects — per-turn state and the resume-blocker
    // behavior event that feed session tracking and the Stop-hook receipt.
    // Its rendered head/tail are intentionally NOT spliced into the tool
    // response: the `unerr » primed …` preface and the resume strip are
    // display the Stop-hook receipt already owns, and every character in a
    // tool payload is billed to the agent's context on this turn and every
    // cached turn after. See CLAUDE.md "MCP tool responses cost tokens —
    // send only the answer".
    const { buildUserBlockForResponse } = await import(
      "./user-block-emitter.js"
    );
    await buildUserBlockForResponse({
      unerrDir: join(process.cwd(), ".unerr"),
      sessionId: shadowLedger.getSessionId(),
      toolCallCount: router.sessionContext.getToolCallCount(),
      filePath:
        ((args as Record<string, unknown>).file_path as string | undefined) ??
        entityKey,
      isResumedSession: stats.isResumedSession,
      timelineStore: timelineHandle?.store,
      behaviorEvents: behaviorEventWriter,
    });

    // Final assembly: data → page-hint → signal footer → auth + update
    // lines. No preface/resume strip — see the note above.
    const finalText =
      bodyText + bodyEnd + pageBlock + footerBlock + authBlock + updateBlock;

    // P0-3: A soft-refused (locked) tool call surfaces as a tool error
    // so every known MCP client (Cursor, Cline, Codex, Claude Code)
    // routes the body text into the model's view, not the framework's
    // silent retry path.
    const isGateLocked =
      (result._meta as Record<string, unknown>).gate_status === "locked";

    return {
      content: [{ type: "text", text: finalText }],
      ...(isGateLocked ? { isError: true } : {}),
    };
  }

  server.setRequestHandler(
    CallToolRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (request: any) => {
      const { name, arguments: args = {} } = request.params;
      return await dispatchToolCall(
        name,
        (args ?? {}) as Record<string, unknown>,
        {}
      );
    }) as any
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  lifecycle.send({ type: "INDEX_COMPLETE" });
  lifecycle.send({ type: "MCP_READY" });

  // After an auto-update, this freshly-spawned (new-version) proxy re-asserts
  // unerr's install footprint for every agent already configured in this repo —
  // so a changed MCP entry / instruction block / skill set lands without the
  // user re-running `unerr install`. Self-gating on a per-repo version marker
  // (no-op when unchanged), fire-and-forget after the server is serving so it
  // never delays first output, and never throws.
  void import("../config/agent-reinstall.js")
    .then((m) => m.refreshAgentInstallsIfUpgraded(process.cwd()))
    .then((r) => {
      if (r && r.refreshed.length > 0) {
        startupLog.done(
          `Refreshed unerr install for ${r.refreshed.join(", ")} (${r.fromVersion ?? "unknown"} → ${r.toVersion})`
        );
      }
    })
    .catch(() => {
      /* best-effort — install refresh never blocks the proxy */
    });

  // ── Step 7a-2: UDS Transport for Multi-Client (Task 7.2) ──────

  const { TransportMux } = await import("./transport-mux.js");
  const sockPath = join(stateDir, "proxy.sock");
  const transportMux = new TransportMux(sockPath);

  /** Map clientId → agent name (captured from MCP initialize handshake) */
  const agentNameByClient = new Map<string, string>();

  // Sprint 10.5: Add custom HTTP handler for /commit-context (git trailer injection)
  transportMux.setCustomHttpHandler("/commit-context", (_url) => {
    const branch = branchContext?.currentBranch ?? "unknown";
    const timelineBranch = workingSnapshotStore.getTimelineBranch();
    const trailers = getCommitTrailers(shadowLedger, timelineBranch, branch);
    return JSON.stringify(trailers);
  });

  // Live graph reference for control-channel queries (e.g. unerr/blast_radius).
  // Initialised to the boot graph and re-pointed on every swap-on-idle rebuild
  // (see graphHolder.onSwap below) so hook-path queries always hit the warm,
  // current graph instead of a stale post-rebuild instance. A plain mutable
  // binding (not graphHolder.graph) because the UDS server starts (2995) before
  // graphHolder is constructed (3065) — referencing graphHolder in this closure
  // would risk a temporal-dead-zone throw on an early connection.
  let liveGraph:
    | import("../intelligence/local-graph.js").CozoGraphStore
    | null = localGraph;

  // Layer 8: debounced domain-graph re-derive on the live-edit path. Each
  // annotation-touching incremental batch arms the timer; after a quiet window
  // the derive (propagation → community vote → domain edges) runs ONCE over the
  // current graph, coalescing a save-storm. Bound to `liveGraph` (not a captured
  // db) so a full-reindex swap retargets it to the fresh instance, never a
  // retired one. Best-effort: failures log and are swallowed.
  const { DomainDeriveScheduler } = await import(
    "../intelligence/semantic/domain-derive-scheduler.js"
  );
  const domainDeriveScheduler = new DomainDeriveScheduler({
    getDb: () => liveGraph?.db ?? null,
    onDerive: (r) =>
      log.info(
        `Domain graph re-derived (incremental): ${r.propagated} propagated, ${r.communities} communities, ${r.edges} edges`
      ),
    onError: (err) =>
      log.warn(
        `Domain graph re-derive failed: ${err instanceof Error ? err.message : String(err)}`
      ),
  });

  transportMux.setHandler(async (clientId, message) => {
    // Bridge-side hello: independent of MCP `initialize`. The bridge sends
    // this notification immediately on connect with its install-time
    // `--coding-agent` flag so attribution still works on reconnects where
    // the IDE never re-sends `initialize`.
    if (message.method === "unerr/hello") {
      const helloParams = message.params as
        | { agent?: string; session_id?: string }
        | undefined;
      const helloAgent = helloParams?.agent;
      const resolved = helloAgent
        ? resolveAgentId({
            codingAgent: helloAgent,
            clientInfoName: null,
            detectFromEnv: () => null,
          })
        : null;
      // Register the per-bridge session identity regardless of whether an agent
      // flag was sent — the bridge always announces its `session_id`, and a
      // missing agent simply leaves it null for the latest-record fallback.
      sessionRegistry.registerHello(clientId, {
        unerrSessionId: helloParams?.session_id ?? null,
        agent: resolved,
      });
      if (resolved) {
        agentNameByClient.set(clientId, resolved);
        tokenFlowWriter.setAgent(resolved);
        behaviorEventWriter.setAgent(resolved);
        // Shell-compressor exec processes inherit this env to stamp
        // out-of-band compression rows with the right agent id.
        process.env.UNERR_AGENT = resolved;
      }
      // Repo-lifecycle telemetry — a coding agent just attached an MCP session
      // to this repo. Emit one `agent_attached` per unerr session id (a bridge
      // reconnect re-announces the same id and must not double-count). The
      // emit is best-effort and never blocks the hello reply.
      const helloSessionId = helloParams?.session_id ?? null;
      if (helloSessionId && !attachedSessions.has(helloSessionId)) {
        attachedSessions.add(helloSessionId);
        void import("../tracking/repo-activity.js")
          .then(({ recordRepoActivity }) => {
            recordRepoActivity(
              openMetricsStore(unerrDirForLedger),
              "agent_attached",
              { sessionId: helloSessionId, agent: resolved ?? initialAgent }
            );
          })
          .catch(() => {
            /* lifecycle telemetry is best-effort */
          });
      }
      return { jsonrpc: "2.0" as const };
    }

    // Control channel: compaction flush (cost lever 3). Claude Code reports a
    // compaction twice — `PostCompact` and `SessionStart` (source `compact` /
    // `clear`) — and each hook sends ONE frame here before it exits. The harness
    // blocks on the hook process, so the flush lands before the agent's next
    // tool call can hit BodyDedupStore.check(): a "you already have this file"
    // pointer can never cross a compaction boundary. Idempotent — the second
    // path finds nothing left and acks `dropped: 0`.
    if (message.method === COMPACTION_METHOD) {
      const compactionParams = message.params as
        | CompactionRequestParams
        | undefined;
      const result = handleCompactionRequest(
        { clearBodies: (id) => router.clearBodyDedup(id) },
        compactionParams
      );
      if (result.dropped > 0) {
        // Per-repo proxy.log only (never the user's terminal) — the field trace
        // for "did the flush actually reach the store?".
        process.stderr.write(
          `[unerr] compaction flush (${compactionParams?.trigger ?? "compact"}) dropped ${result.dropped} body-dedup entr${result.dropped === 1 ? "y" : "ies"}\n`
        );
      }
      return { jsonrpc: "2.0" as const, id: message.id, result };
    }

    // Control channel: edit blast-radius query (P0.4). The pre-edit hook
    // (a short-lived `unerr hook pre-edit` subprocess) connects, sends ONE
    // frame, reads ONE response, disconnects — no MCP initialize handshake.
    // Runs the shared edit-impact engine against the warm in-process graph so
    // the cascade signal is computed once, server-side, in <5ms. Mirrors the
    // `unerr/ping` precedent: a non-MCP method intercepted before the tool
    // dispatch. Always returns a well-formed result (empty warnings on any
    // missing input / absent graph) so the hook never has to special-case it.
    if (message.method === "unerr/blast_radius") {
      // Snapshot into a const so the non-null narrowing survives the await
      // below (a swap could re-point `liveGraph` mid-call; this call resolves
      // against the instance that was current when the request arrived).
      const graphRef = liveGraph;
      const blastParams = message.params as
        | import("./blast-radius-protocol.js").BlastRadiusRequestParams
        | undefined;
      const {
        handleBlastRadiusRequest,
        recordBlastRadiusTelemetry,
        BLAST_RADIUS_METHOD,
        isBlastRadiusResult,
      } = await import("./blast-radius-protocol.js");

      // CROSS_REPO_INTELLIGENCE Sprint 6.2: route the gate to the owning peer
      // when the edited file lives in a federated sibling repo. The home graph
      // has none of the peer's entities, so a foreign-file edit would otherwise
      // degrade to the static nudge; routeByPath sends the blast-radius
      // computation to the repo that actually owns the file. Home-owned files
      // (the common case) skip this and compute locally below.
      let result:
        | import("./blast-radius-protocol.js").BlastRadiusResult
        | null = null;
      const blastFilePath = blastParams?.file_path;
      if (federationCoordinatorRef && blastFilePath) {
        try {
          const route = await federationCoordinatorRef.routeByPath({
            homeRepo: process.cwd(),
            toolName: BLAST_RADIUS_METHOD,
            args: (blastParams ?? {}) as Record<string, unknown>,
            filePath: blastFilePath,
          });
          if (route.routed && isBlastRadiusResult(route.result)) {
            result = route.result;
          }
        } catch {
          /* fall back to the home compute below */
        }
      }

      // Home-owned (or unrouted) file: compute against the warm home graph, then
      // CROSS_REPO_INTELLIGENCE Sprint 6.1 — federate the cascade. For each
      // changed exported entity, count its callers in peer repos via the L2
      // SCIP linker and attach them to the warning, so the pre-edit hook cites
      // cross-repo callers. No-op on free tier / no coordinator / no moniker
      // index — the local cascade still fires.
      if (!result) {
        result = await handleBlastRadiusRequest(graphRef, blastParams);
        if (federationCoordinatorRef && result.warnings.length > 0) {
          try {
            const { augmentBlastRadiusWithPeers } = await import(
              "../intelligence/federation/cross-repo-blast.js"
            );
            await augmentBlastRadiusWithPeers(result.warnings, {
              monikerIndex: monikerIndexRef,
              coordinator: federationCoordinatorRef,
              homeRepo: process.cwd(),
            });
          } catch {
            /* federation is advisory — never block the gate reply */
          }
        }
        // Sprint 6.4: flag a NEW import in the home edit that reaches into a
        // federated sibling's internals (not its package entry). Shaped as a
        // BoundaryViolation so it rides the existing boundary nudge + telemetry.
        // No-op until the first drift sweep has populated peerPackagesRef.
        if (peerPackagesRef.size > 0 && blastParams?.new_content) {
          try {
            const { detectCrossRepoImportBreaches } = await import(
              "../intelligence/federation/cross-repo-boundary.js"
            );
            const breaches = detectCrossRepoImportBreaches(
              blastParams.file_path ?? "",
              blastParams.new_content,
              peerPackagesRef
            );
            if (breaches.length > 0)
              result.boundary_violations.push(...breaches);
          } catch {
            /* federation is advisory — never block the gate reply */
          }
        }
      }

      // Telemetry: surface the pre-edit guard firings so the dashboard's
      // behavior-event panes render them. The caller-cascade signal (D2) and
      // the architecture-boundary signal (D3) are distinct behaviors; each
      // fires its own row only when it fires. Best-effort — never blocks the
      // control-channel reply.
      recordBlastRadiusTelemetry(
        behaviorEventWriter,
        result,
        blastParams?.file_path ?? null
      );

      return { jsonrpc: "2.0" as const, id: message.id, result };
    }

    // Control channel: cross-repo federation (CROSS_REPO_INTELLIGENCE Sprint 3).
    // Another repo's proxy (the federation coordinator) connects, sends ONE
    // frame naming a tool + args, reads ONE response, disconnects. Runs the RAW
    // executor (no prose/signal assembly) against the warm in-process graph so
    // results merge structurally on the home side. Mirrors `unerr/blast_radius`:
    // a non-MCP method intercepted before the tool dispatch, no login/tier gate
    // here (the calling proxy already enforced the workspace pro-gate; this is a
    // same-machine same-user internal channel). The coordinator forces
    // `scope:'repo'` on args, so a federated call can never re-federate.
    if (message.method === "unerr/federated_call") {
      const fedParams = message.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      const fedName = fedParams?.name;
      if (!fedName) {
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: { content: null },
        };
      }
      // CROSS_REPO_INTELLIGENCE Sprint 6.2: the owning-repo gate route. When the
      // home proxy detects an edit to a file this peer owns, it federates the
      // blast-radius computation here (not an MCP tool — `executeRaw` can't run
      // it) so the cascade resolves against THIS repo's warm graph. Returns the
      // BlastRadiusResult as `content`, matching the home handler's expectation.
      const { BLAST_RADIUS_METHOD } = await import(
        "./blast-radius-protocol.js"
      );
      if (fedName === BLAST_RADIUS_METHOD) {
        try {
          const graphRef = liveGraph;
          const { handleBlastRadiusRequest } = await import(
            "./blast-radius-protocol.js"
          );
          const content = await handleBlastRadiusRequest(
            graphRef,
            fedParams?.arguments as
              | import("./blast-radius-protocol.js").BlastRadiusRequestParams
              | undefined
          );
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content },
          };
        } catch {
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: null },
          };
        }
      }
      // CROSS_REPO_INTELLIGENCE Sprint 8.1: peer-side convention attach for a
      // foreign-path file read/outline. The home routes the read here; this peer
      // serves the content AND attaches its own conventions for the file (the
      // home's `executeRaw` path can't compute them — it has none of this repo's
      // graph). Returned as a {content, peer_conventions} wrapper the home
      // unwraps. Conventions are best-effort: any fault returns the bare content.
      const { PEER_CONVENTION_FILE_METHODS } = await import(
        "../intelligence/federation/cross-repo-conventions.js"
      );
      if (PEER_CONVENTION_FILE_METHODS.has(fedName)) {
        try {
          const content = await router.executeRaw(
            fedName,
            fedParams?.arguments ?? {}
          );
          let peerConventions: Array<{
            id: string;
            name: string;
            adherence_pct: number;
            rule: string;
          }> = [];
          const fp = (
            fedParams?.arguments as
              | { file_path?: unknown; path?: unknown }
              | undefined
          )?.file_path;
          const filePathArg = typeof fp === "string" ? fp : undefined;
          if (liveGraph && filePathArg) {
            try {
              peerConventions = await liveGraph.getConventionsForEntity(
                filePathArg,
                3
              );
            } catch {
              /* conventions are best-effort — serve content regardless */
            }
          }
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: { content, peer_conventions: peerConventions } },
          };
        } catch (err: unknown) {
          process.stderr.write(
            `[unerr] unerr/federated_call(${fedName}) threw: ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: null },
          };
        }
      }
      try {
        const content = await router.executeRaw(
          fedName,
          fedParams?.arguments ?? {}
        );
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: { content },
        };
      } catch (err: unknown) {
        process.stderr.write(
          `[unerr] unerr/federated_call(${fedName}) threw: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
        return {
          jsonrpc: "2.0" as const,
          id: message.id,
          result: { content: null },
        };
      }
    }

    // MCP protocol: handle initialize handshake for bridged clients
    if (message.method === "initialize") {
      // Capture agent name from clientInfo (e.g. "claude-code", "cursor").
      // The bridge (`unerr --mcp --coding-agent=<id>`) rewrites clientInfo.name
      // to the install-time codingAgent flag, so this is the most reliable
      // attribution source for bridged sessions.
      const clientName = (
        message.params as { clientInfo?: { name?: string } } | undefined
      )?.clientInfo?.name;
      if (clientName) {
        const resolved = resolveAgentId({
          codingAgent: null,
          clientInfoName: clientName,
          detectFromEnv: () => null,
        });
        agentNameByClient.set(clientId, resolved);
        // Bind the agent to this client's session record so native-id
        // resolution can find the right conversation later (a bridge that sent
        // no agent in `unerr/hello` is still attributed from `initialize`).
        sessionRegistry.setAgent(clientId, resolved);
        // Update the global writer agent. For multi-client daemons serving
        // multiple coding agents simultaneously this is last-writer-wins;
        // per-call override via input.agent (passed from the UDS dispatcher
        // below) keeps individual rows attributed correctly even when the
        // global value lags.
        tokenFlowWriter.setAgent(resolved);
        behaviorEventWriter.setAgent(resolved);
        process.env.UNERR_AGENT = resolved;
      }
      return {
        jsonrpc: "2.0" as const,
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "unerr-local", version: UNERR_VERSION },
        },
      };
    }

    // MCP protocol: acknowledge initialized notification
    if (message.method === "notifications/initialized") {
      // Notifications don't get responses, but we need to not error
      return { jsonrpc: "2.0" as const };
    }

    // UDS `tools/list` — the path a bridged IDE actually takes. Same lock as
    // the stdio handler above, so both replies and the bridge's local fallback
    // serialize to the same bytes.
    if (message.method === "tools/list") {
      return {
        jsonrpc: "2.0" as const,
        result: { tools: lockAdvertisedCatalog(await getAdvertisedTools()) },
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

      // Single dispatch path — every UDS (bridged-IDE) tools/call runs the
      // IDENTICAL pipeline as the directly-connected stdio client via the one
      // dispatchToolCall closure defined with the stdio handler above. clientId
      // threads bridged-session attribution into the ledger. This replaces the
      // ~370-line duplicated dispatch chain that had silently diverged from
      // stdio (it skipped pre/post behavioral hooks, narrative/pattern/snapshot).
      const result = await dispatchToolCall(
        name,
        toolArgs as Record<string, unknown>,
        { clientId }
      );
      return { jsonrpc: "2.0" as const, result };
    }

    return {
      jsonrpc: "2.0" as const,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    };
  });

  transportMux.start();

  // No HTTP transport. `startHttpTransport` (POST/GET /mcp + /health, opt-in
  // via UNERR_HTTP_PORT) is removed: nothing set the env var, no test covered
  // it, and its bearer-token check keyed on an `apiKey` option this call site
  // never passed — so the one way to turn it on served the full MCP tool suite
  // over unauthenticated loopback HTTP. MCP reaches this proxy over stdio and
  // the per-repo UDS socket only.

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

      // L2.5: Swap-on-idle graph rebuild via GraphHolder.
      // DriftTracker notifies GraphHolder of file changes → idle timer → full rebuild
      // into a fresh CozoDB instance → atomic swap to all consumers.
      const { GraphHolder } = await import("../intelligence/graph-holder.js");
      const { indexLocalProject } = await import(
        "../intelligence/local-indexer.js"
      );
      const { checkpointWalDetached } = await import(
        "../intelligence/persistent-db.js"
      );
      const repoId = repoIds[0] as string;
      const cwd = process.cwd();

      const graphHolder = new GraphHolder(localGraph);

      // Factory: reindexes into the existing persistent graph.
      // CozoDB :put is upsert — data stays queryable during rebuild.
      // Orphan cleanup at end of indexLocalProject removes stale entities.
      graphHolder.setRebuildFactory(async () => {
        const result = await indexLocalProject(cwd, localGraph, repoId);
        // Fold + truncate graph.db-wal after the full-reindex write burst
        // (a full reindex re-upserts the whole graph via :put, appending the
        // entire dataset to the WAL). MUST be the detached (child-process)
        // variant while cozo is live — an in-process checkpoint cancels
        // cozo's POSIX locks on close (howtocorrupt.html §2.3) and crashed
        // the proxy with SIGBUS/SIGABRT. Fire-and-forget so the graph swap
        // is not delayed.
        if (graphDbPath) checkpointWalDetached(graphDbPath);
        return { graph: localGraph, result };
      });

      // Incremental factory — processes only changed files, no full reindex.
      const { indexFilesIncremental } = await import(
        "../intelligence/incremental-indexer.js"
      );
      graphHolder.setIncrementalFactory(async (changedFiles) => {
        const result = await indexFilesIncremental(
          cwd,
          changedFiles,
          localGraph,
          repoId
        );
        // Same idle-path WAL fold as the full rebuild — keeps graph.db-wal
        // from creeping up across a long editing session of small writes.
        // Detached for the same reason as above: cozo holds graph.db live.
        if (graphDbPath) checkpointWalDetached(graphDbPath);
        // Layer 8: an annotation-touching batch arms the debounced domain
        // re-derive so the community vote / propagated labels track this edit
        // within seconds instead of waiting for the idle full reindex.
        if (result.annotationsChanged) domainDeriveScheduler.schedule();
        return result;
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
        incompleteWork.attachGraph(newGraph);
      });
      // Re-point the control-channel graph (unerr/blast_radius) at the fresh
      // instance so hook-path cascade queries never hit the retired graph.
      graphHolder.onSwap((newGraph) => {
        liveGraph = newGraph;
      });
      // CROSS_REPO_INTELLIGENCE Sprint 4: a full reindex re-runs SCIP and
      // rewrites `.unerr/scip/monikers.json`, so reload the moniker index on
      // swap to keep cross-repo references current (cheap JSON read; a no-op
      // for incremental swaps that didn't touch the artifact).
      graphHolder.onSwap(() => {
        void refreshMonikerIndex();
      });
      // Publish counts for navigation hooks (short-lived CLI processes that
      // cannot open CozoDB) — fires on every idle-triggered swap so readers
      // see the post-rebuild counts, not the pre-rebuild ones.
      graphHolder.onSwap((newGraph) => {
        void publishLiveGraphStats(newGraph, cwd);
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
      // Drift coalescer — see the long-running-session timeout investigation.
      //
      // Two issues compounded: (1) local-indexer.ts bypasses the writeChain
      // and fires raw `db.run` calls during full reindex; (2) periodic orphan
      // cleanup (`Removing 4058 orphaned entities`) triggers a RocksDB
      // compaction stall that lasts tens of seconds. Drift writes queued
      // behind the stall hit the 10s timeout. Fire-and-forget event handling
      // amplified the failure — every new file change stacked another
      // doomed-to-timeout write.
      //
      // Mitigation: skip drift processing entirely while a rebuild is in
      // flight (the rebuild picks up the same files), and serialize the
      // remaining work so concurrent file events coalesce into one batched
      // `processFiles` call instead of N racing ones.
      let driftBusy = false;
      const pendingDriftPaths = new Set<string>();
      // Throttle state for the large-graph write-stall mitigation below:
      // track how long the last `processFiles` write took, and — once it's
      // slow — back drains off for DRIFT_COOLDOWN_MS instead of piling
      // another slow write behind the same cozo writeChain.
      let driftLastWriteMs = 0;
      let driftCooldownUntil = 0;
      let driftCooldownTimer: NodeJS.Timeout | null = null;
      const drainDrift = async (): Promise<void> => {
        if (driftBusy || !_driftTracker) return;
        if (graphHolder.isRebuilding) return;
        // Defer drift while an incremental reindex is pending. Drift and the
        // reindex share ONE CozoDB writeChain (local-graph.ts writeChain), so
        // running both during an edit burst stacks slow writes (RocksDB
        // compaction stalls) until the 60s write timeout fires — and reads
        // (get_references / search_code) queue behind the held lock and hit
        // their own timeouts. pendingChanges > 0 means the idle timer is
        // still counting toward a reindex: let the reindex run and swap first.
        // onSwap() re-invokes drainDrift() once pendingChanges resets to 0, so
        // drift writes land AFTER the reindex instead of racing it.
        if (graphHolder.pendingChanges > 0) return;
        if (pendingDriftPaths.size === 0) return;
        // Large-graph write-stall mitigation: a single `processFiles` write
        // on a very large graph (150MB+, 40k+ entities) can exceed 60s and
        // stall the shared write path. If the last write was slow, skip this
        // drain and re-schedule after the cooldown — paths stay queued in
        // pendingDriftPaths and drain once the cooldown lapses.
        if (shouldThrottleDrift(driftLastWriteMs, driftCooldownUntil)) {
          process.stderr.write(
            `⚠ [watcher] drift throttled (last write ${driftLastWriteMs}ms, cooling down)\n`
          );
          if (!driftCooldownTimer) {
            const delay = Math.max(0, driftCooldownUntil - Date.now());
            driftCooldownTimer = setTimeout(() => {
              driftCooldownTimer = null;
              void drainDrift();
            }, delay);
          }
          return;
        }
        driftBusy = true;
        const batch = [...pendingDriftPaths];
        pendingDriftPaths.clear();
        const headSha = branchContext?.headSha ?? "unknown";
        const driftWriteStartedAt = Date.now();
        try {
          await _driftTracker.processFiles(batch, headSha);
        } catch (err: unknown) {
          process.stderr.write(
            `⚠ [watcher] Drift processing failed: ${formatUnknownError(err)}\n`
          );
        } finally {
          driftLastWriteMs = Date.now() - driftWriteStartedAt;
          if (driftLastWriteMs > DRIFT_SLOW_WRITE_MS) {
            driftCooldownUntil = Date.now() + DRIFT_COOLDOWN_MS;
          }
          driftBusy = false;
          if (pendingDriftPaths.size > 0) {
            void drainDrift();
          }
        }
      };

      const nativeWatcher = createNativeWatcher({
        projectRoot: cwd,
        debounceMs: 100,
        onEvents: (events) => {
          const indexable = filterIndexableEvents(events);
          if (indexable.length === 0) return;
          // Notify GraphHolder of file change (resets idle timer, tracks paths for incremental)
          graphHolder.notifyFileChange(indexable);
          // Always accumulate paths. drainDrift() gates on isRebuilding so the
          // actual writes are deferred — but events that arrive mid-rebuild
          // are NOT dropped (the reindex pipeline may already be past those
          // files; we need to fold them into the overlay after swap).
          for (const p of indexable) pendingDriftPaths.add(p);
          void drainDrift();
        },
      });

      // Drain the deferred drift backlog after a graph swap. Swap callbacks
      // fire inside the rebuild's `.then()` — `isRebuilding` is still true at
      // that instant and flips false in the following `.finally()`. Defer with
      // setImmediate so the drain runs on the next event-loop tick, by which
      // point `.finally()` has executed and the gate inside drainDrift will
      // let writes through.
      graphHolder.onSwap(() => {
        setImmediate(() => {
          void drainDrift();
        });
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
    const graph = localGraph; // non-null inside the closures below

    // Post-index initialization shared by every path (full reindex,
    // incremental reindex, and the no-op staleness skip): refresh the graph
    // card, compute the health grade, show the MCP connection card, start the
    // DriftTracker (TL-31: only once the graph is settled), and run the
    // fact-generation pipeline. Idempotent and safe to call exactly once.
    const finalizeIndexing = async (card: {
      entityCount: number;
      edgeCount: number;
      fileCount: number;
      communityCount: number;
      elapsedMs: number;
    }): Promise<void> => {
      startupLog.graphLoaded({
        entities: card.entityCount,
        edges: card.edgeCount,
        files: card.fileCount,
        communities: card.communityCount,
        patterns: 0,
        rules: 0,
        ms: card.elapsedMs,
      });

      // Publish counts for navigation hooks (short-lived CLI processes that
      // cannot open CozoDB) — covers full reindex, incremental reindex, and
      // the no-op staleness skip, since finalizeIndexing runs on all three.
      await publishLiveGraphStats(graph, process.cwd());

      // Show MCP connection card with config snippet for manual agent setup
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

      // L11.4: Start DriftTracker ONLY after the graph is settled (TL-31)
      initDriftTracker().catch((err: unknown) => {
        log.warn(
          `Post-index DriftTracker init failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    };

    // Full reindex: the BackgroundIndexer + ora spinner path (L11.1/L11.3).
    // Fire-and-forget — returns once indexing is scheduled.
    const runFullBackgroundIndex = async (): Promise<void> => {
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
        graph,
        localRepoId,
        // onComplete
        async (result) => {
          // L4.1: Record indexing stats for Local Mode proof
          if (stats.localMode) {
            recordIndexingResult(stats.localMode, result);
          }
          spinner.succeed("Deep index complete");
          await finalizeIndexing({
            entityCount: result.entityCount,
            edgeCount: result.edgeCount,
            fileCount: result.fileCount,
            communityCount: result.communityCount,
            elapsedMs: result.elapsedMs,
          });
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
    };

    if (indexMode === "incremental-if-stale") {
      // Bug A: the persistent graph is already populated. Decide AFTER the MCP
      // handshake whether anything actually changed, then do the minimum work —
      // skipping the reindex entirely when the graph is current. Runs detached
      // so it never blocks the boot sequence or the first tool calls.
      void (async () => {
        try {
          const { computeIndexPlan } = await import(
            "../intelligence/staleness.js"
          );
          const plan = await computeIndexPlan(process.cwd(), graph);
          log.info(`Startup index plan: ${plan.mode} — ${plan.reason}`);

          if (plan.mode === "skip") {
            startupLog.step(
              `${startupLog.fmt.muted(`Graph current — no reindex (${plan.totalFiles} files unchanged)`)}`
            );
            const s = await graph.getLocalProjectStats();
            await finalizeIndexing({
              entityCount: s.entityCount,
              edgeCount: s.edgeCount,
              fileCount: s.fileCount,
              communityCount: s.communityCount,
              elapsedMs: 0,
            });
            return;
          }

          if (plan.mode === "incremental") {
            const { indexFilesIncremental } = await import(
              "../intelligence/incremental-indexer.js"
            );
            const localRepoId = repoIds[0] as string;
            const r = await indexFilesIncremental(
              process.cwd(),
              plan.changedFiles,
              graph,
              localRepoId
            );
            log.info(
              `Incremental startup reindex: ${r.filesProcessed} files, +${r.entitiesAdded}/~${r.entitiesUpdated}/-${r.entitiesDeleted} entities in ${r.elapsedMs}ms`
            );
            // Layer 8: files changed while offline may have moved annotations —
            // arm the debounced derive so the domain vote reflects them shortly
            // after boot (the persisted graph already carries the prior derive).
            if (r.annotationsChanged) domainDeriveScheduler.schedule();
            const s = await graph.getLocalProjectStats();
            await finalizeIndexing({
              entityCount: s.entityCount,
              edgeCount: s.edgeCount,
              fileCount: s.fileCount,
              communityCount: s.communityCount,
              elapsedMs: r.elapsedMs,
            });
            return;
          }

          // plan.mode === "full" — change set too large for incremental.
          await runFullBackgroundIndex();
        } catch (err: unknown) {
          log.warn(
            `Staleness-gated reindex failed (${err instanceof Error ? err.message : String(err)}); falling back to full index`
          );
          await runFullBackgroundIndex().catch((e: unknown) => {
            log.warn(
              `Fallback full index failed: ${e instanceof Error ? e.message : String(e)}`
            );
          });
        }
      })();
    } else {
      // Cold index — fresh DB, snapshot migration, or no snapshot.
      await runFullBackgroundIndex();
    }
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
      `PARSE mode — graph engine unavailable (${parseStats?.entityCount ?? 0} entities)`
    );
    // Degraded mode is first-class, not an error: tools still work off a
    // regex-extracted index, just without the full call graph / drift / rules.
    // Name the cause (cozo-node missing) and the remedy so a Windows user who
    // hit a blocked prebuilt download knows this is expected and recoverable.
    log.info(
      `MCP server running on stdio — PARSE mode (reduced accuracy): ${proxyModeReason} Serving ${parseStats?.entityCount ?? 0} entities from ${parseStats?.fileCount ?? 0} files via regex extraction (no call graph, drift, or rules). Run \`unerr doctor\` for how to restore the full graph engine.`
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

  if (localGraph && proxyMode !== "parse" && !needsBackgroundIndex) {
    // Publish counts for navigation hooks — this is the resume path where
    // the graph was already current at boot, so no reindex ever runs and
    // this is the only completion point for the run.
    await publishLiveGraphStats(localGraph, process.cwd());

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
  const preloadTreeSitterGrammars = async (): Promise<void> => {
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
  };
  // Daemon children must reach the dashboard server (and IPC ready) before
  // unerrd's REPO_READY_TIMEOUT_MS — don't block that path on WASM preload.
  if (opts.daemonChild) {
    void preloadTreeSitterGrammars();
  } else {
    await preloadTreeSitterGrammars();
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
  const { writeLiveSessionSnapshot, clearLiveSessionSnapshot } = await import(
    "../tracking/weekly-accumulator.js"
  );
  // Flipped by shutdown once the session is folded into stats.json — the
  // final writeStatsSnapshot() call there must not re-create the live
  // sidecar, or `unerr stats` would count this session twice.
  let liveStatsFinalized = false;

  const statsSnapshotPath = join(stateDir, "session_stats.json");
  // Persist the live session stats to disk. Shared by the periodic timer and
  // the graceful-shutdown path so both write an identical shape. Gated on
  // toolCallsLocal > 0: a proxy that made no MCP calls has nothing worth
  // resuming, and writing a 0-call snapshot would CLOBBER a prior real
  // session's snapshot (breaking warm-restart session-id continuity — see
  // detectSessionResume / resolveResumableSessionId in session-stats.ts).
  const writeStatsSnapshot = (): void => {
    try {
      if (stats.toolCallsLocal === 0) return;
      const localP = computePercentiles(
        stats.latency.localSamples,
        stats.latency.localTotalSamples
      );
      const snapshot = {
        pid: process.pid,
        session_id: shadowLedger.getSessionId(),
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
      // Mid-session global sidecar so `unerr stats` reflects in-flight
      // sessions (regression 6f: stats printed "No sessions recorded yet"
      // during a live session). Replaced wholesale every tick; cleared when
      // shutdown folds the session into stats.json.
      if (!liveStatsFinalized) {
        writeLiveSessionSnapshot({
          sessionId: shadowLedger.getSessionId(),
          tokensSaved:
            stats.localMode?.tokensSavedByTruncation ??
            stats.estimatedTokensSaved,
          toolCalls: stats.toolCallsLocal,
          violationsCaught: stats.violationsCaught,
          efficiency: router.getEfficiencySnapshot()?.efficiency ?? 0,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* non-critical */
    }
  };
  const statsSnapshotInterval = setInterval(writeStatsSnapshot, 10_000); // every 10s

  // ── Step 7d: Daemon readiness signal ────────────────────────────
  // The local analytics dashboard (HTTP server + React SPA) was removed in
  // L1 — the cloud dashboard is now the one analytics surface. We still tell
  // the daemon the proxy is up so `pm status` / fleet reporting reflect it.
  if (opts.daemonChild && opts.onDaemonReady) {
    opts.onDaemonReady({ sock: sockPath, port: null });
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

      // Lever D: flush the cross-session dedup set so the final session's
      // delivered context survives into the next session (no-op when off).
      try {
        sessionDedup.flush();
      } catch {
        /* best-effort — a failed flush just means re-injection next session */
      }

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
      // Finalize live-stats first: from here the session is folded into
      // stats.json, so the mid-session sidecar must go away (and the final
      // writeStatsSnapshot() below must not re-create it) or `unerr stats`
      // would count this session twice.
      liveStatsFinalized = true;
      clearLiveSessionSnapshot(shadowLedger.getSessionId());
      const total = stats.toolCallsLocal;
      if (total > 0) {
        // Layer 10: Compute token flow summary for persistence + receipt
        let tokenFlowSummary:
          | import("../tracking/token-flow.js").SessionTokenSummary
          | null = null;
        let mechanismBreakdown: Record<string, number> | undefined;
        if (tokenFlowWriter) {
          try {
            const { aggregateSession: aggSession } = await import(
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

        // await import, NOT require(): pure-ESM tsup bundle — require() threw
        // here at runtime, so stats.json was NEVER written at shutdown.
        const { accumulateSession } = await import(
          "../tracking/weekly-accumulator.js"
        );
        const { computePercentiles } = await import("./session-stats.js");
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
            const { appendSessionHistory } = await import(
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
              modelId: "unknown",
              entityCount: 0,
              agentName:
                agentNameByClient.values().next().value ??
                server.getClientVersion?.()?.name ??
                // Last-resort env probe so the session row never falls
                // back to "Unknown Agent" when the IDE skipped sending
                // clientInfo (some bridges + older clients do this).
                (await import("../utils/detect.js")).detectAgentNameFromEnv() ??
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
            const { printSessionReceipt } = await import(
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
          avgLatencyP50: unifiedStats.weekly.avgLatencyP50,
        };

        // S8.6: Build scorecard for session summary display
        const { formatScorecard, formatCounterfactual } = await import(
          "../config/value-surfacing.js"
        );
        const tokensSaved =
          stats.localMode?.tokensSavedByTruncation ??
          stats.estimatedTokensSaved;
        const durationMs = Date.now() - stats.sessionStartedAt;
        const scorecardData = formatScorecard({
          toolCalls: stats.toolCallsLocal,
          tokensSaved,
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
          // react is CJS — its module.exports lands on `.default` under ESM
          // dynamic import (esbuild __toESM interop), hence the ?? fallback.
          const reactMod = (await import("react")) as any;
          const React = reactMod.default ?? reactMod;
          const { SessionSummaryCard } = (await import(
            "../components/SessionSummaryCard.js"
          )) as any;
          const { ThemeProvider } = (await import(
            "../components/Theme.js"
          )) as any;
          const { renderToStderr } = (await import(
            "../components/render.js"
          )) as any;
          const el = React.createElement(
            ThemeProvider,
            null,
            React.createElement(SessionSummaryCard, {
              stats,
              cumulativeLocal,
              scorecard: {
                efficiency: scorecardData.efficiency,
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

      // Leapfrog Sprint B: Run correction detector on this session's ledger entries
      if (localGraph && ledgerStats.totalEntries > 0) {
        try {
          const correctionModule = await import(
            "../tracking/correction-detector.js"
          );
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
          }
        } catch {
          // Correction detection is non-critical — don't block shutdown
        }
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
      // Layer 8: cancel any pending domain re-derive so it never fires against a
      // graph being torn down (the timer is unref'd, so this is hygiene, not a
      // hang fix).
      domainDeriveScheduler.stop();
      stopBranchPoller?.();
      // Task 7.2: Stop UDS transport (cleans up socket file)
      transportMux.stop();
      // Persist a FINAL stats snapshot instead of deleting it. The next proxy
      // boot reads this file (detectSessionResume) to CONTINUE under the same
      // session id on a warm restart within SESSION_RESUME_ID_WINDOW_MS — if we
      // unlinked here, every graceful restart would re-key the session and the
      // prompt boundary + the turn's tool events would land under different
      // ids (per-turn receipt renders 0). Liveness is owned by the PID lock, so
      // a leftover file is harmless: `unerr status` gates live stats on
      // proxyRunning and reads this same file for its "last session" summary.
      writeStatsSnapshot();
      // Release persistent CozoDB native handles
      if (localGraph?.db.close) {
        localGraph.db.close();
      }
      // Fold + truncate graph.db-wal now that cozo's pooled connections are
      // released (no reader can pin the WAL), so a WAL grown by reindex write
      // bursts is not left on disk across the restart. Best-effort and awaited
      // so it completes before process.exit; checkpointWal swallows its errors.
      if (graphDbPath) {
        const { checkpointWal } = await import(
          "../intelligence/persistent-db.js"
        );
        await checkpointWal(graphDbPath);
      }
      // Release SQLite metrics handle(s).
      try {
        const { closeAllMetricsStores } = await import(
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
      // Stop the periodic timeline.db WAL checkpoint timer.
      if (walCheckpointInterval) {
        clearInterval(walCheckpointInterval);
      }
      // ST-6: Stop daily ledger-archive interval.
      clearInterval(ledgerArchiveInterval);
      // C3: Stop daily line-survival rollup interval.
      clearInterval(lineSurvivalInterval);
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

  // Live graph counts for fleet inventory. Reads from `liveGraph` (the
  // swap-updated pointer), NOT `localGraph` (stale after an idle rebuild swap).
  // Guarded: parse-mode stubs lack these methods, and a query can race a swap —
  // either case yields nulls rather than throwing into the stats path.
  async function getGraphStats(): Promise<{
    entityCount: number | null;
    edgeCount: number | null;
  }> {
    const g = liveGraph;
    if (
      !g ||
      typeof g.getEntityCount !== "function" ||
      typeof g.getEdgeCount !== "function"
    ) {
      return { entityCount: null, edgeCount: null };
    }
    try {
      const [entityCount, edgeCount] = await Promise.all([
        g.getEntityCount(),
        g.getEdgeCount(),
      ]);
      return { entityCount, edgeCount };
    } catch {
      return { entityCount: null, edgeCount: null };
    }
  }

  return { shutdown, stats, getGraphStats };
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

/**
 * Publish live entity/edge/rule counts to `.unerr/state/graph-stats.json` for
 * `graph-readiness.ts`'s cheap readers (navigation hooks are short-lived CLI
 * processes that cannot open CozoDB). Call after every point the graph
 * becomes current: initial index, background reindex, and each GraphHolder
 * swap. Best-effort — any failure here must never block or fail boot, so
 * every error is swallowed after a stderr warning.
 */
async function publishLiveGraphStats(
  graph: import("../intelligence/local-graph.js").CozoGraphStore,
  cwd: string
): Promise<void> {
  try {
    const [entities, edges, hasRules] = await Promise.all([
      graph.getEntityCount(),
      graph.getEdgeCount(),
      graph.hasRules(),
    ]);
    const rules = hasRules ? (await graph.getRules()).length : 0;
    publishGraphStats(cwd, { entities, edges, rules });
  } catch (err: unknown) {
    log.warn(
      `Publishing graph stats failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
