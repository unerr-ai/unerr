/**
 * L7 read benchmark — JSONL file-scan reads vs indexed SQLite reads for the
 * analytics aggregations that `unerr gain` / `stats` / receipts run.
 *
 * Why this exists: the telemetry transport moved analytics off SQLite
 * (`.unerr/metrics.db`) onto a per-repo append-only JSONL event store
 * (`.unerr/events/<segment>.jsonl`). The read path now SCANS JSONL and
 * aggregates in JS (SUM / GROUP BY) instead of running an indexed SQL query.
 * `.internal/archive/TELEMETRY_AND_EVENTS_ARCHITECTURE.md` §6 calls for a
 * "JSONL-vs-SQLite read benchmark" because "indexed SQLite → file scans" needs
 * to be perf-gated. This file is that gate. It is ADDITIVE — it touches no
 * production source; it only imports the real JSONL primitives to measure them.
 *
 * What it measures, per N (1k / 10k / 50k):
 *   Path A (JSONL)   — the REAL read path: `appendEvent` the events to a temp
 *                      segment, then `readSegmentFrom` + a JS GROUP-BY-mechanism
 *                      / SUM(tokens_saved) aggregate (the same shape as
 *                      token-flow.ts `aggregateSession`).
 *   Path B (SQLite)  — the historical indexed-SQLite baseline: a table modeled
 *                      on the old `token_flow_events`, an index on `mechanism`
 *                      (the grouped column), N inserts, then the equivalent
 *                      `SELECT mechanism, SUM(tokens_saved) ... GROUP BY`.
 *
 * Both paths produce the SAME aggregate from the SAME deterministic data
 * (seeded by index — fixed base timestamp + index offset, no Math.random / live
 * Date.now in the data), so the comparison is apples-to-apples and reproducible.
 *
 * Run it:
 *   pnpm exec tsx benchmarks/jsonl-vs-sqlite-read.ts
 *   # or, with a custom N list:
 *   pnpm exec tsx benchmarks/jsonl-vs-sqlite-read.ts 1000 10000 50000 200000
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import {
  PROXY_SEGMENT,
  type StoredEvent,
  appendEvent,
  listSegments,
  readSegmentFrom,
  segmentSize,
} from "../src/events/event-store.js";

// ── Config ──────────────────────────────────────────────────────────

/** The grouped column's value set — mirrors token-flow's mechanism tags. */
const MECHANISMS = [
  "graph_query",
  "session_dedup",
  "shell_compression",
  "file_read",
  "fetch_url",
  "context_bundle",
] as const;

const SCHEMA_VERSION = "1-0-9"; // INGEST_SCHEMA_VERSION (events/index.ts)
/** Warm-up runs (discarded) + measured runs (averaged). */
const WARMUP = 1;
const RUNS = 5;
/** Fixed base so timestamps are deterministic, not wall-clock. */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

// ── Deterministic data generator ────────────────────────────────────

/**
 * One analytics event, fully derived from its index `i` — same `i` always
 * yields byte-identical content. No randomness, no live clock in the payload.
 */
function makeEvent(i: number): StoredEvent {
  const mechanism = MECHANISMS[i % MECHANISMS.length];
  const tokensSaved = 100 + (i % 900); // 100..999, spread across mechanisms
  const tokensWith = 50 + (i % 450);
  const tokensWithout = tokensWith + tokensSaved;
  const ts = new Date(BASE_MS + i * 1000).toISOString();
  return {
    type: "token_flow",
    schema_version: SCHEMA_VERSION,
    event_id: `evt-${i.toString(16).padStart(12, "0")}`,
    ts,
    source: "proxy",
    session_id: `sess-${i % 4}`,
    turn: (i % 50) + 1,
    detail: {
      mechanism,
      tool: mechanism === "shell_compression" ? null : "search_code",
      tokens_input: tokensWithout,
      tokens_output: tokensWith,
      tokens_saved: tokensSaved,
    },
  } as unknown as StoredEvent;
}

// ── The aggregate every reader computes ─────────────────────────────

interface MechanismAgg {
  tokens_saved: number;
  tokens_delivered: number;
  event_count: number;
}
type AggResult = Map<string, MechanismAgg>;

/** A canonical signature so we can assert both paths agree. */
function aggSignature(agg: AggResult): string {
  return [...agg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([m, v]) =>
        `${m}:${v.tokens_saved}/${v.tokens_delivered}/${v.event_count}`
    )
    .join("|");
}

// ── Path A — JSONL scan + JS GROUP BY (the real read path) ──────────

/**
 * Read every analytics event from the repo's JSONL segments via the real
 * `readSegmentFrom` and aggregate GROUP BY mechanism / SUM in JS — the same
 * shape token-flow.ts `aggregateSession` runs on the read path.
 */
function aggregateJsonl(repoRoot: string): AggResult {
  const agg: AggResult = new Map();
  for (const seg of listSegments(repoRoot)) {
    // Read the whole segment forward from offset 0 (no caps — full scan, which
    // is what a dashboard / `unerr gain` aggregate does).
    const { events } = readSegmentFrom(seg, 0);
    for (const e of events) {
      const detail = (e as { detail?: Record<string, unknown> }).detail ?? {};
      const mechanism = String(detail.mechanism ?? "unknown");
      const saved = Number(detail.tokens_saved ?? 0);
      const delivered = Number(detail.tokens_output ?? 0);
      const cur = agg.get(mechanism) ?? {
        tokens_saved: 0,
        tokens_delivered: 0,
        event_count: 0,
      };
      cur.tokens_saved += saved;
      cur.tokens_delivered += delivered;
      cur.event_count += 1;
      agg.set(mechanism, cur);
    }
  }
  return agg;
}

// ── Path B — indexed SQLite (the historical baseline) ───────────────

interface SqliteHandle {
  db: Database.Database;
  query: () => AggResult;
  bytes: number;
}

/**
 * Build the indexed-SQLite baseline: a table modeled on the old
 * `token_flow_events`, an index on the grouped column (`mechanism`), N inserts
 * in one transaction, then the prepared GROUP BY / SUM. This is what the read
 * path looked like BEFORE the JSONL move — the thing the JSONL scan replaces.
 */
function buildSqlite(dbPath: string, n: number): SqliteHandle {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE token_flow_events (
      id            INTEGER PRIMARY KEY,
      ts_iso        TEXT    NOT NULL,
      session_id    TEXT    NOT NULL,
      turn          INTEGER NOT NULL,
      mechanism     TEXT    NOT NULL,
      tool          TEXT,
      tokens_without INTEGER NOT NULL,
      tokens_with   INTEGER NOT NULL,
      tokens_saved  INTEGER NOT NULL
    );
    CREATE INDEX idx_tfe_mechanism ON token_flow_events(mechanism);
  `);

  const insert = db.prepare(
    `INSERT INTO token_flow_events
       (id, ts_iso, session_id, turn, mechanism, tool, tokens_without, tokens_with, tokens_saved)
     VALUES (@id, @ts, @session, @turn, @mechanism, @tool, @without, @with, @saved)`
  );
  const insertMany = db.transaction((rows: number) => {
    for (let i = 0; i < rows; i++) {
      const e = makeEvent(i);
      const d = (e as { detail: Record<string, unknown> }).detail;
      insert.run({
        id: i,
        ts: (e as { ts: string }).ts,
        session: (e as { session_id: string }).session_id,
        turn: (e as { turn: number }).turn,
        mechanism: String(d.mechanism),
        tool: (d.tool as string | null) ?? null,
        without: Number(d.tokens_input),
        with: Number(d.tokens_output),
        saved: Number(d.tokens_saved),
      });
    }
  });
  insertMany(n);

  const select = db.prepare(
    `SELECT mechanism,
            SUM(tokens_saved) AS tokens_saved,
            SUM(tokens_with)  AS tokens_delivered,
            COUNT(*)          AS event_count
     FROM token_flow_events
     GROUP BY mechanism`
  );

  const query = (): AggResult => {
    const agg: AggResult = new Map();
    for (const r of select.all() as Array<{
      mechanism: string;
      tokens_saved: number;
      tokens_delivered: number;
      event_count: number;
    }>) {
      agg.set(r.mechanism, {
        tokens_saved: r.tokens_saved,
        tokens_delivered: r.tokens_delivered,
        event_count: r.event_count,
      });
    }
    return agg;
  };

  // Size on disk = main db file + any WAL sidecar.
  const main = db.prepare("PRAGMA page_count").get() as { page_count: number };
  const pageSize = (db.pragma("page_size", { simple: true }) as number) ?? 4096;
  const bytes = (main.page_count ?? 0) * pageSize;

  return { db, query, bytes };
}

// ── Timing helper ───────────────────────────────────────────────────

function timeAvg(fn: () => unknown): number {
  for (let i = 0; i < WARMUP; i++) fn();
  let total = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    total += performance.now() - t0;
  }
  return total / RUNS;
}

function fmt(ms: number): string {
  return ms.toFixed(3);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Main ────────────────────────────────────────────────────────────

function runForN(n: number): {
  n: number;
  jsonlMs: number;
  sqliteMs: number;
  jsonlBytes: number;
  sqliteBytes: number;
} {
  const root = mkdtempSync(join(tmpdir(), `l7-jsonl-${n}-`));
  try {
    // Populate the JSONL segment with the real append primitive.
    for (let i = 0; i < n; i++) {
      appendEvent(root, PROXY_SEGMENT, makeEvent(i));
    }
    const jsonlBytes = listSegments(root).reduce(
      (sum, seg) => sum + segmentSize(seg),
      0
    );

    // Populate the indexed SQLite baseline.
    const dbPath = join(root, "metrics.db");
    const sqlite = buildSqlite(dbPath, n);

    // Correctness: both paths must yield the identical aggregate.
    const jsonlAgg = aggregateJsonl(root);
    const sqliteAgg = sqlite.query();
    const jSig = aggSignature(jsonlAgg);
    const sSig = aggSignature(sqliteAgg);
    if (jSig !== sSig) {
      throw new Error(
        `aggregate mismatch at N=${n}\n  JSONL : ${jSig}\n  SQLite: ${sSig}`
      );
    }

    const jsonlMs = timeAvg(() => aggregateJsonl(root));
    const sqliteMs = timeAvg(() => sqlite.query());
    const sqliteBytes = sqlite.bytes;

    sqlite.db.close();
    return { n, jsonlMs, sqliteMs, jsonlBytes, sqliteBytes };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  const argv = process.argv.slice(2).map((x) => Number.parseInt(x, 10));
  const Ns =
    argv.length > 0 && argv.every((x) => x > 0) ? argv : [1000, 10000, 50000];

  process.stderr.write(
    `L7 read benchmark — JSONL scan vs indexed SQLite (GROUP BY mechanism, SUM tokens_saved)\n  warmup=${WARMUP} runs=${RUNS} (averaged), better-sqlite3 indexed on mechanism\n\n`
  );

  const results = Ns.map(runForN);

  // Table.
  const head = [
    "N".padStart(8),
    "JSONL ms".padStart(12),
    "SQLite ms".padStart(12),
    "ratio (J/S)".padStart(13),
    "JSONL disk".padStart(12),
    "SQLite disk".padStart(12),
  ].join("  ");
  const sep = "-".repeat(head.length);
  process.stdout.write(`${head}\n${sep}\n`);

  for (const r of results) {
    const ratio = r.sqliteMs > 0 ? r.jsonlMs / r.sqliteMs : Number.NaN;
    process.stdout.write(
      `${[
        String(r.n).padStart(8),
        fmt(r.jsonlMs).padStart(12),
        fmt(r.sqliteMs).padStart(12),
        `${ratio.toFixed(2)}x`.padStart(13),
        fmtBytes(r.jsonlBytes).padStart(12),
        fmtBytes(r.sqliteBytes).padStart(12),
      ].join("  ")}\n`
    );
  }
  process.stdout.write(`${sep}\n`);
}

main();
