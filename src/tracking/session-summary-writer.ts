/**
 * Session Summary Writer — SQLite persistence on session disconnect.
 *
 * Layer 9 PI-3/PI-4: When an --mcp session ends (stdin close / SIGTERM),
 * this module upserts a structured summary into `.unerr/metrics.db`
 * (`session_summaries` table — was JSONL at `.unerr/sessions/{id}.jsonl`).
 *
 * The daemon's fact generation pipeline (PI-5) reads these summaries to
 * extract facts, detect patterns, and reinforce/contradict existing knowledge.
 *
 * Key invariant: `session_id` is the row PK. Re-running for the same session
 * upserts (latest write wins) — matches the JSONL "append + last wins" model.
 *
 * Graceful degradation: if write fails, session data is lost but MCP
 * connection closes cleanly without error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionSummary, extractChains } from "./ledger-chains.js";
import { openMetricsStore } from "./metrics-store.js";
import type { LedgerEntry } from "./shadow-ledger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface SessionSummaryRecord {
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
}

export interface SessionWriterContext {
  sessionId: string;
  entries: LedgerEntry[];
  factsRecordedIds: string[];
  factsSurfacedIds: string[];
  rotScore: number;
  tokenEstimate: number;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Upsert a session summary into `.unerr/metrics.db` (session_summaries).
 * Called on graceful shutdown of --mcp mode.
 *
 * Returns the written record on success, null on failure (silent degradation).
 */
export function writeSessionSummary(
  unerrDir: string,
  ctx: SessionWriterContext
): SessionSummaryRecord | null {
  if (ctx.entries.length === 0) return null;

  try {
    const sorted = [...ctx.entries].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;

    const chains = extractChains(sorted);
    const files = new Set<string>();
    const entities = new Set<string>();
    const toolCounts: Record<string, number> = {};
    const featureAreas = new Set<string>();
    let revertCount = 0;

    for (const entry of sorted) {
      toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;

      const filePath = extractFilePath(entry);
      if (filePath) files.add(filePath);

      const entityKeys = extractEntityKeysFromEntry(entry);
      for (const key of entityKeys) entities.add(key);

      if (entry.feature_area) featureAreas.add(entry.feature_area);
    }

    for (const chain of chains) {
      if (chain.outcome === "reverted") revertCount++;
    }

    const record: SessionSummaryRecord = {
      session_id: ctx.sessionId,
      written_at: new Date().toISOString(),
      started_at: first.ts,
      ended_at: last.ts,
      duration_ms: new Date(last.ts).getTime() - new Date(first.ts).getTime(),
      tool_calls: sorted.length,
      chains: chains.length,
      files_modified: [...files],
      entities_touched: [...entities].slice(0, 50),
      tools_used: toolCounts,
      feature_areas: [...featureAreas],
      facts_recorded: ctx.factsRecordedIds.length,
      facts_surfaced: ctx.factsSurfacedIds.slice(0, 20),
      revert_count: revertCount,
      rot_score: ctx.rotScore,
      token_estimate: ctx.tokenEstimate,
      branch: last.branch ?? "unknown",
    };

    // Persist to .unerr/metrics.db (session_summaries) — was JSONL pre-Layer 12.
    const store = openMetricsStore(unerrDir);
    store.upsertSessionSummary({
      session_id: record.session_id,
      written_at: record.written_at,
      started_at: record.started_at,
      ended_at: record.ended_at,
      duration_ms: record.duration_ms,
      tool_calls: record.tool_calls,
      chains: record.chains,
      files_modified: JSON.stringify(record.files_modified),
      entities_touched: JSON.stringify(record.entities_touched),
      tools_used: JSON.stringify(record.tools_used),
      feature_areas: JSON.stringify(record.feature_areas),
      facts_recorded: record.facts_recorded,
      facts_surfaced: JSON.stringify(record.facts_surfaced),
      revert_count: record.revert_count,
      rot_score: record.rot_score,
      token_estimate: record.token_estimate,
      branch: record.branch,
    });

    // last_session.json stays JSON — atomic single-file pointer, stable
    // across daemon restarts, used by the "next session" resume strip.
    writeLastSessionPointer(unerrDir, ctx.sessionId, record);

    return record;
  } catch (err) {
    process.stderr.write(
      `[unerr:session] WARN: Failed to write session summary: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Read the last session summary (from last_session.json pointer).
 * Returns null if no prior session exists.
 */
export function readLastSession(unerrDir: string): SessionSummaryRecord | null {
  try {
    const pointerPath = join(unerrDir, "state", "last_session.json");
    if (!existsSync(pointerPath)) return null;

    const content = readFileSync(pointerPath, "utf-8");
    return JSON.parse(content) as SessionSummaryRecord;
  } catch {
    return null;
  }
}

// ── Internal ─────────────────────────────────────────────────────────

function writeLastSessionPointer(
  unerrDir: string,
  sessionId: string,
  record: SessionSummaryRecord
): void {
  try {
    const stateDir = join(unerrDir, "state");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    const pointerPath = join(stateDir, "last_session.json");
    writeFileSync(pointerPath, JSON.stringify(record, null, 2), "utf-8");
  } catch {
    // Non-critical — pointer failure doesn't affect session integrity
  }
}

function extractFilePath(entry: LedgerEntry): string | null {
  const args = entry.args_summary;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.path === "string") return args.path;
  if (typeof args.key === "string" && args.key.includes("/")) {
    return args.key.includes("::") ? args.key.split("::")[0]! : args.key;
  }
  return null;
}

function extractEntityKeysFromEntry(entry: LedgerEntry): string[] {
  const keys: string[] = [];
  const args = entry.args_summary;
  if (typeof args.key === "string" && args.key.length > 0) {
    keys.push(args.key);
  }
  if (typeof args.entity === "string" && args.entity.length > 0) {
    keys.push(args.entity);
  }
  return keys;
}
