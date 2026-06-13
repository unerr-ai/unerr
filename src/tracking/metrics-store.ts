/**
 * Metrics Store — `.unerr/metrics.db` (better-sqlite3, WAL).
 *
 * Single source of truth for time-series metric streams that were previously
 * append-only JSONL files:
 *   - compression_events  (was logs/compression.jsonl)
 *   - file_read_events    (was logs/file-reads.jsonl)
 *   - token_flow_events   (was logs/token-flow.jsonl)
 *   - session_history     (was state/session-history.jsonl)
 *   - session_summaries   (was sessions/{session_id}.jsonl)
 *
 * Why SQLite + WAL:
 *   - autoincrement `id` gives a global monotonic counter usable by the
 *     log-tailer (poll `SELECT ... WHERE id > $lastSeen`)
 *   - cross-process writes serialize through WAL — no flock dance
 *   - dashboard aggregations (`SUM/GROUP BY`) become microseconds instead
 *     of "re-parse a 2 MB JSONL on every poll"
 *
 * Singleton per cwd: openMetricsStore() caches the handle so writers and
 * readers share one prepared-statement set per process.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Database as DatabaseT } from "better-sqlite3";

// `better-sqlite3` is a REQUIRED native module — but a native binary can still
// fail to load at runtime (ABI mismatch after a Node upgrade, a corrupt/
// quarantined `.node`, or an incomplete install). metrics-store is on the proxy
// boot path (imported by proxy.ts + 9 other modules), so a STATIC
// `import Database from "better-sqlite3"` would turn any such load failure into
// an `ERR_MODULE_NOT_FOUND`/binding crash of the whole proxy at startup. Metrics
// are pure dashboard telemetry, so the correct degradation is a no-op store —
// not a crash that takes the graph tools down with it. We resolve the driver
// lazily through createRequire and cache the result (or its absence).
// `require("better-sqlite3")` returns the Database constructor directly (the
// package does `module.exports = Database`).
type DatabaseCtor = new (path: string) => DatabaseT;

const requireFromHere = createRequire(import.meta.url);
let cachedDriver: DatabaseCtor | null | undefined;

/** Resolve the better-sqlite3 Database constructor, or null if unavailable.
 *  Result is cached so a missing driver is probed (and warned about) once. */
function loadDatabaseCtor(): DatabaseCtor | null {
  if (cachedDriver !== undefined) return cachedDriver;
  try {
    cachedDriver = requireFromHere("better-sqlite3") as DatabaseCtor;
  } catch (err) {
    cachedDriver = null;
    process.stderr.write(
      `[unerr] WARN: better-sqlite3 native driver unavailable (${err instanceof Error ? err.message : String(err)}); metrics/telemetry disabled (dashboard counters stay empty). Install the prebuilt binary or a build toolchain to enable them — core graph tools are unaffected.\n`
    );
  }
  return cachedDriver;
}

// ── Row types — wire format used by writers/readers ───────────────────

export interface CompressionEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  command: string;
  category: string;
  confidence: number;
  raw_bytes: number;
  compressed_bytes: number;
  saved_pct: number;
  omni_fallback: number; // 0 / 1
  tee_file: string | null;
  // ── §4 reversible-compression fields (REVERSIBLE_COMPRESSION_PLAN.md) ──
  // All nullable/defaulted so legacy rows and existing inserts stay valid.
  // Each engine sprint (S0–S8) populates its own subset; a row that doesn't
  // apply to a saving leaves that field null. Token counts are computed
  // through src/intelligence/token-estimator.ts (o200k_base) on both sides
  // so before/after is apples-to-apples.
  original_tokens: number | null; // S0: tokens before this compression
  delivered_tokens: number | null; // S0: tokens actually put on the wire
  mechanism: string | null; // S0: which of the 7 compressors produced the row
  fidelity_pass: number | null; // S0/S4: 1/0/null — did the must-survive fact survive
  event_kind: string; // S1: 'compress' | 'retrieve' | 'recompute' (default 'compress')
  cache_ref: string | null; // S1: content-hash linking a retrieve back to its compress
  rerequest_saved_tokens: number | null; // S1: tokens saved vs full re-deliver on a retrieve
  cache_hit: number | null; // S1: 1/0/null — did the retrieval hit a live cache entry
  prefix_stable: number | null; // S2: 1/0/null — was the injected prefix byte-identical to last turn
  prefix_bytes: number | null; // S2: size of the injected prefix block
  survivors_by_importance: number | null; // S3: 1/0/null — survivors ordered by graph importance
  dropped_low_importance: number | null; // S3: count of low-fan_in items dropped
  ranking_key: string | null; // S7: 'query' | 'importance' | 'positional'
  query_relevance_pruned: number | null; // S7: chunks pruned by query relevance beyond budget floor
  transcript_footprint_tokens: number | null; // S8: cumulative tokens unerr contributed this session
}

export interface FileReadEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  file: string;
  mode: string;
  total_lines: number;
  returned_lines: number;
  saved_pct: number;
  entity: string | null;
  token_estimate: number | null;
}

export interface TokenFlowEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  session_id: string;
  pid: number;
  turn: number;
  /** Canonical coding-agent id (claude-code, cursor, codex, …) resolved
   *  at writer construction / per-call. "unknown" only when nothing in
   *  the resolution chain (flag → clientInfo → env) yielded a value. */
  agent: string;
  mechanism: string;
  tool: string | null;
  tokens_without: number;
  tokens_with: number;
  tokens_saved: number;
  detail: string | null; // JSON-encoded
}

export interface SessionHistoryRow {
  id: number;
  session_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  tool_calls: number;
  tokens_saved: number;
  tokens_processed: number;
  efficiency: number;
  model_id: string;
  entity_count: number;
  agent_name: string | null;
  token_flow_summary: string | null; // JSON-encoded
}

export interface BehaviorEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  session_id: string;
  pid: number;
  turn: number;
  /** Canonical coding-agent id (claude-code, cursor, codex, …) resolved
   *  at writer construction / per-call. "unknown" only when nothing in
   *  the resolution chain (flag → clientInfo → env) yielded a value. */
  agent: string;
  /** Event type — verb-noun key (e.g. "graph_query_served", "loop_broken",
   *  "cascade_guard", "drift_consumed", "caller_aware_edit",
   *  "intervention_halted", "intervention_warned"). */
  type: string;
  /** MCP tool name when the event was tool-bound; null for behaviors that
   *  fired outside a tool call. */
  tool: string | null;
  /** Entity / file / URL the event was attached to. Null when N/A. */
  entity_key: string | null;
  /** Response bytes delivered when the event came from a tool response;
   *  null for purely-behavioral intercepts (no response to measure). */
  response_bytes: number | null;
  detail: string | null; // JSON-encoded
}

export interface SessionSummaryRow {
  session_id: string;
  written_at: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  tool_calls: number;
  chains: number;
  files_modified: string; // JSON array
  entities_touched: string; // JSON array
  tools_used: string; // JSON object
  feature_areas: string; // JSON array
  facts_recorded: number;
  facts_surfaced: string; // JSON array
  revert_count: number;
  rot_score: number;
  token_estimate: number;
  branch: string;
}

export interface FetchCacheRow {
  url: string;
  content_hash: string;
  markdown: string;
  title: string;
  extractor: string;
  raw_bytes: number;
  compressed_bytes: number;
  fetched_at: number;
  hit_count: number;
  /**
   * Negative-cache marker. Non-null when the last attempt returned a typed
   * blocked status; the value is the anti-bot kind ("cloudflare", "hcaptcha",
   * "perimeterx"). Combined with `fetched_at`, the cache treats this row as
   * a hint to skip the network until the negative-cache TTL elapses.
   */
  blocked_reason: string | null;
  /** ISO 8601 publication date if found (article:published_time / time[datetime]). */
  published_at: string | null;
  /** Author byline (article:author / meta[name=author] / Readability byline). */
  author: string | null;
  /** Open Graph type ("article", "website", "video.movie", etc.). */
  og_type: string | null;
  /** Open Graph site_name ("MDN Web Docs", "GitHub"). */
  site_name: string | null;
  /** Absolute favicon URL resolved against final_url. */
  favicon: string | null;
}

// ── Insert input types — what writers pass in ─────────────────────────

// The §4 reversible-compression fields are OPTIONAL on insert (every one
// defaults to null, except event_kind which defaults to 'compress'), so the
// existing writer (appendCompressionLog) compiles and runs without passing any
// of them. insertCompression coalesces the missing ones to their defaults.
type CompressionEventBase = Omit<
  CompressionEventRow,
  | "id"
  | "original_tokens"
  | "delivered_tokens"
  | "mechanism"
  | "fidelity_pass"
  | "event_kind"
  | "cache_ref"
  | "rerequest_saved_tokens"
  | "cache_hit"
  | "prefix_stable"
  | "prefix_bytes"
  | "survivors_by_importance"
  | "dropped_low_importance"
  | "ranking_key"
  | "query_relevance_pruned"
  | "transcript_footprint_tokens"
>;
export type CompressionEventInsert = CompressionEventBase & {
  original_tokens?: number | null;
  delivered_tokens?: number | null;
  mechanism?: string | null;
  fidelity_pass?: number | null;
  event_kind?: string;
  cache_ref?: string | null;
  rerequest_saved_tokens?: number | null;
  cache_hit?: number | null;
  prefix_stable?: number | null;
  prefix_bytes?: number | null;
  survivors_by_importance?: number | null;
  dropped_low_importance?: number | null;
  ranking_key?: string | null;
  query_relevance_pruned?: number | null;
  transcript_footprint_tokens?: number | null;
};
export type FileReadEventInsert = Omit<FileReadEventRow, "id">;
/** `agent` defaults to "unknown" via DB DEFAULT + writer coalesce, so it's
 *  optional on insert. The on-disk row always has a concrete value. */
export type TokenFlowEventInsert = Omit<TokenFlowEventRow, "id" | "agent"> & {
  agent?: string;
};
export type SessionHistoryInsert = Omit<SessionHistoryRow, "id">;
export type SessionSummaryInsert = SessionSummaryRow;
export type BehaviorEventInsert = Omit<BehaviorEventRow, "id" | "agent"> & {
  agent?: string;
};

// ── Store ─────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compression_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_iso TEXT NOT NULL,
  command TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  raw_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  saved_pct REAL NOT NULL,
  omni_fallback INTEGER NOT NULL,
  tee_file TEXT,
  -- §4 reversible-compression fields (REVERSIBLE_COMPRESSION_PLAN.md).
  -- All nullable / defaulted so existing inserts stay valid. ADDITIVE_COLUMNS
  -- below ALTERs these onto pre-existing DBs (pre-release "edit in place"; no
  -- migration step). Never remove/rename the columns above this comment.
  original_tokens INTEGER,
  delivered_tokens INTEGER,
  mechanism TEXT,
  fidelity_pass INTEGER,
  event_kind TEXT NOT NULL DEFAULT 'compress',
  cache_ref TEXT,
  rerequest_saved_tokens INTEGER,
  cache_hit INTEGER,
  prefix_stable INTEGER,
  prefix_bytes INTEGER,
  survivors_by_importance INTEGER,
  dropped_low_importance INTEGER,
  ranking_key TEXT,
  query_relevance_pruned INTEGER,
  transcript_footprint_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_compression_ts ON compression_events(ts);
CREATE INDEX IF NOT EXISTS idx_compression_category ON compression_events(category);

CREATE TABLE IF NOT EXISTS file_read_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_iso TEXT NOT NULL,
  file TEXT NOT NULL,
  mode TEXT NOT NULL,
  total_lines INTEGER NOT NULL,
  returned_lines INTEGER NOT NULL,
  saved_pct REAL NOT NULL,
  entity TEXT,
  token_estimate INTEGER
);
CREATE INDEX IF NOT EXISTS idx_file_read_ts ON file_read_events(ts);

CREATE TABLE IF NOT EXISTS token_flow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_iso TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT 'unknown',
  mechanism TEXT NOT NULL,
  tool TEXT,
  tokens_without INTEGER NOT NULL,
  tokens_with INTEGER NOT NULL,
  tokens_saved INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_flow_ts ON token_flow_events(ts);
CREATE INDEX IF NOT EXISTS idx_token_flow_session ON token_flow_events(session_id);
CREATE INDEX IF NOT EXISTS idx_token_flow_mechanism ON token_flow_events(mechanism);
-- idx_token_flow_agent is created after reconcileAdditiveColumns runs so
-- legacy DBs (pre-agent-column) can ALTER first before the index references
-- the column.

CREATE TABLE IF NOT EXISTS session_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  tokens_saved INTEGER NOT NULL,
  tokens_processed INTEGER NOT NULL,
  efficiency REAL NOT NULL,
  model_id TEXT NOT NULL,
  entity_count INTEGER NOT NULL,
  agent_name TEXT,
  token_flow_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_history_ended ON session_history(ended_at);

CREATE TABLE IF NOT EXISTS session_summaries (
  session_id TEXT PRIMARY KEY,
  written_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  chains INTEGER NOT NULL,
  files_modified TEXT NOT NULL,
  entities_touched TEXT NOT NULL,
  tools_used TEXT NOT NULL,
  feature_areas TEXT NOT NULL,
  facts_recorded INTEGER NOT NULL,
  facts_surfaced TEXT NOT NULL,
  revert_count INTEGER NOT NULL,
  rot_score REAL NOT NULL,
  token_estimate INTEGER NOT NULL,
  branch TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_ended ON session_summaries(ended_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS behavior_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_iso TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT 'unknown',
  type TEXT NOT NULL,
  tool TEXT,
  entity_key TEXT,
  response_bytes INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_behavior_events_ts ON behavior_events(ts);
CREATE INDEX IF NOT EXISTS idx_behavior_events_session ON behavior_events(session_id);
CREATE INDEX IF NOT EXISTS idx_behavior_events_type ON behavior_events(type);
-- idx_behavior_events_agent: same rationale as the token-flow agent index.

CREATE TABLE IF NOT EXISTS fetch_cache (
  url TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  title TEXT NOT NULL,
  extractor TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  published_at TEXT,
  author TEXT,
  og_type TEXT,
  site_name TEXT,
  favicon TEXT
);
CREATE INDEX IF NOT EXISTS idx_fetch_cache_fetched ON fetch_cache(fetched_at);

CREATE TABLE IF NOT EXISTS agent_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  native_session_id TEXT,
  turn INTEGER NOT NULL,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  tools TEXT,
  files TEXT,
  model TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  UNIQUE(session_id, turn, role)
);
CREATE INDEX IF NOT EXISTS idx_agent_transcripts_session ON agent_transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_transcripts_session_turn ON agent_transcripts(session_id, turn);
`;

const SCHEMA_VERSION = "1";

// Columns added after a table's initial `CREATE TABLE` shipped. SQLite's
// `CREATE TABLE IF NOT EXISTS` won't add new columns to existing tables, so
// without reconciliation a stale schema makes `db.prepare()` throw at proxy
// startup → silent code=1 crash loop. Pre-release policy is "edit schema in
// place" — this list lets us do that without forcing devs to drop tables.
const ADDITIVE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  decl: string;
}> = [
  { table: "fetch_cache", column: "blocked_reason", decl: "TEXT" },
  { table: "fetch_cache", column: "published_at", decl: "TEXT" },
  { table: "fetch_cache", column: "author", decl: "TEXT" },
  { table: "fetch_cache", column: "og_type", decl: "TEXT" },
  { table: "fetch_cache", column: "site_name", decl: "TEXT" },
  { table: "fetch_cache", column: "favicon", decl: "TEXT" },
  // Canonical coding-agent attribution stamped on every event row at
  // write time. Default 'unknown' keeps legacy rows queryable; resolution
  // chain at the writer (codingAgent flag → clientInfo.name → env) fills
  // it correctly for every new row.
  {
    table: "token_flow_events",
    column: "agent",
    decl: "TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    table: "behavior_events",
    column: "agent",
    decl: "TEXT NOT NULL DEFAULT 'unknown'",
  },
  // §4 reversible-compression fields. ALTER them onto pre-existing
  // compression_events tables (the SCHEMA block above only creates them on a
  // fresh DB). All nullable / defaulted so legacy rows stay valid.
  { table: "compression_events", column: "original_tokens", decl: "INTEGER" },
  { table: "compression_events", column: "delivered_tokens", decl: "INTEGER" },
  { table: "compression_events", column: "mechanism", decl: "TEXT" },
  { table: "compression_events", column: "fidelity_pass", decl: "INTEGER" },
  {
    table: "compression_events",
    column: "event_kind",
    decl: "TEXT NOT NULL DEFAULT 'compress'",
  },
  { table: "compression_events", column: "cache_ref", decl: "TEXT" },
  {
    table: "compression_events",
    column: "rerequest_saved_tokens",
    decl: "INTEGER",
  },
  { table: "compression_events", column: "cache_hit", decl: "INTEGER" },
  { table: "compression_events", column: "prefix_stable", decl: "INTEGER" },
  { table: "compression_events", column: "prefix_bytes", decl: "INTEGER" },
  {
    table: "compression_events",
    column: "survivors_by_importance",
    decl: "INTEGER",
  },
  {
    table: "compression_events",
    column: "dropped_low_importance",
    decl: "INTEGER",
  },
  { table: "compression_events", column: "ranking_key", decl: "TEXT" },
  {
    table: "compression_events",
    column: "query_relevance_pruned",
    decl: "INTEGER",
  },
  {
    table: "compression_events",
    column: "transcript_footprint_tokens",
    decl: "INTEGER",
  },
];

function reconcileAdditiveColumns(db: DatabaseT): void {
  for (const { table, column, decl } of ADDITIVE_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (cols.length === 0) continue; // table not created yet — SCHEMA already covers it
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// Indexes that depend on additive columns. Must run AFTER
// reconcileAdditiveColumns or legacy DBs (created before the column shipped)
// fail at startup with `no such column: <name>`.
const POST_RECONCILE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_token_flow_agent ON token_flow_events(agent);
CREATE INDEX IF NOT EXISTS idx_behavior_events_agent ON behavior_events(agent);
`;

interface Statements {
  insertCompression: ReturnType<DatabaseT["prepare"]>;
  insertFileRead: ReturnType<DatabaseT["prepare"]>;
  insertTokenFlow: ReturnType<DatabaseT["prepare"]>;
  insertBehaviorEvent: ReturnType<DatabaseT["prepare"]>;
  upsertSessionHistory: ReturnType<DatabaseT["prepare"]>;
  upsertSessionSummary: ReturnType<DatabaseT["prepare"]>;
  recentCompression: ReturnType<DatabaseT["prepare"]>;
  recentFileReads: ReturnType<DatabaseT["prepare"]>;
  compressionSince: ReturnType<DatabaseT["prepare"]>;
  reversibleSavedSince: ReturnType<DatabaseT["prepare"]>;
  reversibleSavedTotal: ReturnType<DatabaseT["prepare"]>;
  transcriptFootprintLatest: ReturnType<DatabaseT["prepare"]>;
  fileReadsSince: ReturnType<DatabaseT["prepare"]>;
  tokenFlowSince: ReturnType<DatabaseT["prepare"]>;
  tokenFlowAll: ReturnType<DatabaseT["prepare"]>;
  tokenFlowBySession: ReturnType<DatabaseT["prepare"]>;
  tokenFlowSessionSum: ReturnType<DatabaseT["prepare"]>;
  behaviorEventsAll: ReturnType<DatabaseT["prepare"]>;
  behaviorEventsBySession: ReturnType<DatabaseT["prepare"]>;
  behaviorEventsSince: ReturnType<DatabaseT["prepare"]>;
  allSessionHistory: ReturnType<DatabaseT["prepare"]>;
  sessionSummaryById: ReturnType<DatabaseT["prepare"]>;
  allSessionSummaries: ReturnType<DatabaseT["prepare"]>;
  upsertFetchCache: ReturnType<DatabaseT["prepare"]>;
  getFetchCache: ReturnType<DatabaseT["prepare"]>;
  bumpFetchCacheHit: ReturnType<DatabaseT["prepare"]>;
  upsertAgentTranscript: ReturnType<DatabaseT["prepare"]>;
  agentTranscriptsBySession: ReturnType<DatabaseT["prepare"]>;
  agentTranscriptsBySessionTurn: ReturnType<DatabaseT["prepare"]>;
  agentTranscriptSessionExists: ReturnType<DatabaseT["prepare"]>;
}

export class MetricsStore {
  // Null when the better-sqlite3 native driver is unavailable — the store then
  // degrades to a no-op (writes drop, reads return empty). See loadDatabaseCtor.
  private readonly db: DatabaseT | null;
  private readonly stmt: Statements | null;

  constructor(dbPath: string) {
    const Database = loadDatabaseCtor();
    if (!Database) {
      // Driver absent — degrade to a no-op store. Every method short-circuits
      // on the null `stmt`/`db` guard below.
      this.db = null;
      this.stmt = null;
      return;
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    reconcileAdditiveColumns(this.db);
    this.db.exec(POST_RECONCILE_INDEXES);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("schema_version", SCHEMA_VERSION);

    this.stmt = {
      insertCompression: this.db.prepare(`
        INSERT INTO compression_events
          (ts, ts_iso, command, category, confidence, raw_bytes, compressed_bytes,
           saved_pct, omni_fallback, tee_file,
           original_tokens, delivered_tokens, mechanism, fidelity_pass, event_kind,
           cache_ref, rerequest_saved_tokens, cache_hit, prefix_stable, prefix_bytes,
           survivors_by_importance, dropped_low_importance, ranking_key,
           query_relevance_pruned, transcript_footprint_tokens)
        VALUES (@ts, @ts_iso, @command, @category, @confidence, @raw_bytes,
                @compressed_bytes, @saved_pct, @omni_fallback, @tee_file,
                @original_tokens, @delivered_tokens, @mechanism, @fidelity_pass, @event_kind,
                @cache_ref, @rerequest_saved_tokens, @cache_hit, @prefix_stable, @prefix_bytes,
                @survivors_by_importance, @dropped_low_importance, @ranking_key,
                @query_relevance_pruned, @transcript_footprint_tokens)
      `),
      insertFileRead: this.db.prepare(`
        INSERT INTO file_read_events
          (ts, ts_iso, file, mode, total_lines, returned_lines, saved_pct,
           entity, token_estimate)
        VALUES (@ts, @ts_iso, @file, @mode, @total_lines, @returned_lines,
                @saved_pct, @entity, @token_estimate)
      `),
      insertTokenFlow: this.db.prepare(`
        INSERT INTO token_flow_events
          (ts, ts_iso, session_id, pid, turn, agent, mechanism, tool,
           tokens_without, tokens_with, tokens_saved, detail)
        VALUES (@ts, @ts_iso, @session_id, @pid, @turn, @agent, @mechanism, @tool,
                @tokens_without, @tokens_with, @tokens_saved, @detail)
      `),
      insertBehaviorEvent: this.db.prepare(`
        INSERT INTO behavior_events
          (ts, ts_iso, session_id, pid, turn, agent, type, tool,
           entity_key, response_bytes, detail)
        VALUES (@ts, @ts_iso, @session_id, @pid, @turn, @agent, @type, @tool,
                @entity_key, @response_bytes, @detail)
      `),
      upsertSessionHistory: this.db.prepare(`
        INSERT INTO session_history
          (session_id, started_at, ended_at, duration_ms, tool_calls, tokens_saved,
           tokens_processed, efficiency, model_id, entity_count,
           agent_name, token_flow_summary)
        VALUES (@session_id, @started_at, @ended_at, @duration_ms, @tool_calls,
                @tokens_saved, @tokens_processed, @efficiency,
                @model_id, @entity_count, @agent_name, @token_flow_summary)
        ON CONFLICT(session_id) DO UPDATE SET
          ended_at = excluded.ended_at,
          duration_ms = excluded.duration_ms,
          tool_calls = excluded.tool_calls,
          tokens_saved = excluded.tokens_saved,
          tokens_processed = excluded.tokens_processed,
          efficiency = excluded.efficiency,
          entity_count = excluded.entity_count,
          token_flow_summary = excluded.token_flow_summary
      `),
      upsertSessionSummary: this.db.prepare(`
        INSERT INTO session_summaries
          (session_id, written_at, started_at, ended_at, duration_ms, tool_calls,
           chains, files_modified, entities_touched, tools_used, feature_areas,
           facts_recorded, facts_surfaced, revert_count, rot_score, token_estimate,
           branch)
        VALUES (@session_id, @written_at, @started_at, @ended_at, @duration_ms,
                @tool_calls, @chains, @files_modified, @entities_touched,
                @tools_used, @feature_areas, @facts_recorded, @facts_surfaced,
                @revert_count, @rot_score, @token_estimate, @branch)
        ON CONFLICT(session_id) DO UPDATE SET
          written_at = excluded.written_at,
          ended_at = excluded.ended_at,
          duration_ms = excluded.duration_ms,
          tool_calls = excluded.tool_calls,
          chains = excluded.chains,
          files_modified = excluded.files_modified,
          entities_touched = excluded.entities_touched,
          tools_used = excluded.tools_used,
          feature_areas = excluded.feature_areas,
          facts_recorded = excluded.facts_recorded,
          facts_surfaced = excluded.facts_surfaced,
          revert_count = excluded.revert_count,
          rot_score = excluded.rot_score,
          token_estimate = excluded.token_estimate,
          branch = excluded.branch
      `),
      recentCompression: this.db.prepare(`
        SELECT * FROM compression_events ORDER BY id DESC LIMIT @limit
      `),
      recentFileReads: this.db.prepare(`
        SELECT * FROM file_read_events ORDER BY id DESC LIMIT @limit
      `),
      compressionSince: this.db.prepare(`
        SELECT * FROM compression_events WHERE id > @lastId ORDER BY id ASC LIMIT @limit
      `),
      // Sum reversibility re-request savings (S1 retrieve rows) since a wall-
      // clock boundary, fidelity-honest: a row whose probe FAILED
      // (fidelity_pass = 0) is excluded so the per-turn economy line never
      // counts a saving that dropped the answer (Sprint U TU.7/TU.9). NULL
      // fidelity (unprobed) still counts — a retrieve is lossless by
      // construction (it returns a verbatim slice of the cached original).
      reversibleSavedSince: this.db.prepare(`
        SELECT COALESCE(SUM(rerequest_saved_tokens), 0) AS total
        FROM compression_events
        WHERE event_kind = 'retrieve'
          AND ts >= @sinceTs
          AND COALESCE(fidelity_pass, 1) <> 0
      `),
      // Whole-store reversibility savings (session-cumulative — the metrics
      // store is per-repo, so every retrieve row belongs to this repo's
      // activity). Same fidelity gate as reversibleSavedSince.
      reversibleSavedTotal: this.db.prepare(`
        SELECT COALESCE(SUM(rerequest_saved_tokens), 0) AS total
        FROM compression_events
        WHERE event_kind = 'retrieve'
          AND COALESCE(fidelity_pass, 1) <> 0
      `),
      // Latest cumulative transcript-footprint estimate (S8). The writers
      // stamp a running per-session total on each compress row; the most
      // recent non-null value is the current estimate.
      transcriptFootprintLatest: this.db.prepare(`
        SELECT transcript_footprint_tokens AS footprint
        FROM compression_events
        WHERE transcript_footprint_tokens IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `),
      fileReadsSince: this.db.prepare(`
        SELECT * FROM file_read_events WHERE id > @lastId ORDER BY id ASC LIMIT @limit
      `),
      tokenFlowSince: this.db.prepare(`
        SELECT * FROM token_flow_events WHERE id > @lastId ORDER BY id ASC LIMIT @limit
      `),
      tokenFlowAll: this.db.prepare(`
        SELECT * FROM token_flow_events ORDER BY id ASC
      `),
      tokenFlowBySession: this.db.prepare(`
        SELECT * FROM token_flow_events WHERE session_id = @sessionId ORDER BY id ASC
      `),
      tokenFlowSessionSum: this.db.prepare(`
        SELECT COALESCE(SUM(tokens_saved), 0) AS total
        FROM token_flow_events WHERE session_id = @sessionId
      `),
      behaviorEventsAll: this.db.prepare(`
        SELECT * FROM behavior_events ORDER BY id ASC
      `),
      behaviorEventsBySession: this.db.prepare(`
        SELECT * FROM behavior_events WHERE session_id = @sessionId ORDER BY id ASC
      `),
      behaviorEventsSince: this.db.prepare(`
        SELECT * FROM behavior_events WHERE id > @lastId ORDER BY id ASC LIMIT @limit
      `),
      allSessionHistory: this.db.prepare(`
        SELECT * FROM session_history ORDER BY ended_at ASC
      `),
      sessionSummaryById: this.db.prepare(`
        SELECT * FROM session_summaries WHERE session_id = @sessionId
      `),
      allSessionSummaries: this.db.prepare(`
        SELECT * FROM session_summaries ORDER BY ended_at DESC
      `),
      upsertFetchCache: this.db.prepare(`
        INSERT INTO fetch_cache
          (url, content_hash, markdown, title, extractor,
           raw_bytes, compressed_bytes, fetched_at, hit_count, blocked_reason,
           published_at, author, og_type, site_name, favicon)
        VALUES (@url, @content_hash, @markdown, @title, @extractor,
                @raw_bytes, @compressed_bytes, @fetched_at, 0, @blocked_reason,
                @published_at, @author, @og_type, @site_name, @favicon)
        ON CONFLICT(url) DO UPDATE SET
          content_hash = excluded.content_hash,
          markdown = excluded.markdown,
          title = excluded.title,
          extractor = excluded.extractor,
          raw_bytes = excluded.raw_bytes,
          compressed_bytes = excluded.compressed_bytes,
          fetched_at = excluded.fetched_at,
          blocked_reason = excluded.blocked_reason,
          published_at = excluded.published_at,
          author = excluded.author,
          og_type = excluded.og_type,
          site_name = excluded.site_name,
          favicon = excluded.favicon
      `),
      getFetchCache: this.db.prepare(`
        SELECT * FROM fetch_cache WHERE url = @url
      `),
      bumpFetchCacheHit: this.db.prepare(`
        UPDATE fetch_cache SET hit_count = hit_count + 1 WHERE url = @url
      `),
      upsertAgentTranscript: this.db.prepare(`
        INSERT INTO agent_transcripts
          (session_id, native_session_id, turn, agent, role, text, tools, files,
           model, tokens_input, tokens_output, ts)
        VALUES (@session_id, @native_session_id, @turn, @agent, @role, @text,
                @tools, @files, @model, @tokens_input, @tokens_output, @ts)
        ON CONFLICT(session_id, turn, role) DO UPDATE SET
          native_session_id = excluded.native_session_id,
          text = excluded.text,
          tools = excluded.tools,
          files = excluded.files,
          model = excluded.model,
          tokens_input = excluded.tokens_input,
          tokens_output = excluded.tokens_output,
          ts = excluded.ts
      `),
      agentTranscriptsBySession: this.db.prepare(`
        SELECT * FROM agent_transcripts WHERE session_id = @session_id ORDER BY turn ASC, role ASC
      `),
      agentTranscriptsBySessionTurn: this.db.prepare(`
        SELECT * FROM agent_transcripts WHERE session_id = @session_id AND turn = @turn ORDER BY role ASC
      `),
      agentTranscriptSessionExists: this.db.prepare(`
        SELECT 1 FROM agent_transcripts WHERE session_id = @session_id LIMIT 1
      `),
    };
  }

  upsertFetchCacheRow(row: FetchCacheRow): void {
    if (!this.stmt) return;
    this.stmt.upsertFetchCache.run(row);
  }

  getFetchCacheRow(url: string): FetchCacheRow | null {
    if (!this.stmt) return null;
    return (
      (this.stmt.getFetchCache.get({ url }) as FetchCacheRow | undefined) ??
      null
    );
  }

  bumpFetchCacheHitFor(url: string): void {
    if (!this.stmt) return;
    this.stmt.bumpFetchCacheHit.run({ url });
  }

  // ── Agent Transcripts ───────────────────────────────────────────────

  upsertAgentTranscript(row: {
    session_id: string;
    native_session_id: string | null;
    turn: number;
    agent: string;
    role: string;
    text: string | null;
    tools: string | null;
    files: string | null;
    model: string | null;
    tokens_input: number;
    tokens_output: number;
    ts: string;
  }): void {
    if (!this.stmt) return;
    this.stmt.upsertAgentTranscript.run(row);
  }

  getAgentTranscriptsForSession(session_id: string): Array<{
    id: number;
    session_id: string;
    native_session_id: string | null;
    turn: number;
    agent: string;
    role: string;
    text: string | null;
    tools: string | null;
    files: string | null;
    model: string | null;
    tokens_input: number;
    tokens_output: number;
    ts: string;
  }> {
    if (!this.stmt) return [];
    return this.stmt.agentTranscriptsBySession.all({ session_id }) as never;
  }

  getAgentTranscriptsForTurn(
    session_id: string,
    turn: number
  ): Array<{
    id: number;
    session_id: string;
    native_session_id: string | null;
    turn: number;
    agent: string;
    role: string;
    text: string | null;
    tools: string | null;
    files: string | null;
    model: string | null;
    tokens_input: number;
    tokens_output: number;
    ts: string;
  }> {
    if (!this.stmt) return [];
    return this.stmt.agentTranscriptsBySessionTurn.all({
      session_id,
      turn,
    }) as never;
  }

  hasAgentTranscripts(session_id: string): boolean {
    if (!this.stmt) return false;
    return !!this.stmt.agentTranscriptSessionExists.get({ session_id });
  }

  // ── Writes ──────────────────────────────────────────────────────────

  insertCompression(row: CompressionEventInsert): number {
    if (!this.stmt) return 0;
    // better-sqlite3 named binding requires every @param to be present on the
    // object, so coalesce the optional §4 fields to their defaults (null, or
    // 'compress' for event_kind). Existing callers pass none of them.
    const full: Omit<CompressionEventRow, "id"> = {
      ts: row.ts,
      ts_iso: row.ts_iso,
      command: row.command,
      category: row.category,
      confidence: row.confidence,
      raw_bytes: row.raw_bytes,
      compressed_bytes: row.compressed_bytes,
      saved_pct: row.saved_pct,
      omni_fallback: row.omni_fallback,
      tee_file: row.tee_file,
      original_tokens: row.original_tokens ?? null,
      delivered_tokens: row.delivered_tokens ?? null,
      mechanism: row.mechanism ?? null,
      fidelity_pass: row.fidelity_pass ?? null,
      event_kind: row.event_kind ?? "compress",
      cache_ref: row.cache_ref ?? null,
      rerequest_saved_tokens: row.rerequest_saved_tokens ?? null,
      cache_hit: row.cache_hit ?? null,
      prefix_stable: row.prefix_stable ?? null,
      prefix_bytes: row.prefix_bytes ?? null,
      survivors_by_importance: row.survivors_by_importance ?? null,
      dropped_low_importance: row.dropped_low_importance ?? null,
      ranking_key: row.ranking_key ?? null,
      query_relevance_pruned: row.query_relevance_pruned ?? null,
      transcript_footprint_tokens: row.transcript_footprint_tokens ?? null,
    };
    return Number(this.stmt.insertCompression.run(full).lastInsertRowid);
  }

  insertFileRead(row: FileReadEventInsert): number {
    if (!this.stmt) return 0;
    return Number(this.stmt.insertFileRead.run(row).lastInsertRowid);
  }

  insertTokenFlow(row: TokenFlowEventInsert): number {
    if (!this.stmt) return 0;
    const withAgent = { ...row, agent: row.agent ?? "unknown" };
    return Number(this.stmt.insertTokenFlow.run(withAgent).lastInsertRowid);
  }

  insertBehaviorEvent(row: BehaviorEventInsert): number {
    if (!this.stmt) return 0;
    const withAgent = { ...row, agent: row.agent ?? "unknown" };
    return Number(this.stmt.insertBehaviorEvent.run(withAgent).lastInsertRowid);
  }

  upsertSessionHistory(row: SessionHistoryInsert): void {
    if (!this.stmt) return;
    this.stmt.upsertSessionHistory.run(row);
  }

  upsertSessionSummary(row: SessionSummaryInsert): void {
    if (!this.stmt) return;
    this.stmt.upsertSessionSummary.run(row);
  }

  // ── Reads ───────────────────────────────────────────────────────────

  recentCompression(limit: number): CompressionEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.recentCompression.all({ limit }) as CompressionEventRow[];
  }

  recentFileReads(limit: number): FileReadEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.recentFileReads.all({ limit }) as FileReadEventRow[];
  }

  /** Poll API used by the log-tailer. */
  compressionSince(lastId: number, limit = 500): CompressionEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.compressionSince.all({
      lastId,
      limit,
    }) as CompressionEventRow[];
  }

  /**
   * Sum reversibility re-request savings (`rerequest_saved_tokens` on S1
   * `event_kind:'retrieve'` rows) recorded at or after `sinceTs` (epoch ms).
   * Fidelity-honest: rows whose probe failed (`fidelity_pass = 0`) are
   * excluded so the per-turn economy line never counts a saving that dropped
   * the answer. Drives Sprint U TU.7 — folding reversibility into the
   * per-turn `unerr »` total.
   */
  reversibleSavedSince(sinceTs: number): number {
    if (!this.stmt) return 0;
    const row = this.stmt.reversibleSavedSince.get({ sinceTs }) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  /**
   * Whole-store reversibility re-request savings (session-cumulative — the
   * metrics store is per-repo). Same fidelity gate as
   * {@link reversibleSavedSince}.
   */
  reversibleSavedTotal(): number {
    if (!this.stmt) return 0;
    const row = this.stmt.reversibleSavedTotal.get({}) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  /**
   * Latest cumulative transcript-footprint estimate (`transcript_footprint_tokens`,
   * Sprint S8) — the most recent non-null running total of tool-output tokens
   * unerr put into the transcript. 0 when nothing has been stamped yet.
   */
  transcriptFootprintLatest(): number {
    if (!this.stmt) return 0;
    const row = this.stmt.transcriptFootprintLatest.get({}) as
      | { footprint: number | null }
      | undefined;
    return row?.footprint ?? 0;
  }

  fileReadsSince(lastId: number, limit = 500): FileReadEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.fileReadsSince.all({
      lastId,
      limit,
    }) as FileReadEventRow[];
  }

  tokenFlowSince(lastId: number, limit = 500): TokenFlowEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.tokenFlowSince.all({
      lastId,
      limit,
    }) as TokenFlowEventRow[];
  }

  allTokenFlow(): TokenFlowEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.tokenFlowAll.all({}) as TokenFlowEventRow[];
  }

  tokenFlowBySession(sessionId: string): TokenFlowEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.tokenFlowBySession.all({
      sessionId,
    }) as TokenFlowEventRow[];
  }

  /**
   * Running total of `tokens_saved` for one session — authoritative across
   * process restarts (sums the persisted table, not an in-memory counter).
   * Used by the log tailer to stamp a real cumulative on relayed child/exec
   * token-flow lines instead of a hardcoded 0.
   */
  sessionTokensSaved(sessionId: string): number {
    if (!this.stmt) return 0;
    const row = this.stmt.tokenFlowSessionSum.get({ sessionId }) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  allBehaviorEvents(): BehaviorEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.behaviorEventsAll.all({}) as BehaviorEventRow[];
  }

  behaviorEventsBySession(sessionId: string): BehaviorEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.behaviorEventsBySession.all({
      sessionId,
    }) as BehaviorEventRow[];
  }

  /**
   * The most recent `user_prompt_received` boundary row for `sessionId` —
   * its epoch-ms `ts` and the prompt content digest `hash` (from the row's
   * `detail` JSON) — or `null` when none exists. Indexed scan over
   * (session_id, type) ordered by ts desc — O(log n).
   *
   * Used by the prompt-capture hook to dedupe duplicate boundary writes:
   * the UserPromptSubmit hook can fire 2-3× per real prompt (observed
   * 11-20ms apart), each carrying the IDENTICAL message. Those extra rows
   * pollute the turn-boundary stream that `latestPromptBoundaryTs` keys off,
   * collapsing the per-turn slice to an empty sliver. The hook compares both
   * `ts` (recency) and `hash` (exact re-fire) — the digest is always written
   * even when prompt content capture is opt-out (it is not the content), so
   * the dedupe never depends on `capture_prompts` and never collapses two
   * genuinely distinct prompts that happen to share a length.
   *
   * `hash` is `null` for legacy rows written before the digest field existed.
   */
  latestUserPromptBoundary(
    sessionId: string
  ): { ts: number; hash: string | null } | null {
    if (!this.db) return null;
    const row = this.db
      .prepare(
        "SELECT ts, detail FROM behavior_events WHERE session_id = ? AND type = 'user_prompt_received' ORDER BY ts DESC LIMIT 1"
      )
      .get(sessionId) as { ts: number; detail: string | null } | undefined;
    if (!row) return null;
    let hash: string | null = null;
    try {
      const parsed = JSON.parse(row.detail ?? "{}") as {
        prompt_hash?: unknown;
      };
      if (typeof parsed.prompt_hash === "string") hash = parsed.prompt_hash;
    } catch {
      /* malformed detail — leave hash null (never matches a real prompt) */
    }
    return { ts: row.ts, hash };
  }

  behaviorEventsSince(lastId: number, limit = 500): BehaviorEventRow[] {
    if (!this.stmt) return [];
    return this.stmt.behaviorEventsSince.all({
      lastId,
      limit,
    }) as BehaviorEventRow[];
  }

  allSessionHistory(): SessionHistoryRow[] {
    if (!this.stmt) return [];
    return this.stmt.allSessionHistory.all({}) as SessionHistoryRow[];
  }

  sessionSummary(sessionId: string): SessionSummaryRow | null {
    if (!this.stmt) return null;
    return (this.stmt.sessionSummaryById.get({ sessionId }) ??
      null) as SessionSummaryRow | null;
  }

  allSessionSummaries(): SessionSummaryRow[] {
    if (!this.stmt) return [];
    return this.stmt.allSessionSummaries.all({}) as SessionSummaryRow[];
  }

  /**
   * Current max id in each of the three polled tables — used by the
   * log-tailer to skip events that already existed when it started.
   * `COALESCE(MAX(id), 0)` keeps the call O(1) on an indexed PK.
   */
  lastIds(): {
    compression: number;
    fileRead: number;
    tokenFlow: number;
    behaviorEvent: number;
  } {
    if (!this.db)
      return { compression: 0, fileRead: 0, tokenFlow: 0, behaviorEvent: 0 };
    const c = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM compression_events")
      .get() as { id: number };
    const f = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM file_read_events")
      .get() as { id: number };
    const t = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM token_flow_events")
      .get() as { id: number };
    const b = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM behavior_events")
      .get() as { id: number };
    return {
      compression: c.id,
      fileRead: f.id,
      tokenFlow: t.id,
      behaviorEvent: b.id,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  close(): void {
    if (!this.db) return;
    this.db.close();
  }

  /** Test-only — wipe every metric table. */
  reset(): void {
    if (!this.db) return;
    this.db.exec(`
      DELETE FROM compression_events;
      DELETE FROM file_read_events;
      DELETE FROM token_flow_events;
      DELETE FROM behavior_events;
      DELETE FROM session_history;
      DELETE FROM session_summaries;
      DELETE FROM agent_transcripts;
      DELETE FROM sqlite_sequence WHERE name IN
        ('compression_events','file_read_events','token_flow_events','behavior_events','session_history','agent_transcripts');
    `);
  }
}

// ── Per-cwd singleton ────────────────────────────────────────────────

const instances = new Map<string, MetricsStore>();

/**
 * Open (or reuse) the metrics store for a given unerr directory.
 * `.unerr/metrics.db` is created on first call; the schema bootstrap is
 * idempotent (CREATE TABLE IF NOT EXISTS).
 */
export function openMetricsStore(unerrDir: string): MetricsStore {
  let store = instances.get(unerrDir);
  if (!store) {
    mkdirSync(unerrDir, { recursive: true });
    store = new MetricsStore(join(unerrDir, "metrics.db"));
    instances.set(unerrDir, store);
  }
  return store;
}

/** Test-only — close + drop the cached instance for an `unerrDir`. */
export function closeMetricsStore(unerrDir: string): void {
  const store = instances.get(unerrDir);
  if (store) {
    store.close();
    instances.delete(unerrDir);
  }
}

/** Close every cached instance — called on process shutdown. */
export function closeAllMetricsStores(): void {
  for (const [dir, store] of instances) {
    try {
      store.close();
    } catch {
      /* best effort */
    }
    instances.delete(dir);
  }
}
