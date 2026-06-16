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
import {
  credentialsPath,
  entitlementsCachePath,
} from "../cloud/credentials.js";
import { loginBlocked, loginGateNotice } from "../cloud/login-gate.js";
// Static ESM imports, NOT require(): the tsup bundle is pure ESM, where
// require() hits esbuild's "Dynamic require is not supported" stub — these
// two are needed in SYNC contexts (runBoundaryValidation, the /commit-context
// HTTP handler) where `await import()` is unavailable. Both are light
// (definitions + node:fs only), so static import costs nothing at boot.
import {
  DEEP_DIVE_TOOL_DEFINITIONS,
  NAVIGATION_TOOL_NAMES,
} from "../intelligence/deep-dive-tools.js";
import { getCommitTrailers } from "../tracking/git-trailers.js";
import { getPromptsForSession } from "../tracking/prompt-trace.js";
import { createReconDetector } from "../tracking/turn-telemetry.js";
import { UNERR_VERSION } from "../version.js";
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
  resolveResumableSessionId,
} from "./session-stats.js";
import { StartupRenderer } from "./startup-renderer.js";
import { ToolUsageTracker, reorderToolsByCluster } from "./tool-clusters.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tool-definitions.js";
import { hiddenToolNames } from "./tool-descriptions.js";
import { translateUnerrTrack } from "./unerr-track.js";

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

/** JSON-RPC error code for the mandatory-login block on MCP tool calls. */
export const LOGIN_BLOCKED_ERROR_CODE = -32004;

// ── Mandatory-login gate: mtime-memoized `loginBlocked()` for the tool path ──
// `dispatchToolCall` runs on EVERY tools/call and carries a <5ms budget, so it
// cannot afford `loginBlocked()`'s 2-3 small JSON reads each time. We memoize
// the verdict and re-evaluate ONLY when the credentials or entitlement file
// mtime moves. That is what lets a login completed in ANOTHER terminal unblock
// the NEXT tool call without restarting the proxy: writeCredentials() rewrites
// credentials.json (new mtime) → the cache key changes → we re-run the gate.
//
// A missing file stats to mtime 0; the pair (cred, ent) forms the cache key.
// `loginBlocked()` itself short-circuits on UNERR_TOKEN, so the headless/CI
// path needs no special-casing here.
let loginGateCacheKey: string | null = null;
let loginGateCacheBlocked = false;

/** mtime-ms of a path, or 0 when it does not exist / cannot be stat'd. */
function mtimeOrZero(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Memoized `loginBlocked()` for the per-call tool path. Recomputes only when
 * the credentials or entitlement file mtime changes, so the steady-state cost
 * is two `statSync` calls (no JSON parse, no auth-state recompute) and a
 * mid-session login in another terminal unblocks the next call.
 */
export function loginBlockedCached(now: number = Date.now()): boolean {
  const key = `${mtimeOrZero(credentialsPath())}:${mtimeOrZero(entitlementsCachePath())}`;
  if (key !== loginGateCacheKey) {
    loginGateCacheKey = key;
    loginGateCacheBlocked = loginBlocked(now);
  }
  return loginGateCacheBlocked;
}

/** Test-only: drop the memoized login verdict so the next call re-evaluates. */
export function __resetLoginGateCache(): void {
  loginGateCacheKey = null;
  loginGateCacheBlocked = false;
}

export interface ProxyOptions {
  /** Specific repo ID (auto-detected from .unerr/config.json if omitted) */
  repoId?: string;
  /** Enable predictive context pre-fetching */
  prefetch?: boolean;
  /** Sprint 5.3: HTTP port for Streamable HTTP transport (0 = disabled) */
  httpPort?: number;
  /** Running as a daemon-managed child (suppresses startup renderer, PID lock is per-repo) */
  daemonChild?: boolean;
  /** Fired once the per-repo dashboard HTTP server is up (daemon child only). */
  onDaemonReady?: (info: { sock: string; port: number | null }) => void;
  /** Coding-agent id (from `--coding-agent=<id>` install-time flag). Most
   *  authoritative source for agent attribution; stamped on every event
   *  unless a per-client UDS handshake overrides it for that client. */
  codingAgent?: string;
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
let proxyPendingConfirmations:
  | import(
      "../intelligence/pending-confirmations.js"
    ).PendingConfirmationRegistry
  | null = null;

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

// ── Active-cognition Layer B: NotesStore (shares facts.db with TemporalFactStore) ──
type NotesStoreType = import("../intelligence/notes-store.js").NotesStore;
let proxyNotesStore: NotesStoreType | null | undefined = undefined;

async function getProxyNotesStore(
  unerrDir: string
): Promise<NotesStoreType | null> {
  if (proxyNotesStore !== undefined) return proxyNotesStore;
  const factStore = await getProxyFactStore(unerrDir);
  if (!factStore) {
    proxyNotesStore = null;
    return null;
  }
  try {
    const { NotesStore } = await import("../intelligence/notes-store.js");
    proxyNotesStore = new NotesStore(factStore.getDb());
    return proxyNotesStore;
  } catch (err: unknown) {
    process.stderr.write(
      `[unerr] notes-store init failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    proxyNotesStore = null;
    return null;
  }
}

async function handleUnerrRecallNotesProxy(
  args: Record<string, unknown>,
  unerrDir: string,
  behaviorEvents?: import("../tracking/behavior-events.js").BehaviorEventWriter,
  currentTurn?: number,
  // CROSS_REPO_INTELLIGENCE Sprint 7.1: optional federation hook. When provided
  // (home proxy, Pro tier) it returns workspace-relevant notes held by peer
  // repos for the prompt; they are merged after the home notes. Omitted on free
  // tier / standalone proxy → home-only recall, unchanged.
  federate?: (
    prompt: string
  ) => Promise<
    import(
      "../intelligence/federation/cross-repo-recall.js"
    ).FederatedRecallResult
  >
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const store = await getProxyNotesStore(unerrDir);
  if (!store) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "notes store not available. Ensure .unerr/ exists.",
          }),
        },
      ],
      isError: true,
    };
  }
  try {
    const { recallNotes } = await import("../tools/intelligence/notes-mcp.js");
    // session_id drives topic-shift telemetry but the agent doesn't carry one —
    // inject the live session when omitted so the signal fires without it.
    const callerSession = (args as { session_id?: unknown }).session_id;
    const recallArgs =
      (typeof callerSession === "string" && callerSession.length > 0) ||
      !behaviorEvents?.sessionId
        ? args
        : { ...args, session_id: behaviorEvents.sessionId };
    const result = await recallNotes(
      store,
      recallArgs as Parameters<typeof recallNotes>[1]
    );
    // CROSS_REPO_INTELLIGENCE Sprint 7.1: federate. Append workspace-relevant
    // notes held by peer repos (anchor-matched cross-repo references + their `w:`
    // notes) after the home notes, labeled by repo. No-op on free tier / no
    // coordinator (federate omitted) or when the call carries no prompt.
    if (
      federate &&
      result.ok &&
      result.data &&
      typeof args.prompt === "string"
    ) {
      try {
        const fed = await federate(args.prompt);
        if (fed.notes.length > 0) {
          const data = result.data as { notes?: unknown[] };
          data.notes = [...(data.notes ?? []), ...fed.notes];
        }
      } catch {
        /* federation is advisory — a fault never blocks the home recall */
      }
    }
    // Emit a fact_recalled behavior event carrying rich DSL fields from the
    // top returned note. Surface 2 reads these via
    // `renderContextPrefaceLive` → `renderLoadedNoteLine` so the preface can
    // name the note's kind/anchor/polarity without a second NotesStore
    // round-trip on the hot prompt-receipt path.
    if (behaviorEvents && result.ok && result.data) {
      const data = result.data as {
        notes?: Array<{
          kind: string;
          anchor_type: string;
          anchor_value: string;
          polarity: string;
          content: string;
          created_at: number;
          reinforcement_count: number;
          anchor_missing: boolean;
          conflict_group_id: string;
        }>;
      };
      const notes = data.notes ?? [];
      if (notes.length > 0) {
        const top = notes[0];
        if (top) {
          behaviorEvents.record({
            session_id: behaviorEvents.sessionId,
            turn: currentTurn ?? 0,
            type: "fact_recalled",
            tool: "unerr_recall_notes",
            entity_key: top.anchor_value || null,
            response_bytes: null,
            detail: {
              count: notes.length,
              top_content: top.content,
              top_created_at: top.created_at,
              top_kind: top.kind,
              top_anchor_type: top.anchor_type,
              top_anchor_value: top.anchor_value,
              top_polarity: top.polarity,
              top_reinforcement_count: top.reinforcement_count,
              top_anchor_missing: top.anchor_missing,
              top_conflict_group_id: top.conflict_group_id,
            },
          });
        }
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] unerr_recall_notes failed: ${msg}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }
}

async function handleUnerrRememberNotePath(
  args: Record<string, unknown>,
  unerrDir: string,
  sessionId: string
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const store = await getProxyNotesStore(unerrDir);
  if (!store) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "notes store not available. Ensure .unerr/ exists.",
          }),
        },
      ],
      isError: true,
    };
  }
  try {
    const { remember } = await import("../tools/intelligence/notes-mcp.js");
    // session_id is a server-side concern the agent doesn't carry in its
    // context — inject the live ledger session when the caller omits it, so
    // unerr_remember({type:'note', ...}) succeeds without an explicit id.
    const callerSession = (args as { session_id?: unknown }).session_id;
    const argsWithSession =
      typeof callerSession === "string" && callerSession.length > 0
        ? args
        : { ...args, session_id: sessionId };
    const result = await remember(
      store,
      argsWithSession as Parameters<typeof remember>[1]
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] unerr_remember (note) failed: ${msg}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }
}

/** Discriminator: presence of `type` field routes to the new Layer B note path. */
function isActiveCognitionRemember(args: Record<string, unknown>): boolean {
  const t = args.type;
  return (
    t === "note" ||
    t === "cochange" ||
    t === "move_anchor" ||
    t === "promote_to_claude_md"
  );
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
  },
  behaviorEvents?: import("../tracking/behavior-events.js").BehaviorEventWriter
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
    behaviorEvents?.record({
      session_id: shadowLedger.getSessionId(),
      turn: effectiveness?.turn ?? 0,
      type: "fact_stored_auto",
      tool: "record_fact",
      entity_key: (args.subject as string | undefined) ?? null,
      response_bytes: null,
      detail: {
        fact_id: result.fact_id,
        fact_type: args.fact_type,
        scope: args.scope,
        content: args.content,
      },
    });
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

async function ensurePendingConfirmations(
  behaviorEvents?: import("../tracking/behavior-events.js").BehaviorEventWriter
): Promise<
  | import(
      "../intelligence/pending-confirmations.js"
    ).PendingConfirmationRegistry
  | null
> {
  if (proxyPendingConfirmations) return proxyPendingConfirmations;
  if (!behaviorEvents) return null;
  const { PendingConfirmationRegistry } = await import(
    "../intelligence/pending-confirmations.js"
  );
  proxyPendingConfirmations = new PendingConfirmationRegistry(behaviorEvents);
  proxyPendingConfirmations.start();
  return proxyPendingConfirmations;
}

async function handleUnerrRememberProxy(
  args: Record<string, unknown>,
  unerrDir: string,
  shadowLedger: import("../tracking/shadow-ledger.js").ShadowLedger,
  behaviorEvents?: import("../tracking/behavior-events.js").BehaviorEventWriter,
  effectiveness?: {
    tracker: import(
      "../tracking/persistence-effectiveness.js"
    ).PersistenceEffectivenessTracker;
    turn: number;
  }
): Promise<{
  content: Array<{ type: string; text: string }>;
  _meta?: unknown;
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
    const { executeUnerrRemember } = await import(
      "../tools/intelligence/unerr-remember.js"
    );
    const turn = effectiveness?.turn ?? 0;
    const pending = await ensurePendingConfirmations(behaviorEvents);
    const result = await executeUnerrRemember(
      args as unknown as Parameters<typeof executeUnerrRemember>[0],
      factStore,
      shadowLedger.getSessionId(),
      turn,
      behaviorEvents,
      pending ?? undefined
    );
    if (result.stored && effectiveness) {
      effectiveness.tracker.recordSignalFired({
        kind: "fact_recorded",
        signal_id: result.fact_id,
        entity_key: (args.subject as string | undefined) ?? null,
        turn: effectiveness.turn,
      });
    }
    shadowLedger.record(
      "unerr_remember",
      args,
      result.stored ? { fact_id: result.fact_id } : { stored: false },
      "unknown",
      ""
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[unerr] unerr_remember failed: ${errMsg}\n`);
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
  },
  behaviorEvents?: import("../tracking/behavior-events.js").BehaviorEventWriter,
  // CROSS_REPO_INTELLIGENCE Sprint 7.4: optional federation hook. When provided
  // (home proxy, Pro tier) it returns workspace-relevant facts held by peer
  // repos for the scope; they are merged after the home facts, labeled by repo.
  // Omitted on free tier / standalone proxy → home-only recall, unchanged.
  federate?: (
    scope: string,
    factType: string,
    minConfidence: number
  ) => Promise<
    import(
      "../intelligence/federation/cross-repo-fact-recall.js"
    ).FederatedFactRecallResult
  >
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
    if (behaviorEvents && sliced.length > 0) {
      // The first sliced fact rides in the event detail so Surface 2 can
      // name it verbatim ("loaded: \"<content>\" (you set <age>)") without
      // a second NotesStore round-trip on the hot prompt-receipt path.
      const top = sliced[0];
      behaviorEvents.record({
        session_id: behaviorEvents.sessionId,
        turn: effectiveness?.turn ?? 0,
        type: "fact_recalled",
        tool: "recall_facts",
        entity_key: scope ?? null,
        response_bytes: null,
        detail: {
          count: sliced.length,
          fact_types: Array.from(new Set(sliced.map((f) => f.fact_type))),
          top_content: top?.content ?? null,
          top_created_at: top?.created_at ?? null,
        },
      });
    }

    const { REMEMBER_AMBIGUITY_THRESHOLD: RAT } = await import(
      "../tools/intelligence/unerr-remember.js"
    );
    const response = sliced.map((f) => {
      const isUserFed = f.source === "user_fed";
      const lowConfidence = f.effective_confidence < RAT;
      const isPending =
        proxyPendingConfirmations?.isPending(f.fact_id) ?? false;
      const needsConfirmation = isPending || (isUserFed && lowConfidence);
      const base: Record<string, unknown> = {
        fact_id: f.fact_id,
        type: f.fact_type,
        content: f.content,
        confidence: Math.round(f.effective_confidence * 100) / 100,
        subject: f.subject,
        source: f.source,
        reinforced: f.reinforcement_count,
      };
      if (needsConfirmation) base.needs_confirmation = true;
      return base;
    });

    // CROSS_REPO_INTELLIGENCE Sprint 7.4: federate. Append workspace-relevant
    // facts held by peer repos for this scope (entity/file-scoped facts; the
    // peer's `project`-scoped facts are dropped peer-side) after the home facts,
    // each labeled by repo. No-op on free tier / no coordinator (federate
    // omitted) or when the call carries no scope.
    if (federate && typeof scope === "string" && scope.length > 0) {
      try {
        const fed = await federate(scope, factType, minConfidence);
        for (const f of fed.facts) {
          response.push({
            fact_id: f.fact_id,
            type: f.fact_type,
            content: f.content,
            confidence: Math.round(f.effective_confidence * 100) / 100,
            subject: f.subject,
            source: f.source,
            reinforced: f.reinforcement_count,
            repo: f.repo,
          });
        }
      } catch {
        /* federation is advisory — a fault never blocks the home recall */
      }
    }

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

  // Recommend Node ≥22.5 when running below it. Non-blocking — unerr still runs
  // on the supported floor (Node ≥20.9). This runtime notice is the durable
  // channel for the recommendation: it survives npm v12 / pnpm install-script
  // lockdown (a postinstall notice would not). See utils/node-version.ts.
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
  let parseIndex: import("./auto-bootstrap.js").ParseModeIndex | null = null;
  // L11: Background indexing flag — hoisted for access after MCP server.connect()
  let needsBackgroundIndex = false;
  // Bug A: distinguishes a genuine cold index (fresh DB / snapshot migration /
  // no snapshot) from a populated persistent graph that should reindex ONLY the
  // files whose content changed since the last pass — or skip entirely. "full"
  // runs the whole pipeline; "incremental-if-stale" defers a staleness check to
  // after the MCP handshake and does the minimum work it finds.
  let indexMode: "full" | "incremental-if-stale" = "full";

  if ((proxyMode as string) !== "parse") {
    const projectRoot = process.cwd();

    try {
      const { openPersistentDb } = await import(
        "../intelligence/persistent-db.js"
      );
      const { db, isNew, dbPath } = await openPersistentDb(projectRoot);
      graphDbPath = dbPath;

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

  // CROSS_REPO_INTELLIGENCE Sprint 7.1: federated recall hook passed to the
  // recall handler. Fans the prompt out to peers and returns their
  // workspace-relevant notes (anchor-matched + `w:`). The coordinator enforces
  // the Pro-tier gate (free → refusal → empty), so this is wired unconditionally;
  // a standalone proxy with a null coordinator returns empty too.
  const federateRecall = async (prompt: string) => {
    const { federateRecallNotes } = await import(
      "../intelligence/federation/cross-repo-recall.js"
    );
    return federateRecallNotes({
      prompt,
      coordinator: federationCoordinatorRef,
      homeRepo: process.cwd(),
    });
  };
  const federateFacts = async (
    scope: string,
    factType: string,
    minConfidence: number
  ) => {
    const { federateRecallFacts } = await import(
      "../intelligence/federation/cross-repo-fact-recall.js"
    );
    return federateRecallFacts({
      scope,
      factType,
      minConfidence,
      coordinator: federationCoordinatorRef,
      homeRepo: process.cwd(),
    });
  };

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
  const sessionDedup = createSessionDedup();
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

  // Sprint 1.2: Wire fact store for _context injection
  const proxyFactStore = await getProxyFactStore(join(process.cwd(), ".unerr"));
  if (proxyFactStore) {
    router.setFactStore(proxyFactStore);
  }

  // P3 review_changes: give the on-demand review's memory-drift checker the
  // same anchored notes the rest of the session sees, by closing over the
  // proxy's live NotesStore. Null resolution → memory-drift stays silent.
  router.setNotesResolver(async () => {
    const store = await getProxyNotesStore(join(process.cwd(), ".unerr"));
    if (!store) return null;
    const { reviewNotesFromStore } = await import("../review/git-review.js");
    return reviewNotesFromStore(store, "review-changes");
  });

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
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const server = new Server(
    { name: "unerr-local", version: UNERR_VERSION },
    { capabilities: { tools: {} } }
  );

  // Tool definitions imported from shared tool-definitions.ts (single source of truth)
  const toolDefinitions = [...TOOL_DEFINITIONS];

  // S7: Tool usage tracker for semantic cluster reordering
  const toolUsageTracker = new ToolUsageTracker();

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
  // catalog. A retired tool stays dispatchable by name (hook UDS path,
  // op-union) but never reaches the model's view. Computed once — the hidden
  // set is module-load-stable.
  // Advertisement filter: drop any `hidden` catalog member from `tools/list`
  // while keeping it dispatchable by name (hook UDS path, op-union). After the
  // token-overhead deletion the catalog is exactly the 9 advertised tools, so
  // `hiddenToolNames()` is empty and this is a no-op — but it stays load-bearing
  // so a future `hidden:true` entry is honoured without re-plumbing tools/list.
  const HIDDEN_TOOL_NAMES = new Set(hiddenToolNames());
  async function getAdvertisedTools(): Promise<ToolDef[]> {
    const tools = await getInjectedTools();
    return HIDDEN_TOOL_NAMES.size === 0
      ? tools
      : tools.filter((t) => !HIDDEN_TOOL_NAMES.has(t.name));
  }

  // P0-3 + S7: Apply tier-aware exposure rendering (locked tools get the
  // ≤30-token placeholder description, active tools get the full text),
  // then reorder by semantic cluster priority based on recent usage.
  const { renderToolsListForExposure } = await import("./tools-list.js");
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const baseTools = await getAdvertisedTools();
    const gateway = router.getRouterGateway();
    if (!gateway) {
      return {
        tools: reorderToolsByCluster(baseTools, toolUsageTracker),
      };
    }
    const exposed = gateway.exposedTools();
    const knownNames = new Set(
      renderToolsListForExposure(exposed).map((t) => t.name)
    );
    // Replace gateway-known entries with their per-exposure rendering,
    // and pass through everything else (deep-dive tools, etc.) untouched.
    const exposureRendered = new Map(
      renderToolsListForExposure(exposed).map((t) => [t.name, t])
    );
    const merged = baseTools.map((t) =>
      knownNames.has(t.name) ? (exposureRendered.get(t.name) ?? t) : t
    );
    return {
      tools: reorderToolsByCluster(merged, toolUsageTracker),
    };
  });

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
  // ("loaded earlier session") and the engagement-telemetry resume bucket.
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
      },
    });

    // Mirror the resume strip into instruction-only agents (Cursor,
    // Cline, Codex, Gemini CLI, GitHub Copilot CLI). Claude Code gets
    // it live via the SessionStart hook; these agents have no hook
    // surface, so we drop the strip into a file the IDE auto-loads.
    // Best-effort and non-blocking — boot does not wait on this.
    (async () => {
      try {
        const [{ writeSessionStateForAllAgents }, sharedFactStore] =
          await Promise.all([
            import("./session-state-writer.js"),
            getProxyFactStore(unerrDirForLedger),
          ]);
        await writeSessionStateForAllAgents(process.cwd(), {
          unerrDir: unerrDirForLedger,
          factStore: sharedFactStore ?? undefined,
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
    // ── Mandatory-login gate (-32004) ──────────────────────────────────
    // Enforced HERE, at the tools/call choke point, NOT at initialize or
    // tools/list — the agent must connect and receive the catalog so this
    // error text reaches it (and through it, the human). `initialize` and
    // `tools/list` have their own handlers and never pass through here.
    // The verdict is mtime-memoized (loginBlockedCached) to stay inside the
    // <5ms tool budget while still unblocking the next call after a login in
    // another terminal. The error rides the tool-result body (isError + a
    // JSON-RPC-shaped {error:{code,message}}), matching how this function
    // already surfaces validation/translate failures — the SDK and the UDS
    // handler wrap the return as `result`, so a bare top-level `error` would
    // not reach the wire from here.
    if (loginBlockedCached()) {
      const message = loginGateNotice();
      process.stderr.write(`[unerr] tools/call blocked (-32004): ${message}\n`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: { code: LOGIN_BLOCKED_ERROR_CODE, message },
            }),
          },
        ],
        isError: true,
      };
    }

    // Mutable locals so unerr_track aliasing can re-target the dispatch without
    // reassigning the parameters (noParameterAssign). All code below reads these.
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

    // ── Sprint 8: unerr_track op-union → legacy (name, args) ──
    // Translate FIRST so the legacy tool's boundary validation + dispatch run
    // unchanged (single execution path, no behavioural fork). The legacy
    // marker/fact names stay dispatchable by name for UDS hooks + hook-less
    // agents (DEMOTE not delete).
    if (name === "unerr_track") {
      const translated = translateUnerrTrack(args);
      if ("error" in translated) {
        process.stderr.write(`[unerr] unerr_track: ${translated.error}\n`);
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: translated.error }) },
          ],
          isError: true,
        };
      }
      name = translated.name;
      args = translated.args;
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
      return {
        content: [{ type: "text", text: JSON.stringify(validationFailure) }],
        isError: true,
      };
    }

    // S7: Track tool usage for semantic cluster reordering
    toolUsageTracker.record(name);

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
        session_id: behaviorEventWriter.sessionId,
        turn: stats.toolCallsLocal + 1,
        type: "intervention_halted",
        tool: name,
        entity_key: behaviorCtx.entityKey ?? behaviorCtx.filePath ?? null,
        response_bytes: preOutput._context
          ? JSON.stringify(preOutput._context).length
          : null,
        detail: { behavior_id: preOutput.behaviorId },
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

    // ── Active-cognition Layer B: unerr_recall_notes ──
    if (name === "unerr_recall_notes") {
      return handleUnerrRecallNotesProxy(
        args,
        unerrDirForLedger,
        behaviorEventWriter,
        sessionTurnProvider(),
        federateRecall
      );
    }

    // ── Warm recon composite: unerr_context (Sprint 1b) ──
    // Mirrors `unerr recon` in-process: one call collapses the discovery
    // fan-out (notes + search + references + conventions). Notes come warm via
    // the proxy notes store; graph shapes come raw via router.executeRaw.
    if (name === "unerr_context") {
      const { handleUnerrContextProxy } = await import(
        "./unerr-context-handler.js"
      );
      return handleUnerrContextProxy(args as Record<string, unknown>, {
        runRaw: (tool, toolArgs) => router.executeRaw(tool, toolArgs),
        recallNotes: async (prompt) => {
          const res = await handleUnerrRecallNotesProxy(
            { prompt },
            unerrDirForLedger,
            behaviorEventWriter,
            sessionTurnProvider(),
            federateRecall
          );
          const txt = res.content?.[0]?.text;
          if (!txt) return undefined;
          try {
            // Unwrap the recall handler's {ok,data,hint} envelope to the bare
            // {notes:[…]} payload composeRecon's notesEmpty/render expect.
            const parsed = JSON.parse(txt) as Record<string, unknown>;
            return parsed.data ?? parsed;
          } catch {
            return undefined;
          }
        },
        repoCwd: dirname(unerrDirForLedger),
        // E4 Layer A sink: surface the modeled round-trip savings as the
        // SavingsOriginSplit "context bundling" origin (token_flow_event, sync)
        // and as the §4 accounting row (compression_event, event_kind
        // 'context_bundle'). The token_flow detail carries the Layer-B manifest
        // (delivered/expand keys) for the post-hoc reconciliation route.
        recordBundleSavings: (model) => {
          tokenFlowWriter.record({
            session_id: tokenFlowWriter.sessionId,
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
      });
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

    // ── Surface 2 renderer: unerr_surface2_line (Fix B) ──
    if (name === "unerr_surface2_line") {
      const { handleSurface2LineProxy } = await import(
        "./surface2-line-handler.js"
      );
      return handleSurface2LineProxy(
        unerrDirForLedger,
        shadowLedger.getSessionId(),
        sessionTurnProvider(),
        dirname(unerrDirForLedger),
        behaviorEventWriter
      );
    }

    // ── Layer 9: record_fact + recall_facts + unerr_remember ──
    if (
      name === "record_fact" ||
      name === "recall_facts" ||
      name === "unerr_remember"
    ) {
      // Active-cognition dispatch: when `unerr_remember` carries a `type`
      // field (note/cochange/move_anchor/promote_to_claude_md), route to
      // the new NotesStore path; otherwise stay on the TemporalFactStore.
      if (name === "unerr_remember" && isActiveCognitionRemember(args)) {
        return handleUnerrRememberNotePath(
          args,
          unerrDirForLedger,
          shadowLedger.getSessionId()
        );
      }
      const factResult =
        name === "record_fact"
          ? await handleRecordFactProxy(
              args,
              unerrDirForLedger,
              shadowLedger,
              {
                tracker: effectivenessTracker,
                turn: router.sessionContext.getToolCallCount(),
              },
              behaviorEventWriter
            )
          : name === "unerr_remember"
            ? await handleUnerrRememberProxy(
                args,
                unerrDirForLedger,
                shadowLedger,
                behaviorEventWriter,
                {
                  tracker: effectivenessTracker,
                  turn: router.sessionContext.getToolCallCount(),
                }
              )
            : await handleRecallFactsProxy(
                args,
                unerrDirForLedger,
                {
                  tracker: effectivenessTracker,
                  turn: router.sessionContext.getToolCallCount(),
                },
                behaviorEventWriter,
                federateFacts
              );
      const { applyWireCap: applyWireCapFact } = await import("./wire-cap.js");
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
        const {
          body: cappedBody,
          pageHint,
          metrics: factCapMetrics,
        } = applyWireCapFact(name, parsed, args);
        // §4: record the wire-cap event (reversible too_large cache, ordering)
        // on the existing compression_events stream. Best-effort.
        if (factCapMetrics) {
          try {
            const { appendCompressionLog } = await import(
              "./shell-compression-log.js"
            );
            appendCompressionLog(process.cwd(), {
              ts: new Date().toISOString(),
              command: name,
              category: "wire_cap",
              confidence: 1,
              rawBytes: factCapMetrics.original_tokens ?? 0,
              compressedBytes: factCapMetrics.delivered_tokens ?? 0,
              savedPct:
                factCapMetrics.original_tokens &&
                factCapMetrics.original_tokens > 0
                  ? Math.max(
                      0,
                      1 -
                        (factCapMetrics.delivered_tokens ?? 0) /
                          factCapMetrics.original_tokens
                    )
                  : 0,
              omniFallback: false,
              reversible: factCapMetrics,
            });
          } catch {
            /* best effort — metrics never block the wire */
          }
        }
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

    // ── Edit/write tools (file_edit, file_write) ──
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
    if (name === "file_edit" || name === "file_write") {
      const { fileEditTool, fileWriteTool } = await import(
        "../tools/coding/index.js"
      );
      const tool = name === "file_edit" ? fileEditTool : fileWriteTool;
      const t0 = performance.now();
      const out = await tool.execute(args, {
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
      if (narrativeCapture && out.isError !== true) {
        const recentEntries = shadowLedger.getRecentEntries(10);
        const lastEntry = recentEntries[recentEntries.length - 1];
        if (lastEntry) {
          setImmediate(() =>
            narrativeCapture?.captureEditNarrative(lastEntry).catch(() => {})
          );
        }
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
    if (ctx.clientId) {
      resultSummary.client = ctx.clientId;
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
    if (patternAnalysisCallCount % 20 === 0 && proxyFactStore && shadowLedger) {
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

    // Surfaces 2/3/4 (user-prose channel): preface above body, footer
    // below the page hint and above the signal footer. Failures here
    // never break the response.
    const { buildUserBlockForResponse } = await import(
      "./user-block-emitter.js"
    );
    const userBlock = await buildUserBlockForResponse({
      unerrDir: join(process.cwd(), ".unerr"),
      sessionId: shadowLedger.getSessionId(),
      toolCallCount: router.sessionContext.getToolCallCount(),
      filePath:
        ((args as Record<string, unknown>).file_path as string | undefined) ??
        entityKey,
      factStore: proxyFactStore ?? undefined,
      pendingConfirmations: proxyPendingConfirmations ?? undefined,
      isResumedSession: stats.isResumedSession,
      timelineStore: timelineHandle?.store,
      behaviorEvents: behaviorEventWriter,
    });

    // Final assembly: preface → data → page-hint → user footer → signal
    // footer → auth + update lines (signals, so they ride with the footer).
    const finalText =
      userBlock.head +
      bodyText +
      bodyEnd +
      pageBlock +
      userBlock.tail +
      footerBlock +
      authBlock +
      updateBlock;

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
      const helloAgent = (message.params as { agent?: string } | undefined)
        ?.agent;
      if (helloAgent) {
        const resolved = resolveAgentId({
          codingAgent: helloAgent,
          clientInfoName: null,
          detectFromEnv: () => null,
        });
        agentNameByClient.set(clientId, resolved);
        tokenFlowWriter.setAgent(resolved);
        behaviorEventWriter.setAgent(resolved);
        // Shell-compressor exec processes inherit this env to stamp
        // out-of-band compression rows with the right agent id.
        process.env.UNERR_AGENT = resolved;
      }
      return { jsonrpc: "2.0" as const };
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
      // behavior-event panes render them (mirrors the unerr/review_edit block
      // below). The caller-cascade signal (D2) and the architecture-boundary
      // signal (D3) are distinct behaviors; each fires its own row only when
      // it fires. Best-effort — never blocks the control-channel reply.
      recordBlastRadiusTelemetry(
        behaviorEventWriter,
        result,
        blastParams?.file_path ?? null
      );

      return { jsonrpc: "2.0" as const, id: message.id, result };
    }

    // Control channel: in-flight review query (P1 — Surface A). The post-edit
    // hook connects, sends ONE frame, reads ONE response, disconnects. Runs the
    // full review engine (all Tier-1 checkers) against the warm in-process graph
    // server-side — the intelligence stays in the proxy, the hook just formats
    // findings. Always returns a well-formed result (clean + empty on any
    // missing input / absent graph) so the hook never special-cases a degraded
    // proxy. Mirrors `unerr/blast_radius`, of which this is the whole-engine
    // post-edit sibling.
    if (message.method === "unerr/review_edit") {
      // Snapshot so non-null narrowing survives the await (a swap could
      // re-point `liveGraph` mid-call; resolve against the current instance).
      const graphRef = liveGraph;
      const reviewParams = message.params as
        | import("./review-protocol.js").ReviewEditRequestParams
        | undefined;
      const { handleReviewEditRequest } = await import("./review-protocol.js");

      // CROSS_REPO_INTELLIGENCE Sprint 8.2: route the post-edit review to the
      // owning peer when the edited file lives in a federated sibling repo. The
      // home graph has none of the peer's entities, so a foreign-file review
      // would otherwise return clean/empty; routeByPath sends the review to the
      // repo that actually owns the file. Home-owned files compute locally below.
      let result: import("./review-protocol.js").ReviewEditResult | null = null;
      const reviewFilePath = reviewParams?.file_path;
      if (federationCoordinatorRef && reviewFilePath) {
        try {
          const { REVIEW_EDIT_METHOD, isReviewEditResult } = await import(
            "./review-protocol.js"
          );
          const route = await federationCoordinatorRef.routeByPath({
            homeRepo: process.cwd(),
            toolName: REVIEW_EDIT_METHOD,
            args: (reviewParams ?? {}) as Record<string, unknown>,
            filePath: reviewFilePath,
          });
          if (route.routed && isReviewEditResult(route.result)) {
            result = route.result;
          }
        } catch {
          /* fall back to the home compute below */
        }
      }
      if (!result) {
        result = await handleReviewEditRequest(graphRef, reviewParams);
      }

      // Telemetry: one behavior event per emission (not per finding) so the
      // close-out receipt can render a "flagged N review finding(s)" row.
      // Best-effort — never block the control-channel reply.
      if (result.findings.length > 0) {
        try {
          const filePath = reviewParams?.file_path ?? null;
          behaviorEventWriter.record({
            session_id: behaviorEventWriter.sessionId,
            type: "review_finding_surfaced",
            tool: null,
            entity_key: filePath,
            response_bytes: null,
            detail: {
              count: result.findings.length,
              top_severity: result.findings[0]?.severity ?? null,
              suppressed: result.suppressed,
              checkers: [...new Set(result.findings.map((f) => f.checkerId))],
              // P4: was a Tier-2 host-synthesis evidence block injected this edit?
              // Lets the close-out telemetry measure whether the model acts on it.
              synthesis_injected: result.evidenceBlock !== null,
              ...(filePath ? { file_path: filePath } : {}),
            },
          });
        } catch {
          /* best effort — telemetry never blocks the reply */
        }
      }

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
      // CROSS_REPO_INTELLIGENCE Sprint 8.2: peer-side post-edit review executor.
      // The home routes a foreign-file review here; this peer reruns the whole
      // ReviewEngine against ITS warm graph (the file's owning repo) and returns
      // the ReviewEditResult as `content`. Like blast-radius, this is a control
      // method — `executeRaw` can't run it — so it gets its own special-case.
      const { REVIEW_EDIT_METHOD } = await import("./review-protocol.js");
      if (fedName === REVIEW_EDIT_METHOD) {
        try {
          const { handleReviewEditRequest } = await import(
            "./review-protocol.js"
          );
          const content = await handleReviewEditRequest(
            liveGraph,
            fedParams?.arguments as
              | import("./review-protocol.js").ReviewEditRequestParams
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
      // CROSS_REPO_INTELLIGENCE Sprint 7.1: peer-side recall executor. The home
      // proxy fans a prompt out here; this peer recalls its own anchored notes
      // for the prompt — its prompt-matched own-entity/file notes PLUS its `w:`
      // (workspace-wide) notes — and returns them. The home drops this peer's
      // `p:` (project-scoped) notes; only workspace-relevant notes cross. Not an
      // MCP tool, so it can't ride `executeRaw`.
      const { RECALL_NOTES_PEER_METHOD } = await import(
        "../intelligence/federation/cross-repo-recall.js"
      );
      if (fedName === RECALL_NOTES_PEER_METHOD) {
        try {
          const recallPrompt = (
            fedParams?.arguments as { prompt?: unknown } | undefined
          )?.prompt;
          if (typeof recallPrompt !== "string" || recallPrompt.length === 0) {
            return {
              jsonrpc: "2.0" as const,
              id: message.id,
              result: { content: { notes: [] } },
            };
          }
          const peerStore = await getProxyNotesStore(unerrDirForLedger);
          if (!peerStore) {
            return {
              jsonrpc: "2.0" as const,
              id: message.id,
              result: { content: { notes: [] } },
            };
          }
          const recalled = await peerStore.recallByPrompt({
            prompt: recallPrompt,
          });
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: { notes: recalled.notes } },
          };
        } catch {
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: { notes: [] } },
          };
        }
      }
      // CROSS_REPO_INTELLIGENCE Sprint 7.4: peer-side fact-recall executor. The
      // home proxy fans a scope out here; this peer recalls its own temporal
      // facts for the scope and returns them. The home drops this peer's
      // `project`-scoped facts; only entity/file-scoped facts cross. Not an MCP
      // tool, so it can't ride `executeRaw`.
      const { RECALL_FACTS_PEER_METHOD } = await import(
        "../intelligence/federation/cross-repo-fact-recall.js"
      );
      if (fedName === RECALL_FACTS_PEER_METHOD) {
        try {
          const fa = fedParams?.arguments as
            | { scope?: unknown; fact_type?: unknown; min_confidence?: unknown }
            | undefined;
          const factScope = fa?.scope;
          if (typeof factScope !== "string" || factScope.length === 0) {
            return {
              jsonrpc: "2.0" as const,
              id: message.id,
              result: { content: { facts: [] } },
            };
          }
          const peerFactStore = await getProxyFactStore(unerrDirForLedger);
          if (!peerFactStore) {
            return {
              jsonrpc: "2.0" as const,
              id: message.id,
              result: { content: { facts: [] } },
            };
          }
          const minConf =
            typeof fa?.min_confidence === "number" ? fa.min_confidence : 0.3;
          const wantType =
            typeof fa?.fact_type === "string" ? fa.fact_type : "all";
          let peerFacts =
            wantType === "negative"
              ? await peerFactStore.recallNegative(minConf)
              : await peerFactStore.recallByScope(factScope, minConf);
          if (wantType !== "all" && wantType !== "negative") {
            peerFacts = peerFacts.filter((f) => f.fact_type === wantType);
          }
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: { facts: peerFacts } },
          };
        } catch {
          return {
            jsonrpc: "2.0" as const,
            id: message.id,
            result: { content: { facts: [] } },
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

    if (message.method === "tools/list") {
      return {
        jsonrpc: "2.0" as const,
        result: { tools: await getAdvertisedTools() },
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
      const drainDrift = async (): Promise<void> => {
        if (driftBusy || !_driftTracker) return;
        if (graphHolder.isRebuilding) return;
        if (pendingDriftPaths.size === 0) return;
        driftBusy = true;
        const batch = [...pendingDriftPaths];
        pendingDriftPaths.clear();
        const headSha = branchContext?.headSha ?? "unknown";
        try {
          await _driftTracker.processFiles(batch, headSha);
        } catch (err: unknown) {
          process.stderr.write(
            `⚠ [watcher] Drift processing failed: ${formatUnknownError(err)}\n`
          );
        } finally {
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
          // Active-cognition: when an indexed source file is deleted,
          // run the three-tier anchor migration (agent-driven move →
          // git rename detection → silent decay). Fire-and-forget; the
          // notes store guards its own writes.
          const deletedSourcePaths: string[] = [];
          for (const evt of events) {
            if (evt.type !== "delete") continue;
            const ext = evt.path.slice(evt.path.lastIndexOf(".")).toLowerCase();
            // Match the same indexable extensions used by filterIndexableEvents.
            if (
              ext === ".ts" ||
              ext === ".tsx" ||
              ext === ".js" ||
              ext === ".jsx" ||
              ext === ".mjs" ||
              ext === ".cjs" ||
              ext === ".mts" ||
              ext === ".cts" ||
              ext === ".py" ||
              ext === ".go"
            ) {
              deletedSourcePaths.push(evt.path);
            }
          }
          if (deletedSourcePaths.length > 0) {
            void (async () => {
              try {
                const store = await getProxyNotesStore(
                  join(process.cwd(), ".unerr")
                );
                if (!store) return;
                const { handleFileDeletion } = await import(
                  "../intelligence/anchor-migration.js"
                );
                for (const deleted of deletedSourcePaths) {
                  await handleFileDeletion(store, {
                    deleted_path: deleted,
                    repo_dir: process.cwd(),
                  });
                }
              } catch (err: unknown) {
                process.stderr.write(
                  `[unerr] anchor-migration on delete failed: ${err instanceof Error ? err.message : String(err)}\n`
                );
              }
            })();
          }

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

      // Compute health grade now that the graph is populated
      try {
        const { computeHealthGrade } = await import(
          "../intelligence/health-grade.js"
        );
        healthResult = await computeHealthGrade(graph.db);
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

      // Layer 9: Generate temporal facts from detected conventions
      try {
        const factStoreForGen = await getProxyFactStore(unerrDirForLedger);
        if (factStoreForGen) {
          const { detectLocalConventions } = await import(
            "../intelligence/local-convention-detector.js"
          );
          const { generateFromConventions } = await import(
            "../intelligence/fact-generator.js"
          );
          const detection = await detectLocalConventions(graph.db);
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
          const { analyzeSessionPatterns } = await import(
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
      // Layer 8: cancel any pending domain re-derive so it never fires against a
      // graph being torn down (the timer is unref'd, so this is hygiene, not a
      // hang fix).
      domainDeriveScheduler.stop();
      stopBranchPoller?.();
      // Task 7.2: Stop UDS transport (cleans up socket file)
      transportMux.stop();
      // Task 5.3: Stop HTTP transport
      httpTransportHandle?.close();
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
