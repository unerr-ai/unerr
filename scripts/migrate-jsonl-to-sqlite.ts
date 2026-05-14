#!/usr/bin/env tsx
/**
 * One-time migration from the legacy JSONL stores to `.unerr/metrics.db`.
 *
 * This script is NOT wired into the runtime — we haven't shipped a release
 * yet, so there's no upgrade path to honour. The intent is purely to backfill
 * your *local* `.unerr/metrics.db` from any JSONL files lying around so the
 * dashboard / `unerr stats` / `unerr status` have real data to render while
 * you smoke-test the new code path.
 *
 * Usage (from the repo root, after `pnpm install`):
 *
 *   pnpm exec tsx scripts/migrate-jsonl-to-sqlite.ts [unerrDir]
 *
 *   - `unerrDir` defaults to `<cwd>/.unerr`
 *
 * Behaviour:
 *   - Reads `logs/compression.jsonl`, `logs/token-flow.jsonl`,
 *     `logs/file-reads.jsonl`, `state/session-history.jsonl`,
 *     and `sessions/*.jsonl`.
 *   - Inserts into the corresponding tables in `.unerr/metrics.db`
 *     via the same `MetricsStore` the runtime uses.
 *   - Idempotent for session_history + session_summaries (upsert on PK).
 *   - For the three event-log tables (compression / file_read / token_flow),
 *     re-running this script will APPEND duplicates — call once.
 *
 * Outputs row counts inserted per table.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openMetricsStore } from "../src/tracking/metrics-store.js";

function parseTs(ts: string | undefined): number {
  if (!ts) return Date.now();
  const n = Date.parse(ts);
  return Number.isNaN(n) ? Date.now() : n;
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const out: T[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function migrateCompression(unerrDir: string): number {
  const path = join(unerrDir, "logs", "compression.jsonl");
  const rows = readJsonl<{
    ts: string;
    command: string;
    category: string;
    confidence: number;
    rawBytes: number;
    compressedBytes: number;
    savedPct: number;
    omniFallback: boolean;
    teeFile?: string;
  }>(path);
  if (rows.length === 0) return 0;

  const store = openMetricsStore(unerrDir);
  for (const r of rows) {
    store.insertCompression({
      ts: parseTs(r.ts),
      ts_iso: r.ts,
      command: r.command,
      category: r.category,
      confidence: r.confidence ?? 1,
      raw_bytes: r.rawBytes ?? 0,
      compressed_bytes: r.compressedBytes ?? 0,
      saved_pct: r.savedPct ?? 0,
      omni_fallback: r.omniFallback ? 1 : 0,
      tee_file: r.teeFile ?? null,
    });
  }
  return rows.length;
}

function migrateFileReads(unerrDir: string): number {
  const path = join(unerrDir, "logs", "file-reads.jsonl");
  const rows = readJsonl<{
    ts: string;
    file: string;
    mode: string;
    totalLines: number;
    returnedLines: number;
    savedPct: number;
    entity?: string;
    tokenEstimate?: number;
  }>(path);
  if (rows.length === 0) return 0;

  const store = openMetricsStore(unerrDir);
  for (const r of rows) {
    store.insertFileRead({
      ts: parseTs(r.ts),
      ts_iso: r.ts,
      file: r.file,
      mode: r.mode,
      total_lines: r.totalLines ?? 0,
      returned_lines: r.returnedLines ?? 0,
      saved_pct: r.savedPct ?? 0,
      entity: r.entity ?? null,
      token_estimate: r.tokenEstimate ?? null,
    });
  }
  return rows.length;
}

function migrateTokenFlow(unerrDir: string): number {
  const path = join(unerrDir, "logs", "token-flow.jsonl");
  const rows = readJsonl<{
    id: number;
    ts: string;
    session_id: string;
    pid: number;
    turn: number;
    mechanism: string;
    tool: string | null;
    tokens_without: number;
    tokens_with: number;
    tokens_saved: number;
    detail?: Record<string, unknown>;
  }>(path);
  if (rows.length === 0) return 0;

  const store = openMetricsStore(unerrDir);
  for (const r of rows) {
    store.insertTokenFlow({
      ts: parseTs(r.ts),
      ts_iso: r.ts,
      session_id: r.session_id,
      pid: r.pid ?? 0,
      turn: r.turn ?? 0,
      mechanism: r.mechanism,
      tool: r.tool ?? null,
      tokens_without: r.tokens_without ?? 0,
      tokens_with: r.tokens_with ?? 0,
      tokens_saved: r.tokens_saved ?? 0,
      detail: r.detail ? JSON.stringify(r.detail) : null,
    });
  }
  return rows.length;
}

function migrateSessionHistory(unerrDir: string): number {
  const path = join(unerrDir, "state", "session-history.jsonl");
  const rows = readJsonl<{
    sessionId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    toolCalls: number;
    tokensSaved: number;
    tokensProcessed: number;
    efficiency: number;
    dollarsSaved: number;
    modelId: string;
    entityCount: number;
    agentName?: string;
    tokenFlowSummary?: unknown;
  }>(path);
  if (rows.length === 0) return 0;

  const store = openMetricsStore(unerrDir);
  for (const r of rows) {
    store.upsertSessionHistory({
      session_id: r.sessionId,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      duration_ms: r.durationMs ?? 0,
      tool_calls: r.toolCalls ?? 0,
      tokens_saved: r.tokensSaved ?? 0,
      tokens_processed: r.tokensProcessed ?? 0,
      efficiency: r.efficiency ?? 0,
      dollars_saved: r.dollarsSaved ?? 0,
      model_id: r.modelId ?? "unknown",
      entity_count: r.entityCount ?? 0,
      agent_name: r.agentName ?? null,
      token_flow_summary: r.tokenFlowSummary
        ? JSON.stringify(r.tokenFlowSummary)
        : null,
    });
  }
  return rows.length;
}

function migrateSessionSummaries(unerrDir: string): number {
  const sessionsDir = join(unerrDir, "sessions");
  if (!existsSync(sessionsDir)) return 0;
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return 0;

  const store = openMetricsStore(unerrDir);
  let count = 0;
  for (const f of files) {
    const filePath = join(sessionsDir, f);
    const rows = readJsonl<{
      session_id: string;
      written_at: string;
      started_at: string;
      ended_at: string;
      duration_ms: number;
      tool_calls: number;
      chains: number;
      files_modified: string[];
      entities_touched: string[];
      tools_used: Record<string, number>;
      feature_areas: string[];
      facts_recorded: number;
      facts_surfaced: string[];
      revert_count: number;
      rot_score: number;
      token_estimate: number;
      branch: string;
    }>(filePath);
    // Each file is "append-only, latest wins" — take the last record.
    if (rows.length === 0) continue;
    const r = rows[rows.length - 1]!;
    store.upsertSessionSummary({
      session_id: r.session_id,
      written_at: r.written_at,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_ms: r.duration_ms,
      tool_calls: r.tool_calls,
      chains: r.chains,
      files_modified: JSON.stringify(r.files_modified ?? []),
      entities_touched: JSON.stringify(r.entities_touched ?? []),
      tools_used: JSON.stringify(r.tools_used ?? {}),
      feature_areas: JSON.stringify(r.feature_areas ?? []),
      facts_recorded: r.facts_recorded ?? 0,
      facts_surfaced: JSON.stringify(r.facts_surfaced ?? []),
      revert_count: r.revert_count ?? 0,
      rot_score: r.rot_score ?? 0,
      token_estimate: r.token_estimate ?? 0,
      branch: r.branch ?? "unknown",
    });
    count++;
  }
  return count;
}

function maybeBackup(unerrDir: string, ...files: string[]): void {
  for (const f of files) {
    const p = join(unerrDir, f);
    if (existsSync(p) && statSync(p).size > 0) {
      const bak = `${p}.pre-sqlite.bak`;
      if (!existsSync(bak)) {
        renameSync(p, bak);
        // Restore an empty file so anything tailing the path doesn't crash.
        writeFileSync(p, "");
      }
    }
  }
}

function main(): void {
  const cwd = process.argv[2] ?? process.cwd();
  const unerrDir = cwd.endsWith(".unerr") ? cwd : join(cwd, ".unerr");
  if (!existsSync(unerrDir)) {
    process.stderr.write(`No .unerr directory at ${unerrDir} — nothing to do.\n`);
    process.exit(0);
  }

  process.stderr.write(`Migrating JSONL → SQLite for ${unerrDir}\n`);

  const counts = {
    compression: migrateCompression(unerrDir),
    fileReads: migrateFileReads(unerrDir),
    tokenFlow: migrateTokenFlow(unerrDir),
    sessionHistory: migrateSessionHistory(unerrDir),
    sessionSummaries: migrateSessionSummaries(unerrDir),
  };

  process.stderr.write("Done. Inserted:\n");
  for (const [k, v] of Object.entries(counts)) {
    process.stderr.write(`  ${k.padEnd(20)} ${v}\n`);
  }

  // Move the source JSONL files aside so the runtime can't read stale data.
  maybeBackup(
    unerrDir,
    "logs/compression.jsonl",
    "logs/file-reads.jsonl",
    "logs/token-flow.jsonl",
    "state/session-history.jsonl",
  );
  process.stderr.write(
    "Source JSONL files renamed to *.pre-sqlite.bak (delete by hand if all good).\n",
  );
}

main();
