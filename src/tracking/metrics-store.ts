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
import { join } from "node:path";
import Database, { type Database as DatabaseT } from "better-sqlite3";

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
  dollars_saved: number;
  model_id: string;
  entity_count: number;
  agent_name: string | null;
  token_flow_summary: string | null; // JSON-encoded
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

// ── Insert input types — what writers pass in ─────────────────────────

export type CompressionEventInsert = Omit<CompressionEventRow, "id">;
export type FileReadEventInsert = Omit<FileReadEventRow, "id">;
export type TokenFlowEventInsert = Omit<TokenFlowEventRow, "id">;
export type SessionHistoryInsert = Omit<SessionHistoryRow, "id">;
export type SessionSummaryInsert = SessionSummaryRow;

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
  tee_file TEXT
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
  dollars_saved REAL NOT NULL,
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
`;

const SCHEMA_VERSION = "1";

interface Statements {
  insertCompression: ReturnType<DatabaseT["prepare"]>;
  insertFileRead: ReturnType<DatabaseT["prepare"]>;
  insertTokenFlow: ReturnType<DatabaseT["prepare"]>;
  upsertSessionHistory: ReturnType<DatabaseT["prepare"]>;
  upsertSessionSummary: ReturnType<DatabaseT["prepare"]>;
  recentCompression: ReturnType<DatabaseT["prepare"]>;
  recentFileReads: ReturnType<DatabaseT["prepare"]>;
  compressionSince: ReturnType<DatabaseT["prepare"]>;
  fileReadsSince: ReturnType<DatabaseT["prepare"]>;
  tokenFlowSince: ReturnType<DatabaseT["prepare"]>;
  tokenFlowAll: ReturnType<DatabaseT["prepare"]>;
  tokenFlowBySession: ReturnType<DatabaseT["prepare"]>;
  allSessionHistory: ReturnType<DatabaseT["prepare"]>;
  sessionSummaryById: ReturnType<DatabaseT["prepare"]>;
  allSessionSummaries: ReturnType<DatabaseT["prepare"]>;
}

export class MetricsStore {
  private readonly db: DatabaseT;
  private readonly stmt: Statements;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("schema_version", SCHEMA_VERSION);

    this.stmt = {
      insertCompression: this.db.prepare(`
        INSERT INTO compression_events
          (ts, ts_iso, command, category, confidence, raw_bytes, compressed_bytes,
           saved_pct, omni_fallback, tee_file)
        VALUES (@ts, @ts_iso, @command, @category, @confidence, @raw_bytes,
                @compressed_bytes, @saved_pct, @omni_fallback, @tee_file)
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
          (ts, ts_iso, session_id, pid, turn, mechanism, tool,
           tokens_without, tokens_with, tokens_saved, detail)
        VALUES (@ts, @ts_iso, @session_id, @pid, @turn, @mechanism, @tool,
                @tokens_without, @tokens_with, @tokens_saved, @detail)
      `),
      upsertSessionHistory: this.db.prepare(`
        INSERT INTO session_history
          (session_id, started_at, ended_at, duration_ms, tool_calls, tokens_saved,
           tokens_processed, efficiency, dollars_saved, model_id, entity_count,
           agent_name, token_flow_summary)
        VALUES (@session_id, @started_at, @ended_at, @duration_ms, @tool_calls,
                @tokens_saved, @tokens_processed, @efficiency, @dollars_saved,
                @model_id, @entity_count, @agent_name, @token_flow_summary)
        ON CONFLICT(session_id) DO UPDATE SET
          ended_at = excluded.ended_at,
          duration_ms = excluded.duration_ms,
          tool_calls = excluded.tool_calls,
          tokens_saved = excluded.tokens_saved,
          tokens_processed = excluded.tokens_processed,
          efficiency = excluded.efficiency,
          dollars_saved = excluded.dollars_saved,
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
      allSessionHistory: this.db.prepare(`
        SELECT * FROM session_history ORDER BY ended_at ASC
      `),
      sessionSummaryById: this.db.prepare(`
        SELECT * FROM session_summaries WHERE session_id = @sessionId
      `),
      allSessionSummaries: this.db.prepare(`
        SELECT * FROM session_summaries ORDER BY ended_at DESC
      `),
    };
  }

  // ── Writes ──────────────────────────────────────────────────────────

  insertCompression(row: CompressionEventInsert): number {
    return Number(this.stmt.insertCompression.run(row).lastInsertRowid);
  }

  insertFileRead(row: FileReadEventInsert): number {
    return Number(this.stmt.insertFileRead.run(row).lastInsertRowid);
  }

  insertTokenFlow(row: TokenFlowEventInsert): number {
    return Number(this.stmt.insertTokenFlow.run(row).lastInsertRowid);
  }

  upsertSessionHistory(row: SessionHistoryInsert): void {
    this.stmt.upsertSessionHistory.run(row);
  }

  upsertSessionSummary(row: SessionSummaryInsert): void {
    this.stmt.upsertSessionSummary.run(row);
  }

  // ── Reads ───────────────────────────────────────────────────────────

  recentCompression(limit: number): CompressionEventRow[] {
    return this.stmt.recentCompression.all({ limit }) as CompressionEventRow[];
  }

  recentFileReads(limit: number): FileReadEventRow[] {
    return this.stmt.recentFileReads.all({ limit }) as FileReadEventRow[];
  }

  /** Poll API used by the log-tailer. */
  compressionSince(lastId: number, limit = 500): CompressionEventRow[] {
    return this.stmt.compressionSince.all({
      lastId,
      limit,
    }) as CompressionEventRow[];
  }

  fileReadsSince(lastId: number, limit = 500): FileReadEventRow[] {
    return this.stmt.fileReadsSince.all({
      lastId,
      limit,
    }) as FileReadEventRow[];
  }

  tokenFlowSince(lastId: number, limit = 500): TokenFlowEventRow[] {
    return this.stmt.tokenFlowSince.all({
      lastId,
      limit,
    }) as TokenFlowEventRow[];
  }

  allTokenFlow(): TokenFlowEventRow[] {
    return this.stmt.tokenFlowAll.all({}) as TokenFlowEventRow[];
  }

  tokenFlowBySession(sessionId: string): TokenFlowEventRow[] {
    return this.stmt.tokenFlowBySession.all({
      sessionId,
    }) as TokenFlowEventRow[];
  }

  allSessionHistory(): SessionHistoryRow[] {
    return this.stmt.allSessionHistory.all({}) as SessionHistoryRow[];
  }

  sessionSummary(sessionId: string): SessionSummaryRow | null {
    return (this.stmt.sessionSummaryById.get({ sessionId }) ??
      null) as SessionSummaryRow | null;
  }

  allSessionSummaries(): SessionSummaryRow[] {
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
  } {
    const c = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM compression_events")
      .get() as { id: number };
    const f = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM file_read_events")
      .get() as { id: number };
    const t = this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM token_flow_events")
      .get() as { id: number };
    return { compression: c.id, fileRead: f.id, tokenFlow: t.id };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  /** Test-only — wipe every metric table. */
  reset(): void {
    this.db.exec(`
      DELETE FROM compression_events;
      DELETE FROM file_read_events;
      DELETE FROM token_flow_events;
      DELETE FROM session_history;
      DELETE FROM session_summaries;
      DELETE FROM sqlite_sequence WHERE name IN
        ('compression_events','file_read_events','token_flow_events','session_history');
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
