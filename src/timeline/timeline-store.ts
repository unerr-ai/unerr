/**
 * Timeline Store — third CozoDB instance at `.unerr/timeline.db`.
 *
 * Parallel to graph.db (Layer 2) and facts.db (Layer 9). Holds:
 *   - turns                 : agent-turn rollups (one per closed turn)
 *   - intents               : cross-session task groupings (ST-4)
 *   - intent_sessions       : intent↔session many-to-many (ST-4)
 *   - markers               : agent-emitted mark_* rows (ST-2)
 *   - derived_signals       : mined patterns (hot files, loops, co-changes) (ST-3+)
 *   - signal_reinforcement  : append-only reinforcement events per signal (ST-5)
 *   - traces                : blocker→resolution trajectories (Cap A-1)
 *   - trace_tokens          : inverted index on situation tokens (Cap A-1)
 *
 * Schema rules (per CLAUDE.md):
 *   - Named Datalog syntax for any relation with 4+ columns.
 *   - All db.run() calls are async — always await.
 *   - Edit in place, no migrations until first public release.
 *
 * Isolation contract: this module NEVER reads or writes graph.db or facts.db.
 * It only opens/owns `.unerr/timeline.db`. Existing Layer 2 / Layer 9 code is
 * untouched.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CozoDb } from "../intelligence/cozo-schema.js";

const TIMELINE_DB_FILENAME = "timeline.db";

export interface TimelineDbResult {
  db: CozoDb;
  isNew: boolean;
  dbPath: string;
}

/**
 * Open or create timeline.db at `{projectRoot}/.unerr/timeline.db`. Mirrors the
 * factory pattern in `openFactsDb()` so the dynamic-import dance stays uniform.
 */
export async function openTimelineDb(
  projectRoot: string
): Promise<TimelineDbResult> {
  const unerrDir = join(projectRoot, ".unerr");
  mkdirSync(unerrDir, { recursive: true });

  const dbPath = join(unerrDir, TIMELINE_DB_FILENAME);
  const isNew = !existsSync(dbPath);

  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;

  const db = new (
    CozoDbConstructor as new (
      engine: string,
      path: string
    ) => CozoDb
  )("sqlite", dbPath);

  return { db, isNew, dbPath };
}

async function getExistingRelations(db: CozoDb): Promise<Set<string>> {
  const result = await db.run("::relations");
  return new Set(result.rows.map((row) => row[0] as string));
}

/**
 * Initialise timeline.db schema. Creates only missing relations — safe to call
 * on fresh and existing databases. Schema is intentionally minimal here; the
 * later sprints (ST-3/4/5) add CRUD methods on top.
 */
export async function initTimelineSchema(db: CozoDb): Promise<void> {
  const existing = await getExistingRelations(db);

  if (!existing.has("turns")) {
    await db.run(`
      :create turns {
        turn_id: String
        =>
        session_id: String,
        started_at: Float,
        ended_at: Float,
        opened_by: String,
        closed_reason: String,
        tool_count: Int,
        file_count: Int,
        edit_count: Int,
        title: String,
        outcome: String
      }
    `);
  }

  if (!existing.has("intents")) {
    await db.run(`
      :create intents {
        intent_id: String
        =>
        title: String,
        started_at: Float,
        last_active_at: Float,
        file_set: String,
        file_set_hash: String,
        status: String,
        confidence: Float,
        source: String
      }
    `);
  }

  if (!existing.has("intent_sessions")) {
    await db.run(`
      :create intent_sessions {
        intent_id: String,
        session_id: String
      }
    `);
  }

  if (!existing.has("markers")) {
    await db.run(`
      :create markers {
        marker_id: String
        =>
        type: String,
        text: String,
        session_id: String,
        turn_id: String,
        ts: Float,
        blocker_ref: String,
        file_path: String
      }
    `);
  }

  if (!existing.has("derived_signals")) {
    await db.run(`
      :create derived_signals {
        signal_id: String
        =>
        type: String,
        scope: String,
        content: String,
        confidence: Float,
        first_seen_at: Float,
        last_seen_at: Float
      }
    `);
  }

  if (!existing.has("signal_reinforcement")) {
    await db.run(`
      :create signal_reinforcement {
        signal_id: String,
        ts: Float
        =>
        delta: Float,
        source: String
      }
    `);
  }

  if (!existing.has("session_files")) {
    // (session_id, file_path) — records distinct file touches per session for
    // intent stitching (ST-4). Populated by the bootstrap when a turn closes.
    await db.run(`
      :create session_files {
        session_id: String,
        file_path: String
      }
    `);
  }

  if (!existing.has("session_agents")) {
    // UX-1: which agent (Claude Code, Cursor, Codex, …) drove this session.
    // Best-effort — populated when the MCP `initialize` handshake provided a
    // clientInfo.name. Sessions without an identified client get "unknown".
    await db.run(`
      :create session_agents {
        session_id: String
        =>
        agent_name: String,
        first_seen: Float,
        last_seen: Float
      }
    `);
  }

  // Cap A-1: trajectory/incident traces synthesized from blocker→resolution pairs.
  if (!existing.has("traces")) {
    await db.run(`
      :create traces {
        trace_id: String
        =>
        situation: String,
        dead_ends: String,
        unlock: String,
        anchor: String,
        session_id: String,
        resolved_at: Float
      }
    `);
  }

  // Cap A-1: inverted index mapping situation tokens → trace_id for recall.
  if (!existing.has("trace_tokens")) {
    await db.run(`
      :create trace_tokens {
        token: String,
        trace_id: String
      }
    `);
  }
}

// ── Row types ────────────────────────────────────────────────────────────────

export interface TurnRow {
  turn_id: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  opened_by: string;
  closed_reason: string;
  tool_count: number;
  file_count: number;
  edit_count: number;
  title: string;
  outcome: string;
}

export interface MarkerRow {
  marker_id: string;
  type: string;
  text: string;
  session_id: string;
  turn_id: string;
  ts: number;
  blocker_ref: string;
  file_path: string;
}

export interface IntentRow {
  intent_id: string;
  title: string;
  started_at: number;
  last_active_at: number;
  file_set: string;
  file_set_hash: string;
  status: string;
  confidence: number;
  source: string;
}

export interface IntentSessionRow {
  intent_id: string;
  session_id: string;
}

export interface SignalRow {
  signal_id: string;
  type: string;
  scope: string;
  content: string;
  confidence: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface SignalReinforcementRow {
  signal_id: string;
  ts: number;
  delta: number;
  source: string;
}

/**
 * One trajectory trace synthesized when an agent resolves a blocker. Captures
 * the blocking situation, what paths were tried (dead_ends), and the fix
 * (unlock) anchored to the code location so symptom-match retrieval can surface
 * it on a future similar task.
 * @sem domain=intelligence
 */
export interface TraceRow {
  trace_id: string;
  /** Blocker marker text — the symptom description. */
  situation: string;
  /** JSON-encoded string[] of file paths / entity keys tried between blocker and resolution. */
  dead_ends: string;
  /** Resolution text — what broke the blocker. */
  unlock: string;
  /** Entity key or file path where the fix landed (graph retrieval key). */
  anchor: string;
  session_id: string;
  /** ms epoch when the resolution was recorded. */
  resolved_at: number;
}

// ── Store facade ─────────────────────────────────────────────────────────────

/**
 * Thin async wrapper around the timeline CozoDB instance. ST-1b only ships a
 * minimal CRUD surface (turns + markers + listings). ST-3/4/5 extend this with
 * intent, signal, and reinforcement methods.
 */
export class CozoTimelineStore {
  private constructor(
    private readonly db: CozoDb,
    public readonly dbPath: string,
    public readonly isNew: boolean
  ) {}

  /**
   * Factory — opens the db and runs schema init. Use this instead of `new`.
   */
  static async create(projectRoot: string): Promise<CozoTimelineStore> {
    const { db, dbPath, isNew } = await openTimelineDb(projectRoot);
    await initTimelineSchema(db);
    return new CozoTimelineStore(db, dbPath, isNew);
  }

  /** Underlying handle for tests and advanced consumers. */
  getDb(): CozoDb {
    return this.db;
  }

  /**
   * Upsert a turn rollup. Called when the segmenter emits a turn-close event.
   */
  async upsertTurn(turn: TurnRow): Promise<void> {
    await this.db.run(
      `
      ?[turn_id, session_id, started_at, ended_at, opened_by, closed_reason, tool_count, file_count, edit_count, title, outcome] <-
        [[$turn_id, $session_id, $started_at, $ended_at, $opened_by, $closed_reason, $tool_count, $file_count, $edit_count, $title, $outcome]]
      :put turns {
        turn_id
        =>
        session_id, started_at, ended_at, opened_by, closed_reason,
        tool_count, file_count, edit_count, title, outcome
      }
    `,
      turn as unknown as Record<string, unknown>
    );
  }

  /**
   * List turns with filters. Newest-first by `started_at`. Supports pagination
   * (offset + limit) and substring search on `title`.
   */
  async listTurns(
    opts: {
      sessionId?: string;
      fromTs?: number;
      toTs?: number;
      query?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<TurnRow[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const { whereClause, params } = buildTurnFilter(opts);
    const query = `
      ?[turn_id, session_id, started_at, ended_at, opened_by, closed_reason, tool_count, file_count, edit_count, title, outcome] :=
        *turns{
          turn_id, session_id, started_at, ended_at, opened_by, closed_reason,
          tool_count, file_count, edit_count, title, outcome
        }${whereClause}
      :order -started_at
      :offset ${offset}
      :limit ${limit}
    `;
    const result = await this.db.run(query, params);
    return result.rows.map(rowToTurn);
  }

  /**
   * Total number of turns matching the same filter as `listTurns`. Used for
   * pagination footers ("page X of Y").
   */
  async countTurns(
    opts: {
      sessionId?: string;
      fromTs?: number;
      toTs?: number;
      query?: string;
    } = {}
  ): Promise<number> {
    const { whereClause, params } = buildTurnFilter(opts);
    const result = await this.db.run(
      `?[count(turn_id)] := *turns{turn_id, session_id, started_at, ended_at, opened_by, closed_reason, tool_count, file_count, edit_count, title, outcome}${whereClause}`,
      params
    );
    const row = result.rows[0];
    return row ? Number(row[0] as number) : 0;
  }

  /**
   * List distinct sessions touched by `turns`, with aggregate stats and the
   * agent that drove the session (when known). Powers the session + agent
   * filters in the Timeline page.
   */
  async listSessions(
    opts: { fromTs?: number; toTs?: number; limit?: number } = {}
  ): Promise<
    Array<{
      session_id: string;
      first_seen: number;
      last_seen: number;
      turn_count: number;
      edit_count: number;
      file_count: number;
      agent_name: string;
    }>
  > {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const filters: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof opts.fromTs === "number") {
      filters.push("started_at >= $from_ts");
      params.from_ts = opts.fromTs;
    }
    if (typeof opts.toTs === "number") {
      filters.push("started_at <= $to_ts");
      params.to_ts = opts.toTs;
    }
    const whereClause = filters.length > 0 ? `, ${filters.join(", ")}` : "";
    const result = await this.db.run(
      `?[session_id, min(started_at), max(ended_at), count(turn_id), sum(edit_count), sum(file_count)] :=
        *turns{turn_id, session_id, started_at, ended_at, edit_count, file_count}${whereClause}
       :order -max(ended_at)
       :limit ${limit}`,
      params
    );
    const rows = result.rows.map((r) => ({
      session_id: r[0] as string,
      first_seen: r[1] as number,
      last_seen: r[2] as number,
      turn_count: r[3] as number,
      edit_count: r[4] as number,
      file_count: r[5] as number,
      agent_name: "unknown",
    }));

    // Left-join the agent name lookup in a second pass — Cozo's join syntax
    // doesn't compose cleanly with `:order` over aggregates here.
    const agentMap = await this.getSessionAgents(rows.map((r) => r.session_id));
    for (const r of rows) {
      const a = agentMap.get(r.session_id);
      if (a) r.agent_name = a;
    }
    return rows;
  }

  /**
   * Record (or refresh) the agent name for a session. Called from the bootstrap
   * on each turn close — first_seen is preserved across calls, last_seen
   * advances. Best-effort; no-op when agent_name is empty.
   */
  async setSessionAgent(
    sessionId: string,
    agentName: string,
    nowMs = Date.now()
  ): Promise<void> {
    if (!agentName || agentName.length === 0) return;
    const existing = await this.db.run(
      "?[first_seen] := *session_agents{session_id, first_seen}, session_id = $sid",
      { sid: sessionId }
    );
    const firstSeen =
      existing.rows.length > 0 ? (existing.rows[0]?.[0] as number) : nowMs;
    await this.db.run(
      `?[session_id, agent_name, first_seen, last_seen] <-
        [[$sid, $name, $first, $last]]
       :put session_agents {
         session_id => agent_name, first_seen, last_seen
       }`,
      {
        sid: sessionId,
        name: agentName,
        first: firstSeen,
        last: nowMs,
      }
    );
  }

  /** Lookup the agent name for one session id. Returns null when unknown. */
  async getSessionAgent(sessionId: string): Promise<string | null> {
    const result = await this.db.run(
      "?[agent_name] := *session_agents{session_id, agent_name}, session_id = $sid",
      { sid: sessionId }
    );
    const row = result.rows[0];
    return row ? (row[0] as string) : null;
  }

  /** Batched agent lookup — used by listSessions to avoid N+1 queries. */
  async getSessionAgents(sessionIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (sessionIds.length === 0) return map;
    // Cozo doesn't take an `IN` list directly; pull all and filter client-side.
    const all = await this.db.run(
      "?[session_id, agent_name] := *session_agents{session_id, agent_name}"
    );
    const wanted = new Set(sessionIds);
    for (const r of all.rows) {
      const sid = r[0] as string;
      if (wanted.has(sid)) map.set(sid, r[1] as string);
    }
    return map;
  }

  /**
   * Distinct agent names with session counts. Powers the agent filter
   * dropdown and the "agents over time" KPI.
   */
  async listAgents(): Promise<
    Array<{ agent_name: string; session_count: number; last_seen: number }>
  > {
    const result = await this.db.run(
      `?[agent_name, count(session_id), max(last_seen)] :=
        *session_agents{session_id, agent_name, last_seen}
       :order -max(last_seen)`
    );
    return result.rows.map((r) => ({
      agent_name: r[0] as string,
      session_count: r[1] as number,
      last_seen: r[2] as number,
    }));
  }

  /**
   * Bucketed activity counts for the heatmap. Returns one row per day in the
   * `[fromTs, toTs]` range (inclusive), with zeros for empty days.
   */
  async getActivityBuckets(opts: {
    fromTs: number;
    toTs: number;
    bucketMs?: number;
  }): Promise<
    Array<{
      ts: number;
      turns: number;
      edits: number;
      tools: number;
    }>
  > {
    const bucket = opts.bucketMs ?? 24 * 60 * 60_000;
    const turns = await this.listTurns({
      fromTs: opts.fromTs,
      toTs: opts.toTs,
      limit: 5000,
    });
    const map = new Map<
      number,
      { ts: number; turns: number; edits: number; tools: number }
    >();
    // Pre-fill the range so empty days still render.
    for (
      let t = bucketStart(opts.fromTs, bucket);
      t <= opts.toTs;
      t += bucket
    ) {
      map.set(t, { ts: t, turns: 0, edits: 0, tools: 0 });
    }
    for (const turn of turns) {
      const b = bucketStart(turn.started_at, bucket);
      const cur = map.get(b) ?? { ts: b, turns: 0, edits: 0, tools: 0 };
      cur.turns += 1;
      cur.edits += turn.edit_count;
      cur.tools += turn.tool_count;
      map.set(b, cur);
    }
    return [...map.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Insert a marker row. Used by ST-2 marker tool handlers. */
  async insertMarker(marker: MarkerRow): Promise<void> {
    await this.db.run(
      `
      ?[marker_id, type, text, session_id, turn_id, ts, blocker_ref, file_path] <-
        [[$marker_id, $type, $text, $session_id, $turn_id, $ts, $blocker_ref, $file_path]]
      :put markers {
        marker_id
        =>
        type, text, session_id, turn_id, ts, blocker_ref, file_path
      }
    `,
      marker as unknown as Record<string, unknown>
    );
  }

  /**
   * List markers, newest first. ST-3 open-threads uses this to find blockers
   * without resolutions.
   */
  async listMarkers(
    opts: { sessionId?: string; type?: string; limit?: number } = {}
  ): Promise<MarkerRow[]> {
    const limit = opts.limit ?? 100;
    const filters: string[] = [];
    if (opts.sessionId) filters.push("session_id = $session_id");
    if (opts.type) filters.push("type = $type");
    const filterClause = filters.length > 0 ? `, ${filters.join(", ")}` : "";
    const query = `
      ?[marker_id, type, text, session_id, turn_id, ts, blocker_ref, file_path] :=
        *markers{
          marker_id, type, text, session_id, turn_id, ts, blocker_ref, file_path
        }${filterClause}
      :order -ts
      :limit ${Math.max(1, Math.min(limit, 500))}
    `;
    const params: Record<string, unknown> = {};
    if (opts.sessionId) params.session_id = opts.sessionId;
    if (opts.type) params.type = opts.type;
    const result = await this.db.run(query, params);
    return result.rows.map(rowToMarker);
  }

  /** Look up a single marker by id. Returns null when not found. */
  async getMarkerById(markerId: string): Promise<MarkerRow | null> {
    const result = await this.db.run(
      `?[marker_id, type, text, session_id, turn_id, ts, blocker_ref, file_path] :=
        *markers{
          marker_id, type, text, session_id, turn_id, ts, blocker_ref, file_path
        },
        marker_id = $marker_id`,
      { marker_id: markerId }
    );
    const row = result.rows[0];
    return row ? rowToMarker(row) : null;
  }

  /**
   * Insert a trajectory trace synthesized from a blocker→resolution pair.
   * @sem domain=intelligence
   */
  async insertTrace(trace: TraceRow): Promise<void> {
    await this.db.run(
      `?[trace_id, situation, dead_ends, unlock, anchor, session_id, resolved_at] <-
        [[$trace_id, $situation, $dead_ends, $unlock, $anchor, $session_id, $resolved_at]]
       :put traces {
         trace_id
         =>
         situation, dead_ends, unlock, anchor, session_id, resolved_at
       }`,
      trace as unknown as Record<string, unknown>
    );
  }

  /**
   * Insert situation tokens into the inverted trace_tokens index.
   * One row per token — idempotent via :put.
   * @sem domain=intelligence
   */
  async insertTraceTokens(traceId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    for (const token of tokens) {
      await this.db.run(
        `?[token, trace_id] <- [[$token, $trace_id]]
         :put trace_tokens { token, trace_id }`,
        { token, trace_id: traceId }
      );
    }
  }

  /**
   * Recall traces matching any of the supplied tokens from the inverted index.
   * Returns up to `limit` distinct traces, de-duplicated by trace_id. The next
   * sprint will add TF-IDF ranking on top of this set.
   * @sem domain=intelligence
   */
  async recallTracesByTokens(
    tokens: string[],
    limit = 10
  ): Promise<TraceRow[]> {
    if (tokens.length === 0) return [];
    const matchedIds = new Set<string>();
    for (const token of tokens) {
      const r = await this.db.run(
        "?[trace_id] := *trace_tokens[token, trace_id], token = $token",
        { token }
      );
      for (const row of r.rows) {
        matchedIds.add(row[0] as string);
      }
    }
    if (matchedIds.size === 0) return [];
    const traces: TraceRow[] = [];
    for (const traceId of [...matchedIds].slice(0, limit)) {
      const r = await this.db.run(
        `?[trace_id, situation, dead_ends, unlock, anchor, session_id, resolved_at] :=
          *traces{
            trace_id, situation, dead_ends, unlock, anchor, session_id, resolved_at
          },
          trace_id = $trace_id`,
        { trace_id: traceId }
      );
      const row = r.rows[0];
      if (row) traces.push(rowToTrace(row));
    }
    return traces;
  }

  /**
   * Return the total number of stored traces — used as the IDF denominator
   * when ranking candidates in recallTracesBySymptom.
   * @sem domain=intelligence
   */
  async countTraces(): Promise<number> {
    const result = await this.db.run("?[count(trace_id)] := *traces{trace_id}");
    const row = result.rows[0];
    return row ? Number(row[0] as number) : 0;
  }

  /**
   * Return all trace IDs that contain the supplied token in the inverted index.
   * Called once per query token during TF-IDF scoring in recallTracesBySymptom.
   * @sem domain=intelligence
   */
  async getTracesForToken(token: string): Promise<string[]> {
    const r = await this.db.run(
      "?[trace_id] := *trace_tokens[token, trace_id], token = $token",
      { token }
    );
    return r.rows.map((row) => row[0] as string);
  }

  /**
   * Fetch trace rows by their IDs. Returns a Map keyed by trace_id for O(1)
   * lookup during score annotation in recallTracesBySymptom.
   * @sem domain=intelligence
   */
  async getTracesByIds(ids: string[]): Promise<Map<string, TraceRow>> {
    const result = new Map<string, TraceRow>();
    for (const traceId of ids) {
      const r = await this.db.run(
        `?[trace_id, situation, dead_ends, unlock, anchor, session_id, resolved_at] :=
          *traces{trace_id, situation, dead_ends, unlock, anchor, session_id, resolved_at},
          trace_id = $trace_id`,
        { trace_id: traceId }
      );
      const row = r.rows[0];
      if (row) result.set(traceId, rowToTrace(row));
    }
    return result;
  }

  /**
   * Record distinct file touches for a session. Called by the bootstrap on
   * each turn-close so the intent stitcher (ST-4) has a file set to match on.
   */
  async recordSessionFiles(
    sessionId: string,
    files: Iterable<string>
  ): Promise<void> {
    const list = [...new Set([...files].filter((f) => f.length > 0))];
    if (list.length === 0) return;
    // CozoDB :put against a many-row relation works one row at a time.
    for (const fp of list) {
      await this.db.run(
        `?[session_id, file_path] <- [[$session_id, $file_path]]
         :put session_files { session_id, file_path }`,
        { session_id: sessionId, file_path: fp }
      );
    }
  }

  async getSessionFiles(sessionId: string): Promise<string[]> {
    const result = await this.db.run(
      "?[file_path] := *session_files{session_id: $session_id, file_path}",
      { session_id: sessionId }
    );
    return result.rows.map((r) => r[0] as string);
  }

  async upsertIntent(intent: IntentRow): Promise<void> {
    await this.db.run(
      `?[intent_id, title, started_at, last_active_at, file_set, file_set_hash, status, confidence, source] <-
        [[$intent_id, $title, $started_at, $last_active_at, $file_set, $file_set_hash, $status, $confidence, $source]]
       :put intents {
         intent_id
         => title, started_at, last_active_at, file_set, file_set_hash, status, confidence, source
       }`,
      intent as unknown as Record<string, unknown>
    );
  }

  async listIntents(
    opts: { status?: string; limit?: number } = {}
  ): Promise<IntentRow[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const filter = opts.status ? ", status = $status" : "";
    const query = `?[intent_id, title, started_at, last_active_at, file_set, file_set_hash, status, confidence, source] :=
        *intents{intent_id, title, started_at, last_active_at, file_set, file_set_hash, status, confidence, source}${filter}
      :order -last_active_at
      :limit ${limit}`;
    const params: Record<string, unknown> = {};
    if (opts.status) params.status = opts.status;
    const result = await this.db.run(query, params);
    return result.rows.map((r) => ({
      intent_id: r[0] as string,
      title: r[1] as string,
      started_at: r[2] as number,
      last_active_at: r[3] as number,
      file_set: r[4] as string,
      file_set_hash: r[5] as string,
      status: r[6] as string,
      confidence: r[7] as number,
      source: r[8] as string,
    }));
  }

  async attachSession(intentId: string, sessionId: string): Promise<void> {
    await this.db.run(
      `?[intent_id, session_id] <- [[$intent_id, $session_id]]
       :put intent_sessions { intent_id, session_id }`,
      { intent_id: intentId, session_id: sessionId }
    );
  }

  async listIntentSessions(intentId: string): Promise<string[]> {
    const result = await this.db.run(
      "?[session_id] := *intent_sessions{intent_id: $intent_id, session_id}",
      { intent_id: intentId }
    );
    return result.rows.map((r) => r[0] as string);
  }

  /**
   * Reverse lookup: find the intent (if any) attached to a session.
   */
  async findIntentForSession(sessionId: string): Promise<string | null> {
    const result = await this.db.run(
      "?[intent_id] := *intent_sessions{intent_id, session_id: $session_id}",
      { session_id: sessionId }
    );
    const row = result.rows[0];
    return row ? (row[0] as string) : null;
  }

  // ── ST-5: Derived signals + reinforcement ─────────────────────────────

  async upsertSignal(signal: SignalRow): Promise<void> {
    await this.db.run(
      `?[signal_id, type, scope, content, confidence, first_seen_at, last_seen_at] <-
        [[$signal_id, $type, $scope, $content, $confidence, $first_seen_at, $last_seen_at]]
       :put derived_signals {
         signal_id => type, scope, content, confidence, first_seen_at, last_seen_at
       }`,
      signal as unknown as Record<string, unknown>
    );
  }

  async getSignal(signalId: string): Promise<SignalRow | null> {
    const result = await this.db.run(
      `?[signal_id, type, scope, content, confidence, first_seen_at, last_seen_at] :=
         *derived_signals{signal_id, type, scope, content, confidence, first_seen_at, last_seen_at},
         signal_id = $signal_id`,
      { signal_id: signalId }
    );
    const row = result.rows[0];
    if (!row) return null;
    return rowToSignal(row);
  }

  async listSignals(
    opts: { type?: string; minConfidence?: number; limit?: number } = {}
  ): Promise<SignalRow[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const filters: string[] = [];
    if (opts.type) filters.push("type = $type");
    if (typeof opts.minConfidence === "number")
      filters.push("confidence >= $min_confidence");
    const filterClause = filters.length > 0 ? `, ${filters.join(", ")}` : "";
    const query = `?[signal_id, type, scope, content, confidence, first_seen_at, last_seen_at] :=
        *derived_signals{signal_id, type, scope, content, confidence, first_seen_at, last_seen_at}${filterClause}
      :order -last_seen_at
      :limit ${limit}`;
    const params: Record<string, unknown> = {};
    if (opts.type) params.type = opts.type;
    if (typeof opts.minConfidence === "number")
      params.min_confidence = opts.minConfidence;
    const result = await this.db.run(query, params);
    return result.rows.map(rowToSignal);
  }

  async appendReinforcement(
    signalId: string,
    ts: number,
    delta: number,
    source: string
  ): Promise<void> {
    await this.db.run(
      `?[signal_id, ts, delta, source] <-
        [[$signal_id, $ts, $delta, $source]]
       :put signal_reinforcement { signal_id, ts => delta, source }`,
      {
        signal_id: signalId,
        ts,
        delta,
        source,
      }
    );
  }

  async getReinforcementHistory(
    signalId: string,
    limit = 10
  ): Promise<SignalReinforcementRow[]> {
    const result = await this.db.run(
      `?[signal_id, ts, delta, source] :=
        *signal_reinforcement{signal_id, ts, delta, source},
        signal_id = $signal_id
      :order -ts
      :limit ${Math.max(1, Math.min(limit, 100))}`,
      { signal_id: signalId }
    );
    return result.rows.map((r) => ({
      signal_id: r[0] as string,
      ts: r[1] as number,
      delta: r[2] as number,
      source: r[3] as string,
    }));
  }

  /**
   * Delete signals last seen before `cutoffMs`. Returns the number removed.
   * Cascades: matching reinforcement history rows are also removed.
   */
  async deleteSignalsBefore(cutoffMs: number): Promise<number> {
    const stale = await this.db.run(
      `?[signal_id] := *derived_signals{signal_id, last_seen_at},
        last_seen_at < $cutoff`,
      { cutoff: cutoffMs }
    );
    const ids = stale.rows.map((r) => r[0] as string);
    for (const id of ids) {
      await this.db.run(
        `?[signal_id] := *derived_signals{signal_id}, signal_id = $signal_id
         :rm derived_signals { signal_id }`,
        { signal_id: id }
      );
      await this.db.run(
        `?[signal_id, ts] := *signal_reinforcement{signal_id, ts}, signal_id = $signal_id
         :rm signal_reinforcement { signal_id, ts }`,
        { signal_id: id }
      );
    }
    return ids.length;
  }

  /** Cleanly close the underlying CozoDB handle. */
  close(): void {
    this.db.close?.();
  }
}

function rowToSignal(row: unknown[]): SignalRow {
  return {
    signal_id: row[0] as string,
    type: row[1] as string,
    scope: row[2] as string,
    content: row[3] as string,
    confidence: row[4] as number,
    first_seen_at: row[5] as number,
    last_seen_at: row[6] as number,
  };
}

function rowToTurn(row: unknown[]): TurnRow {
  return {
    turn_id: row[0] as string,
    session_id: row[1] as string,
    started_at: row[2] as number,
    ended_at: row[3] as number,
    opened_by: row[4] as string,
    closed_reason: row[5] as string,
    tool_count: row[6] as number,
    file_count: row[7] as number,
    edit_count: row[8] as number,
    title: row[9] as string,
    outcome: row[10] as string,
  };
}

function rowToMarker(row: unknown[]): MarkerRow {
  return {
    marker_id: row[0] as string,
    type: row[1] as string,
    text: row[2] as string,
    session_id: row[3] as string,
    turn_id: row[4] as string,
    ts: row[5] as number,
    blocker_ref: row[6] as string,
    file_path: row[7] as string,
  };
}

function rowToTrace(row: unknown[]): TraceRow {
  return {
    trace_id: row[0] as string,
    situation: row[1] as string,
    dead_ends: row[2] as string,
    unlock: row[3] as string,
    anchor: row[4] as string,
    session_id: row[5] as string,
    resolved_at: row[6] as number,
  };
}

/**
 * Build the Datalog WHERE-clause fragment + params for the turn-filter family
 * (listTurns, countTurns). Centralised so listTurns and countTurns share the
 * same semantics and can't drift.
 */
function buildTurnFilter(opts: {
  sessionId?: string;
  fromTs?: number;
  toTs?: number;
  query?: string;
}): { whereClause: string; params: Record<string, unknown> } {
  const filters: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.sessionId) {
    filters.push("session_id = $session_id");
    params.session_id = opts.sessionId;
  }
  if (typeof opts.fromTs === "number") {
    filters.push("started_at >= $from_ts");
    params.from_ts = opts.fromTs;
  }
  if (typeof opts.toTs === "number") {
    filters.push("started_at <= $to_ts");
    params.to_ts = opts.toTs;
  }
  if (opts.query && opts.query.trim().length > 0) {
    // Case-insensitive substring search via Cozo's `regex_matches`. The pattern
    // is regex-escaped so `?` / `.` / `(` / `[` etc. in the user input don't
    // accidentally turn into wildcards.
    filters.push("regex_matches(title, $q_re)");
    params.q_re = `(?i).*${escapeRegex(opts.query.trim())}.*`;
  }
  return {
    whereClause: filters.length > 0 ? `, ${filters.join(", ")}` : "",
    params,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Floor a timestamp to the start of its bucket (e.g. UTC midnight for 24h). */
function bucketStart(ts: number, bucketMs: number): number {
  if (!Number.isFinite(ts) || bucketMs <= 0) return ts;
  return Math.floor(ts / bucketMs) * bucketMs;
}
