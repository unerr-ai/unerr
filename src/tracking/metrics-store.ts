/**
 * Metrics Store — telemetry AND the transcript read-cache are now JSONL; SQLite
 * (`metrics.db`) is fully retired.
 *
 * Engine split (rev-4 full JSONL cutover, TELEMETRY_AND_EVENTS_ARCHITECTURE.md §4/§6):
 *   - The 5 analytics streams (compression / file_read / token_flow /
 *     behavior / repo_activity) and the 2 session streams (session_history /
 *     session_summaries) are written as contract-shaped events (one JSON line
 *     each) into `.unerr/events/proxy.jsonl` via the L2 store (event-store.ts).
 *     Reads scan + reduce those segments.
 *   - `agent_transcripts` is now a LOCAL-ONLY JSONL cache at
 *     `.unerr/cache/transcripts.jsonl`. This file is NOT under `.unerr/events/`,
 *     so the push-reporter never scans or drains it (HR-2: the cached rows hold
 *     full transcript text, which can include raw code that must never leave the
 *     machine). The legitimate cloud copy is the firewalled + truncated
 *     `transcript` IngestEvent emitted in transcript-materializer.ts.
 *   - No SQLite table backs anything any more; `metrics.db` is never created.
 *
 * The class name + every public method signature is unchanged so the ~25 read
 * call sites and the writers compile untouched (§6 "swap the engine behind it").
 *
 * Why JSONL: a zero-dependency append-only writer has no native binary, so
 * neither telemetry nor the transcript cache can silently blank on a native
 * driver failure (the failure mode §4a removes). A torn trailing line is
 * dropped on read; transcript rows dedup last-wins on read.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type EmitContext, stampEvent } from "../events/enqueue.js";
import {
  PROXY_SEGMENT,
  type StoredEvent,
  appendEvent,
  eventsDir,
  listSegments,
  nextSeq,
  segmentPath,
  segmentSize,
} from "../events/event-store.js";
import { UNERR_VERSION } from "../version.js";

// ── Row types — wire format used by writers/readers ───────────────────
//
// The legacy SQLite row shapes are kept verbatim so every read call site
// (log-tailer, token-flow routes, status, the cloud drainers) compiles and
// types unchanged after the engine swap. Fields the contract does NOT carry
// (command / tee_file / confidence / omni_fallback / file / entity / the S0–S8
// reversible-compression columns) are reshaped back as their type defaults
// (null, 0, or "compress") — there is no JSONL source for them any more.

export interface CompressionEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  session_id: string | null;
  native_session_id: string | null;
  turn: number | null;
  agent: string;
  tool_use_id: string | null;
  command: string;
  category: string;
  confidence: number;
  raw_bytes: number;
  compressed_bytes: number;
  saved_pct: number;
  omni_fallback: number; // 0 / 1
  tee_file: string | null;
  // ── dropped reversible-compression fields (no contract source) ──
  // Reshaped to their defaults on every read; the JSONL store does not carry
  // them (Option A — contract-only detail). Kept on the type so the readers
  // that still reference them compile and just see "no data".
  original_tokens: number | null;
  delivered_tokens: number | null;
  mechanism: string | null;
  fidelity_pass: number | null;
  event_kind: string; // always "compress" now
  cache_ref: string | null;
  rerequest_saved_tokens: number | null;
  cache_hit: number | null;
  prefix_stable: number | null;
  prefix_bytes: number | null;
  survivors_by_importance: number | null;
  dropped_low_importance: number | null;
  ranking_key: string | null;
  query_relevance_pruned: number | null;
  transcript_footprint_tokens: number | null;
  batch_size: number | null;
}

export interface FileReadEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  session_id: string | null;
  native_session_id: string | null;
  turn: number | null;
  agent: string;
  tool_use_id: string | null;
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
  native_session_id: string | null;
  pid: number;
  turn: number;
  agent: string;
  mechanism: string;
  tool: string | null;
  tokens_without: number;
  tokens_with: number;
  tokens_saved: number;
  tool_use_id: string | null;
  detail: string | null; // JSON-encoded
}

export interface SessionHistoryRow {
  id: number;
  session_id: string;
  native_session_id: string | null;
  session_name: string | null;
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
  native_session_id: string | null;
  pid: number;
  turn: number;
  agent: string;
  type: string;
  tool: string | null;
  entity_key: string | null;
  response_bytes: number | null;
  tool_use_id: string | null;
  detail: string | null; // JSON-encoded
}

export interface RepoActivityEventRow {
  id: number;
  ts: number;
  ts_iso: string;
  action: string;
  at: string;
  agent: string;
  session_id: string | null;
  profile: string | null; // JSON-encoded, or null when no profile was attached
}

export interface SessionSummaryRow {
  session_id: string;
  native_session_id: string | null;
  session_name: string | null;
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
//
// The Insert shapes are unchanged so every writer call site compiles. The §4
// reversible fields and the command/file/entity path fields are still accepted
// (optional) but are NOT written to the JSONL event — only the contract detail
// fields are mapped through.

type CompressionEventBase = Omit<
  CompressionEventRow,
  | "id"
  | "session_id"
  | "native_session_id"
  | "turn"
  | "agent"
  | "tool_use_id"
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
  | "batch_size"
>;
export type CompressionEventInsert = CompressionEventBase & {
  session_id?: string | null;
  native_session_id?: string | null;
  turn?: number | null;
  agent?: string;
  tool_use_id?: string | null;
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
  batch_size?: number | null;
};
export type FileReadEventInsert = Omit<
  FileReadEventRow,
  "id" | "session_id" | "native_session_id" | "turn" | "agent" | "tool_use_id"
> & {
  session_id?: string | null;
  native_session_id?: string | null;
  turn?: number | null;
  agent?: string;
  tool_use_id?: string | null;
};
export type TokenFlowEventInsert = Omit<
  TokenFlowEventRow,
  "id" | "agent" | "native_session_id" | "tool_use_id"
> & {
  agent?: string;
  native_session_id?: string | null;
  tool_use_id?: string | null;
};
export type SessionHistoryInsert = Omit<
  SessionHistoryRow,
  "id" | "native_session_id" | "session_name"
> & {
  native_session_id?: string | null;
  session_name?: string | null;
};
export type SessionSummaryInsert = Omit<
  SessionSummaryRow,
  "native_session_id" | "session_name"
> & {
  native_session_id?: string | null;
  session_name?: string | null;
};
export type BehaviorEventInsert = Omit<
  BehaviorEventRow,
  "id" | "agent" | "native_session_id" | "tool_use_id"
> & {
  agent?: string;
  native_session_id?: string | null;
  tool_use_id?: string | null;
};

/**
 * One repo-lifecycle row. `action` is the moment, `at` is when it happened, and
 * `profile` is the unerr-standpoint repo snapshot as JSON text (null on
 * removed/stopped).
 */
export interface RepoActivityEventInsert {
  ts: number;
  ts_iso: string;
  action: string;
  at: string;
  profile?: string | null;
  session_id?: string | null;
  native_session_id?: string | null;
  turn?: number | null;
  agent?: string | null;
  tool_use_id?: string | null;
}

// ── Agent-transcript cache (local-only JSONL) ─────────────────────────
//
// The transcript cache lives at `.unerr/cache/transcripts.jsonl` — deliberately
// NOT under `.unerr/events/`, so the event store (listSegments scans only
// `.unerr/events/*.jsonl`) and the push-reporter never read or drain it. The
// rows carry full transcript text (HR-2: can include raw code), which must stay
// on the machine. The SQLite `UNIQUE(session_id, turn, role)` upsert becomes an
// append-only log here; readers dedup last-wins on the same key (the latest line
// for a (session_id, turn, role) triple wins), so re-materializing a boundary
// turn stays idempotent exactly as the SQLite ON CONFLICT did.

/** One persisted transcript row — the exact shape the SQLite table stored
 *  (minus the SQLite-only autoincrement `id`, which readers re-derive). */
interface TranscriptCacheRow {
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
}

// ── JSONL scan helpers ────────────────────────────────────────────────

/** One stored event plus a stable monotonic id (its line-end byte offset in
 *  its segment). The id is used both as the reshaped row's `id` and as the
 *  poll cursor (the byte/line offset that replaces the old SQLite `MAX(id)`). */
interface ScannedEvent {
  event: StoredEvent;
  /** Byte offset of the end of this event's line within its segment. */
  endOffset: number;
}

/**
 * Read complete JSON lines of one segment, each tagged with the byte offset of
 * the end of its line — the stable monotonic id that replaces the SQLite rowid.
 * A partial trailing line (writer mid-append) is dropped; a corrupt line is
 * skipped but its offset still advances. Lines whose end offset is <= `after`
 * are excluded (the poll cursor).
 */
function scanSegment(filePath: string, after = 0): ScannedEvent[] {
  if (!existsSync(filePath)) return [];
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return [];
  }
  const out: ScannedEvent[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue; // not a newline
    const endOffset = i + 1; // include the newline in the consumed span
    if (endOffset > after) {
      const line = buf.subarray(lineStart, i).toString("utf8");
      if (line.length > 0) {
        try {
          out.push({ event: JSON.parse(line) as StoredEvent, endOffset });
        } catch {
          // torn/corrupt line — skip, offset still advances past it
        }
      }
    }
    lineStart = endOffset;
  }
  return out;
}

const detailOf = (e: StoredEvent): Record<string, unknown> =>
  (e as { detail?: Record<string, unknown> }).detail ?? {};
const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
/** A number passed through, or null when the key is absent/non-numeric. */
const numN = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const epochMs = (e: StoredEvent): number => {
  const t = Date.parse((e as { ts?: string }).ts ?? "");
  return Number.isFinite(t) ? t : 0;
};

// ── Store ─────────────────────────────────────────────────────────────

/** Size at which the append-only transcript cache is compacted to its last-wins
 *  rows. Each per-turn re-materialize re-appends the boundary turn's rows, so the
 *  file balloons with superseded duplicates; 8 MB bounds it well above one
 *  session's deduped rows while keeping the rewrite infrequent. */
const TRANSCRIPT_CACHE_COMPACT_BYTES = 8 * 1024 * 1024;

export class MetricsStore {
  /** Per-store emit context — the repo whose `.unerr/events/` receives writes. */
  private readonly ctx: EmitContext;
  private readonly repoRoot: string;
  /** Local-only transcript cache file (`.unerr/cache/transcripts.jsonl`). Never
   *  under `.unerr/events/`, so it is never drained to the cloud. */
  private readonly transcriptCachePath: string;

  // Aggregate cache: a long-lived proxy re-asks tokenFlowTotal() etc. often.
  // Key = combined segment-size signature; invalidated when any segment grows.
  private aggCacheSig = "";
  private readonly aggCache = new Map<string, number>();

  constructor(unerrDir: string) {
    this.repoRoot = dirname(unerrDir);
    this.ctx = {
      repoRoot: this.repoRoot,
      segment: PROXY_SEGMENT,
      source: `unerr-cli@${UNERR_VERSION}`,
    };
    this.transcriptCachePath = join(unerrDir, "cache", "transcripts.jsonl");
  }

  // ── Agent transcripts (local-only JSONL cache) ──────────────────────

  /** Scan the transcript cache and reduce to last-wins rows keyed on
   *  (session_id, turn, role). A later line for the same key supersedes the
   *  earlier one, mirroring the SQLite UNIQUE upsert. Optionally filtered to one
   *  session. Returns rows sorted by turn ASC, then role ASC. */
  private readTranscriptCache(sessionFilter?: string): TranscriptCacheRow[] {
    if (!existsSync(this.transcriptCachePath)) return [];
    let buf: Buffer;
    try {
      buf = readFileSync(this.transcriptCachePath);
    } catch {
      return [];
    }
    const byKey = new Map<string, TranscriptCacheRow>();
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue; // newline
      const line = buf.subarray(lineStart, i).toString("utf8");
      lineStart = i + 1;
      if (line.length === 0) continue;
      let row: TranscriptCacheRow;
      try {
        row = JSON.parse(line) as TranscriptCacheRow;
      } catch {
        continue; // torn/corrupt line — skip
      }
      if (sessionFilter && row.session_id !== sessionFilter) continue;
      // Last write wins: re-set the same key so the latest line supersedes.
      byKey.set(`${row.session_id} ${row.turn} ${row.role}`, row);
    }
    return [...byKey.values()].sort(
      (a, b) =>
        a.turn - b.turn || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)
    );
  }

  /** Append one transcript row as a JSON line to the local-only cache. The
   *  full (untruncated) row is stored; dedup is on read (last-wins), so a
   *  re-write of the same (session_id, turn, role) supersedes the earlier line.
   *  The file is NEVER under `.unerr/events/`, so it is never drained to cloud. */
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
    try {
      mkdirSync(dirname(this.transcriptCachePath), { recursive: true });
      appendFileSync(this.transcriptCachePath, `${JSON.stringify(row)}\n`);
      this.compactTranscriptCacheIfLarge();
    } catch {
      /* best effort — cache is non-essential */
    }
  }

  /** Bound append-only growth: each per-turn re-materialize re-appends the
   *  boundary turn's rows, so the file accumulates superseded duplicates (read
   *  dedups, but the bytes pile up). Past `TRANSCRIPT_CACHE_COMPACT_BYTES`,
   *  rewrite it to just the last-wins set via temp + rename so a crash never
   *  leaves a torn file. Best-effort and race-tolerant: if two processes compact
   *  at once the later rename wins and at most a few just-appended local rows are
   *  lost — the cloud copy is the durable record, this cache is only the
   *  logbook's local view. */
  private compactTranscriptCacheIfLarge(): void {
    if (
      segmentSize(this.transcriptCachePath) < TRANSCRIPT_CACHE_COMPACT_BYTES
    ) {
      return;
    }
    try {
      const rows = this.readTranscriptCache();
      const body = rows.map((r) => JSON.stringify(r)).join("\n");
      const tmp = `${this.transcriptCachePath}.tmp`;
      writeFileSync(tmp, body.length > 0 ? `${body}\n` : "", "utf8");
      renameSync(tmp, this.transcriptCachePath);
    } catch {
      /* best effort — leave the un-compacted file intact on failure */
    }
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
    return this.readTranscriptCache(session_id).map((r, i) => ({
      id: i + 1,
      ...r,
    }));
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
    return this.readTranscriptCache(session_id)
      .filter((r) => r.turn === turn)
      .map((r, i) => ({ id: i + 1, ...r }));
  }

  hasAgentTranscripts(session_id: string): boolean {
    return this.readTranscriptCache(session_id).length > 0;
  }

  // ── Writes (JSONL) ──────────────────────────────────────────────────
  //
  // Each write maps its Insert row → the contract `detail` + envelope identity
  // and appends one stamped event. The return value is an opaque monotonic id
  // (the seq counter) — callers only use it as a rowid stand-in.

  private append(input: {
    type: StoredEvent["type"];
    detail: Record<string, unknown>;
    session_id?: string | null;
    native_session_id?: string | null;
    turn?: number | null;
    tool_use_id?: string | null;
    agent?: string | null;
    ts_iso?: string;
  }): number {
    const ctx: EmitContext = {
      ...this.ctx,
      session_id: input.session_id ?? undefined,
      native_session_id: input.native_session_id ?? undefined,
      // Per-event agent override wins over the ambient context, so one writer
      // shared by multiple coding agents stamps each row with its true agent.
      agent: input.agent ?? this.ctx.agent,
    };
    const ev = stampEvent(ctx, {
      type: input.type,
      detail: input.detail,
      turn: typeof input.turn === "number" ? input.turn : undefined,
      tool_use_id: input.tool_use_id ?? undefined,
    });
    // Honor an explicit ts_iso the writer supplied (the event time), overriding
    // stampEvent's emit-time `ts`, so reads sort by when the work happened.
    if (input.ts_iso) (ev as { ts: string }).ts = input.ts_iso;
    appendEvent(this.repoRoot, PROXY_SEGMENT, ev);
    return nextSeq(this.repoRoot);
  }

  insertCompression(row: CompressionEventInsert): number {
    // Option A — sanitize-at-drain. The local JSONL keeps the full row (command,
    // tee_file, the reversibility figures) so the dashboard reads them back; the
    // drainer's sanitizeDetail strips the path-ish keys before any cloud push.
    // `detail` is a contract looseObject, so the extra local keys validate clean.
    const detail: Record<string, unknown> = {
      category: row.category,
      raw_bytes: row.raw_bytes,
      compressed_bytes: row.compressed_bytes,
      saved_pct: row.saved_pct,
      confidence: row.confidence,
      omni_fallback: row.omni_fallback,
    };
    if (row.command) detail.command = row.command;
    if (row.tee_file != null) detail.tee_file = row.tee_file;
    if (row.mechanism != null) detail.mechanism = row.mechanism;
    if (row.event_kind != null) detail.event_kind = row.event_kind;
    if (row.cache_ref != null) detail.cache_ref = row.cache_ref;
    if (row.ranking_key != null) detail.ranking_key = row.ranking_key;
    if (row.cache_hit != null) detail.cache_hit = row.cache_hit === 1;
    // Reversibility / prefix accounting — local-only numbers, stored only when
    // the writer supplied them so the JSONL line stays lean.
    for (const k of [
      "original_tokens",
      "delivered_tokens",
      "fidelity_pass",
      "rerequest_saved_tokens",
      "prefix_stable",
      "prefix_bytes",
      "survivors_by_importance",
      "dropped_low_importance",
      "query_relevance_pruned",
      "transcript_footprint_tokens",
      "batch_size",
    ] as const) {
      if (row[k] != null) detail[k] = row[k];
    }
    return this.append({
      type: "compression",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
      turn: row.turn,
      tool_use_id: row.tool_use_id,
      agent: row.agent,
      ts_iso: row.ts_iso,
    });
  }

  insertFileRead(row: FileReadEventInsert): number {
    // Option A — keep file / entity locally for the dashboard; the drainer's
    // sanitizeDetail strips these path-ish keys before any cloud push.
    const detail: Record<string, unknown> = {
      mode: row.mode,
      total_lines: row.total_lines,
      returned_lines: row.returned_lines,
      saved_pct: row.saved_pct,
    };
    if (row.file) detail.file = row.file;
    if (row.entity != null) detail.entity = row.entity;
    if (row.token_estimate != null) detail.token_estimate = row.token_estimate;
    return this.append({
      type: "file_read",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
      turn: row.turn,
      tool_use_id: row.tool_use_id,
      agent: row.agent,
      ts_iso: row.ts_iso,
    });
  }

  insertTokenFlow(row: TokenFlowEventInsert): number {
    // `pid` rides the detail (a number, HR-2-safe) so the log-tailer own-PID
    // filter survives the engine swap; `tokens_without/with` carry the legacy
    // figures the tailer + economy line still need back.
    const detail: Record<string, unknown> = {
      mechanism: row.mechanism,
      tokens_saved: row.tokens_saved,
      pid: row.pid,
      tokens_without: row.tokens_without,
      tokens_with: row.tokens_with,
    };
    if (row.tool != null) detail.tool = row.tool;
    if (row.detail != null) detail.flow_detail = row.detail;
    return this.append({
      type: "token_flow",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
      turn: row.turn,
      tool_use_id: row.tool_use_id,
      agent: row.agent,
      ts_iso: row.ts_iso,
    });
  }

  insertBehaviorEvent(row: BehaviorEventInsert): number {
    // `kind` carries the legacy `type`; `pid`/`entity_key` ride the detail so
    // the tailer filter + dashboard reads keep working.
    const detail: Record<string, unknown> = {
      kind: row.type,
      pid: row.pid,
    };
    if (row.tool != null) detail.tool = row.tool;
    if (row.response_bytes != null) detail.response_bytes = row.response_bytes;
    if (row.entity_key != null) detail.entity_key = row.entity_key;
    if (row.detail != null) detail.behavior_detail = row.detail;
    return this.append({
      type: "behavior",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
      turn: row.turn,
      tool_use_id: row.tool_use_id,
      agent: row.agent,
      ts_iso: row.ts_iso,
    });
  }

  /**
   * Spool one repo-lifecycle row as a `repo_activity` event. Returns an opaque
   * monotonic id.
   */
  insertRepoActivity(row: RepoActivityEventInsert): number {
    const detail: Record<string, unknown> = {
      action: row.action,
      at: row.at,
    };
    if (row.profile != null) {
      try {
        detail.profile = JSON.parse(row.profile);
      } catch {
        /* malformed profile JSON — omit it rather than ship a string */
      }
    }
    return this.append({
      type: "repo_activity",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
      turn: row.turn,
      tool_use_id: row.tool_use_id,
      agent: row.agent,
      ts_iso: row.ts_iso,
    });
  }

  /**
   * Append a `session_summary` event from a session_history rollup. Mutable by
   * `session_id` — the latest row wins on read (last-wins compaction over the
   * append-only segment).
   */
  upsertSessionHistory(row: SessionHistoryInsert): void {
    const detail: Record<string, unknown> = {
      duration_ms: row.duration_ms,
      tool_calls: row.tool_calls,
      tokens_saved: row.tokens_saved,
      tokens_processed: row.tokens_processed,
      efficiency: row.efficiency,
      model_id: row.model_id,
      // Local-only rollup fields the SessionHistory reader needs back. The
      // contract `session_summary` detail is a looseObject, so these ride along
      // and are reshaped on read; they are never path-ish.
      kind: "history",
      started_at: row.started_at,
      ended_at: row.ended_at,
      entity_count: row.entity_count,
      session_name: row.session_name ?? null,
      agent_name: row.agent_name ?? null,
      token_flow_summary: row.token_flow_summary ?? null,
    };
    this.append({
      type: "session_summary",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
    });
  }

  /**
   * Append a `session_summary` event from a full session summary. Mutable by
   * `session_id` (last-wins on read).
   */
  upsertSessionSummary(row: SessionSummaryInsert): void {
    const detail: Record<string, unknown> = {
      kind: "summary",
      written_at: row.written_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.duration_ms,
      tool_calls: row.tool_calls,
      chains: row.chains,
      files_modified: row.files_modified,
      entities_touched: row.entities_touched,
      tools_used: row.tools_used,
      feature_areas: row.feature_areas,
      facts_recorded: row.facts_recorded,
      facts_surfaced: row.facts_surfaced,
      revert_count: row.revert_count,
      rot_score: row.rot_score,
      token_estimate: row.token_estimate,
      branch: row.branch,
      session_name: row.session_name ?? null,
    };
    this.append({
      type: "session_summary",
      detail,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
    });
  }

  // ── JSONL scan + reshape ────────────────────────────────────────────

  /** Every event of a given type across all segments, ascending by line order
   *  then segment name. Each row carries a stable `id` (its line-end offset). */
  private scanType(type: string): Array<{ event: StoredEvent; id: number }> {
    const out: Array<{ event: StoredEvent; id: number }> = [];
    for (const seg of listSegments(this.repoRoot)) {
      for (const s of scanSegment(seg)) {
        if ((s.event as { type?: string }).type === type) {
          out.push({ event: s.event, id: s.endOffset });
        }
      }
    }
    return out;
  }

  /** Proxy-segment events of a type whose line-end offset is past `after` —
   *  the poll cursor used by the log-tailer (replaces `id > lastSeen`). */
  private scanProxyTypeSince(
    type: string,
    after: number
  ): Array<{ event: StoredEvent; id: number }> {
    const out: Array<{ event: StoredEvent; id: number }> = [];
    for (const s of scanSegment(
      segmentPath(this.repoRoot, PROXY_SEGMENT),
      after
    )) {
      if ((s.event as { type?: string }).type === type) {
        out.push({ event: s.event, id: s.endOffset });
      }
    }
    return out;
  }

  private toCompressionRow(e: StoredEvent, id: number): CompressionEventRow {
    const d = detailOf(e);
    return {
      id,
      ts: epochMs(e),
      ts_iso: (e as { ts?: string }).ts ?? "",
      session_id: (e as { session_id?: string }).session_id ?? null,
      native_session_id:
        (e as { native_session_id?: string }).native_session_id ?? null,
      turn:
        typeof (e as { turn?: number }).turn === "number"
          ? (e as { turn: number }).turn
          : null,
      agent: (e as { agent?: string }).agent ?? "unknown",
      tool_use_id: (e as { tool_use_id?: string }).tool_use_id ?? null,
      command: str(d.command) ?? "",
      category: str(d.category) ?? "unknown",
      confidence: num(d.confidence),
      raw_bytes: num(d.raw_bytes),
      compressed_bytes: num(d.compressed_bytes),
      saved_pct: num(d.saved_pct),
      omni_fallback: num(d.omni_fallback),
      tee_file: str(d.tee_file),
      original_tokens: numN(d.original_tokens),
      delivered_tokens: numN(d.delivered_tokens),
      mechanism: str(d.mechanism),
      fidelity_pass: numN(d.fidelity_pass),
      event_kind: str(d.event_kind) ?? "compress",
      cache_ref: str(d.cache_ref),
      rerequest_saved_tokens: numN(d.rerequest_saved_tokens),
      cache_hit:
        typeof d.cache_hit === "boolean" ? (d.cache_hit ? 1 : 0) : null,
      prefix_stable: numN(d.prefix_stable),
      prefix_bytes: numN(d.prefix_bytes),
      survivors_by_importance: numN(d.survivors_by_importance),
      dropped_low_importance: numN(d.dropped_low_importance),
      ranking_key: str(d.ranking_key),
      query_relevance_pruned: numN(d.query_relevance_pruned),
      transcript_footprint_tokens: numN(d.transcript_footprint_tokens),
      batch_size: numN(d.batch_size),
    };
  }

  private toFileReadRow(e: StoredEvent, id: number): FileReadEventRow {
    const d = detailOf(e);
    return {
      id,
      ts: epochMs(e),
      ts_iso: (e as { ts?: string }).ts ?? "",
      session_id: (e as { session_id?: string }).session_id ?? null,
      native_session_id:
        (e as { native_session_id?: string }).native_session_id ?? null,
      turn:
        typeof (e as { turn?: number }).turn === "number"
          ? (e as { turn: number }).turn
          : null,
      agent: (e as { agent?: string }).agent ?? "unknown",
      tool_use_id: (e as { tool_use_id?: string }).tool_use_id ?? null,
      file: str(d.file) ?? "",
      mode: str(d.mode) ?? "full",
      total_lines: num(d.total_lines),
      returned_lines: num(d.returned_lines),
      saved_pct: num(d.saved_pct),
      entity: str(d.entity),
      token_estimate:
        typeof d.token_estimate === "number" ? d.token_estimate : null,
    };
  }

  private toTokenFlowRow(e: StoredEvent, id: number): TokenFlowEventRow {
    const d = detailOf(e);
    return {
      id,
      ts: epochMs(e),
      ts_iso: (e as { ts?: string }).ts ?? "",
      session_id: (e as { session_id?: string }).session_id ?? "",
      native_session_id:
        (e as { native_session_id?: string }).native_session_id ?? null,
      pid: num(d.pid),
      turn: num((e as { turn?: number }).turn),
      agent: (e as { agent?: string }).agent ?? "unknown",
      mechanism: str(d.mechanism) ?? "unknown",
      tool: str(d.tool),
      tokens_without: num(d.tokens_without),
      tokens_with: num(d.tokens_with),
      tokens_saved: num(d.tokens_saved),
      tool_use_id: (e as { tool_use_id?: string }).tool_use_id ?? null,
      detail: str(d.flow_detail),
    };
  }

  private toBehaviorRow(e: StoredEvent, id: number): BehaviorEventRow {
    const d = detailOf(e);
    return {
      id,
      ts: epochMs(e),
      ts_iso: (e as { ts?: string }).ts ?? "",
      session_id: (e as { session_id?: string }).session_id ?? "",
      native_session_id:
        (e as { native_session_id?: string }).native_session_id ?? null,
      pid: num(d.pid),
      turn: num((e as { turn?: number }).turn),
      agent: (e as { agent?: string }).agent ?? "unknown",
      type: str(d.kind) ?? "",
      tool: str(d.tool),
      entity_key: str(d.entity_key),
      response_bytes:
        typeof d.response_bytes === "number" ? d.response_bytes : null,
      tool_use_id: (e as { tool_use_id?: string }).tool_use_id ?? null,
      detail: str(d.behavior_detail),
    };
  }

  /** Latest session_summary event per session_id of a given local `kind`
   *  ("history" or "summary"), in append order (last wins). */
  private latestSessionDetailByKind(
    kind: string
  ): Map<string, { event: StoredEvent; id: number }> {
    const byId = new Map<string, { event: StoredEvent; id: number }>();
    for (const { event, id } of this.scanType("session_summary")) {
      if (detailOf(event).kind !== kind) continue;
      const sid = (event as { session_id?: string }).session_id;
      if (!sid) continue;
      byId.set(sid, { event, id }); // last write wins
    }
    return byId;
  }

  private toSessionHistoryRow(e: StoredEvent, id: number): SessionHistoryRow {
    const d = detailOf(e);
    return {
      id,
      session_id: (e as { session_id?: string }).session_id ?? "",
      native_session_id:
        (e as { native_session_id?: string }).native_session_id ?? null,
      session_name: str(d.session_name),
      started_at: str(d.started_at) ?? "",
      ended_at: str(d.ended_at) ?? "",
      duration_ms: num(d.duration_ms),
      tool_calls: num(d.tool_calls),
      tokens_saved: num(d.tokens_saved),
      tokens_processed: num(d.tokens_processed),
      efficiency: num(d.efficiency),
      model_id: str(d.model_id) ?? "",
      entity_count: num(d.entity_count),
      agent_name: str(d.agent_name),
      token_flow_summary: str(d.token_flow_summary),
    };
  }

  private toSessionSummaryRow(e: StoredEvent): SessionSummaryRow {
    const d = detailOf(e);
    return {
      session_id: (e as { session_id?: string }).session_id ?? "",
      native_session_id:
        (e as { native_session_id?: string }).native_session_id ?? null,
      session_name: str(d.session_name),
      written_at: str(d.written_at) ?? "",
      started_at: str(d.started_at) ?? "",
      ended_at: str(d.ended_at) ?? "",
      duration_ms: num(d.duration_ms),
      tool_calls: num(d.tool_calls),
      chains: num(d.chains),
      files_modified: str(d.files_modified) ?? "[]",
      entities_touched: str(d.entities_touched) ?? "[]",
      tools_used: str(d.tools_used) ?? "{}",
      feature_areas: str(d.feature_areas) ?? "[]",
      facts_recorded: num(d.facts_recorded),
      facts_surfaced: str(d.facts_surfaced) ?? "[]",
      revert_count: num(d.revert_count),
      rot_score: num(d.rot_score),
      token_estimate: num(d.token_estimate),
      branch: str(d.branch) ?? "",
    };
  }

  // ── Reads (JSONL) ───────────────────────────────────────────────────

  recentCompression(limit: number): CompressionEventRow[] {
    const rows = this.scanType("compression").map(({ event, id }) =>
      this.toCompressionRow(event, id)
    );
    // Newest first (was ORDER BY id DESC) — append order is chronological.
    rows.reverse();
    return rows.slice(0, limit);
  }

  recentFileReads(limit: number): FileReadEventRow[] {
    const rows = this.scanType("file_read").map(({ event, id }) =>
      this.toFileReadRow(event, id)
    );
    rows.reverse();
    return rows.slice(0, limit);
  }

  /**
   * Repo-lifecycle rows (started / agent_attached / removed …), newest first. The
   * `profile` is re-encoded to a JSON string (it rides the JSONL detail as a
   * parsed object) so a reader gets the same flat shape the old SQLite row had.
   */
  recentRepoActivity(limit: number): RepoActivityEventRow[] {
    const rows = this.scanType("repo_activity").map(({ event, id }) =>
      this.toRepoActivityRow(event, id)
    );
    rows.reverse();
    return rows.slice(0, limit);
  }

  private toRepoActivityRow(
    event: StoredEvent,
    id: number
  ): RepoActivityEventRow {
    const d = detailOf(event);
    const e = event as {
      ts?: string;
      agent?: string;
      session_id?: string | null;
    };
    return {
      id,
      ts: epochMs(event),
      ts_iso: e.ts ?? "",
      action: str(d.action) ?? "",
      at: str(d.at) ?? "",
      agent: e.agent ?? "unknown",
      session_id: e.session_id ?? null,
      profile: d.profile != null ? JSON.stringify(d.profile) : null,
    };
  }

  /** Poll API used by the log-tailer — `lastId` is a byte/line offset. */
  compressionSince(lastId: number, limit = 500): CompressionEventRow[] {
    return this.scanProxyTypeSince("compression", lastId)
      .slice(0, limit)
      .map(({ event, id }) => this.toCompressionRow(event, id));
  }

  /**
   * Reversible reuse savings (`rerequest_saved_tokens`) on compression rows at or
   * after `sinceTs` (epoch ms), summed for the per-turn economy line. Fidelity-
   * failed rows (`fidelity_pass === 0`) are excluded; passing (1) and unprobed-
   * lossless (absent) rows count.
   */
  reversibleSavedSince(sinceTs: number): number {
    let total = 0;
    for (const { event } of this.scanType("compression")) {
      if (epochMs(event) < sinceTs) continue;
      const d = detailOf(event);
      if (d.fidelity_pass === 0) continue;
      total += num(d.rerequest_saved_tokens);
    }
    return total;
  }

  /**
   * Lifetime reversible reuse savings across every compression row in this repo's
   * store, fidelity-honest (excludes `fidelity_pass === 0`).
   */
  reversibleSavedTotal(): number {
    return this.cachedAgg("reversibleSavedTotal", () => {
      let total = 0;
      for (const { event } of this.scanType("compression")) {
        const d = detailOf(event);
        if (d.fidelity_pass === 0) continue;
        total += num(d.rerequest_saved_tokens);
      }
      return total;
    });
  }

  /** Cached aggregate: re-uses a memo while no segment has grown. */
  private cachedAgg(key: string, compute: () => number): number {
    const sig = listSegments(this.repoRoot)
      .map((s) => `${s}:${segmentSize(s)}`)
      .join("|");
    if (sig !== this.aggCacheSig) {
      this.aggCacheSig = sig;
      this.aggCache.clear();
    }
    const cached = this.aggCache.get(key);
    if (cached !== undefined) return cached;
    const v = compute();
    this.aggCache.set(key, v);
    return v;
  }

  /**
   * Lifetime tokens saved across every token_flow event in this repo's store.
   */
  tokenFlowTotal(): number {
    return this.cachedAgg("tokenFlowTotal", () => {
      let total = 0;
      for (const { event } of this.scanType("token_flow")) {
        total += num(detailOf(event).tokens_saved);
      }
      return total;
    });
  }

  /**
   * Lifetime count of hard-prevention guardrail events (cascade / stale-edit /
   * intervention-halt / loop). Mirrors `isHardPrevention` in named-events.ts.
   */
  hardPreventionTotal(): number {
    return this.cachedAgg("hardPreventionTotal", () => {
      const hard = new Set([
        "cascade_guard",
        "stale_edit_prevented",
        "intervention_halted",
        "loop_broken",
      ]);
      let n = 0;
      for (const { event } of this.scanType("behavior")) {
        if (hard.has(str(detailOf(event).kind) ?? "")) n += 1;
      }
      return n;
    });
  }

  /**
   * Most-recent cumulative `transcript_footprint_tokens` written on a compression
   * row (S8). The shell-compression writer reads this, adds the new delivered
   * tokens, and stores the running total, so the latest row carries the running
   * footprint. Returns 0 when no compression row has carried the field.
   */
  transcriptFootprintLatest(): number {
    let latest = 0;
    for (const { event } of this.scanType("compression")) {
      const v = numN(detailOf(event).transcript_footprint_tokens);
      if (v != null) latest = v;
    }
    return latest;
  }

  fileReadsSince(lastId: number, limit = 500): FileReadEventRow[] {
    return this.scanProxyTypeSince("file_read", lastId)
      .slice(0, limit)
      .map(({ event, id }) => this.toFileReadRow(event, id));
  }

  tokenFlowSince(lastId: number, limit = 500): TokenFlowEventRow[] {
    return this.scanProxyTypeSince("token_flow", lastId)
      .slice(0, limit)
      .map(({ event, id }) => this.toTokenFlowRow(event, id));
  }

  allTokenFlow(): TokenFlowEventRow[] {
    return this.scanType("token_flow").map(({ event, id }) =>
      this.toTokenFlowRow(event, id)
    );
  }

  tokenFlowBySession(sessionId: string): TokenFlowEventRow[] {
    return this.scanType("token_flow")
      .filter(
        ({ event }) =>
          (event as { session_id?: string }).session_id === sessionId
      )
      .map(({ event, id }) => this.toTokenFlowRow(event, id));
  }

  /**
   * Running total of `tokens_saved` for one session — authoritative across
   * process restarts (sums the persisted segments, not an in-memory counter).
   */
  sessionTokensSaved(sessionId: string): number {
    return this.cachedAgg(`sessionTokensSaved:${sessionId}`, () => {
      let total = 0;
      for (const { event } of this.scanType("token_flow")) {
        if ((event as { session_id?: string }).session_id === sessionId) {
          total += num(detailOf(event).tokens_saved);
        }
      }
      return total;
    });
  }

  allBehaviorEvents(): BehaviorEventRow[] {
    return this.scanType("behavior").map(({ event, id }) =>
      this.toBehaviorRow(event, id)
    );
  }

  behaviorEventsBySession(sessionId: string): BehaviorEventRow[] {
    return this.scanType("behavior")
      .filter(
        ({ event }) =>
          (event as { session_id?: string }).session_id === sessionId
      )
      .map(({ event, id }) => this.toBehaviorRow(event, id));
  }

  /**
   * The most recent `user_prompt_received` boundary for `sessionId` — its
   * epoch-ms `ts` and the prompt content digest `hash` (from the event's
   * `detail.behavior_detail` JSON) — or `null` when none exists.
   *
   * Used by the prompt-capture hook to dedupe duplicate boundary writes (the
   * UserPromptSubmit hook can fire 2-3× per real prompt with identical content).
   */
  latestUserPromptBoundary(
    sessionId: string
  ): { ts: number; hash: string | null } | null {
    let latest: BehaviorEventRow | null = null;
    for (const { event, id } of this.scanType("behavior")) {
      if ((event as { session_id?: string }).session_id !== sessionId) continue;
      if (detailOf(event).kind !== "user_prompt_received") continue;
      const row = this.toBehaviorRow(event, id);
      if (!latest || row.ts >= latest.ts) latest = row;
    }
    if (!latest) return null;
    let hash: string | null = null;
    try {
      const parsed = JSON.parse(latest.detail ?? "{}") as {
        prompt_hash?: unknown;
      };
      if (typeof parsed.prompt_hash === "string") hash = parsed.prompt_hash;
    } catch {
      /* malformed detail — leave hash null */
    }
    return { ts: latest.ts, hash };
  }

  /**
   * True when `(session_id, turn)` already carries activity that precedes a
   * newly-arriving user prompt — any token-flow event, or any behavior event in
   * the same turn (a prior `user_prompt_received` counts). Flags a mid-turn
   * user interjection (steering / interrupt).
   */
  turnHasActivityBeforePrompt(sessionId: string, turn: number): boolean {
    for (const { event } of this.scanType("token_flow")) {
      if (
        (event as { session_id?: string }).session_id === sessionId &&
        (event as { turn?: number }).turn === turn
      ) {
        return true;
      }
    }
    for (const { event } of this.scanType("behavior")) {
      if (
        (event as { session_id?: string }).session_id === sessionId &&
        (event as { turn?: number }).turn === turn
      ) {
        // any behavior in this turn (incl. a prior user_prompt_received) counts
        return true;
      }
    }
    return false;
  }

  behaviorEventsSince(lastId: number, limit = 500): BehaviorEventRow[] {
    return this.scanProxyTypeSince("behavior", lastId)
      .slice(0, limit)
      .map(({ event, id }) => this.toBehaviorRow(event, id));
  }

  allSessionHistory(): SessionHistoryRow[] {
    const rows = [...this.latestSessionDetailByKind("history").values()].map(
      ({ event, id }) => this.toSessionHistoryRow(event, id)
    );
    // ORDER BY ended_at ASC
    rows.sort((a, b) => a.ended_at.localeCompare(b.ended_at));
    return rows;
  }

  sessionSummary(sessionId: string): SessionSummaryRow | null {
    const hit = this.latestSessionDetailByKind("summary").get(sessionId);
    return hit ? this.toSessionSummaryRow(hit.event) : null;
  }

  allSessionSummaries(): SessionSummaryRow[] {
    const rows = [...this.latestSessionDetailByKind("summary").values()].map(
      ({ event }) => this.toSessionSummaryRow(event)
    );
    // ORDER BY ended_at DESC
    rows.sort((a, b) => b.ended_at.localeCompare(a.ended_at));
    return rows;
  }

  /**
   * Current poll watermark for each polled stream — the proxy segment's byte
   * size. The log-tailer starts from here so it relays only events appended
   * after it began (replaces the SQLite `MAX(id)` per table). All four cursors
   * share the same combined offset because the streams interleave in one
   * segment; `*Since(offset)` filters by type after the offset.
   */
  lastIds(): {
    compression: number;
    fileRead: number;
    tokenFlow: number;
    behaviorEvent: number;
  } {
    const off = segmentSize(segmentPath(this.repoRoot, PROXY_SEGMENT));
    return {
      compression: off,
      fileRead: off,
      tokenFlow: off,
      behaviorEvent: off,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** No handles to release — telemetry and the transcript cache are both plain
   *  JSONL files opened per call. Kept (as a no-op) so shutdown call sites
   *  (`closeAllMetricsStores`) and tests compile unchanged. */
  close(): void {
    /* no-op — JSONL files hold no open handle */
  }

  /** Test-only — wipe the JSONL telemetry store + the transcript cache file. */
  reset(): void {
    try {
      rmSync(eventsDir(this.repoRoot), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      rmSync(this.transcriptCachePath, { force: true });
    } catch {
      /* best effort */
    }
    this.aggCacheSig = "";
    this.aggCache.clear();
  }
}

// ── Per-cwd singleton ────────────────────────────────────────────────

const instances = new Map<string, MetricsStore>();

/**
 * Open (or reuse) the metrics store for a given unerr directory. Telemetry is
 * written to `<repo>/.unerr/events/`; the agent-transcript read-cache is written
 * to `<repo>/.unerr/cache/transcripts.jsonl` (local-only, never drained).
 */
export function openMetricsStore(unerrDir: string): MetricsStore {
  let store = instances.get(unerrDir);
  if (!store) {
    mkdirSync(unerrDir, { recursive: true });
    store = new MetricsStore(unerrDir);
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
