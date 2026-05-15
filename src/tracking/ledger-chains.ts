/**
 * Ledger Chain Analyzer — causality-aware history from shadow ledger.
 *
 * Layer 9 PI-3: Transforms flat ledger entries into:
 *   1. Correlation chains (grouped tool calls forming one intent)
 *   2. Entity history (what happened to a specific entity across sessions)
 *   3. Session timelines (grouped by session, summarized by feature area)
 *   4. Revert pattern detection (chains that led to reverted code)
 *
 * All operations are read-only against the existing shadow.jsonl.
 * No mutations to ledger data — this is an analysis layer.
 */

import type { LedgerEntry } from "./shadow-ledger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface LedgerChain {
  root_id: string;
  session_id: string;
  branch: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  entries: LedgerEntry[];
  entities_touched: string[];
  tools_used: string[];
  feature_area: string | null;
  outcome: ChainOutcome;
}

export type ChainOutcome = "survived" | "reverted" | "modified" | "unknown";

export interface PatternSummary {
  pattern: string;
  tool_sequence: string[];
  frequency: number;
  revert_rate: number;
  avg_chain_length: number;
  example_chain_id: string;
}

export interface SessionSummary {
  session_id: string;
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
  revert_count: number;
}

// ── Chain Extraction ─────────────────────────────────────────────────

/**
 * Extract correlation chains from raw ledger entries.
 * A chain is a root entry + all entries correlated to it.
 */
export function extractChains(entries: LedgerEntry[]): LedgerChain[] {
  const rootMap = new Map<string, LedgerEntry[]>();

  for (const entry of entries) {
    const rootId = entry.correlation_id ?? entry.id;
    const group = rootMap.get(rootId);
    if (group) {
      group.push(entry);
    } else {
      rootMap.set(rootId, [entry]);
    }
  }

  const chains: LedgerChain[] = [];

  for (const [rootId, chainEntries] of rootMap) {
    if (chainEntries.length === 0) continue;

    const sorted = chainEntries.sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;

    const entities = extractEntitiesFromChain(sorted);
    const tools = [...new Set(sorted.map((e) => e.tool))];
    const featureArea = first.feature_area ?? inferFeatureArea(sorted);
    const outcome = classifyChainOutcome(sorted);

    chains.push({
      root_id: rootId,
      session_id: first.session_id,
      branch: first.branch,
      started_at: first.ts,
      ended_at: last.ts,
      duration_ms: new Date(last.ts).getTime() - new Date(first.ts).getTime(),
      entries: sorted,
      entities_touched: entities,
      tools_used: tools,
      feature_area: featureArea,
      outcome,
    });
  }

  return chains.sort(
    (a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
}

// ── Entity History ───────────────────────────────────────────────────

/**
 * Get chains that touched a specific entity (file path or entity key).
 */
export function getEntityHistory(
  entries: LedgerEntry[],
  entityKey: string,
  limit = 20
): LedgerChain[] {
  const chains = extractChains(entries);
  return chains
    .filter((chain) =>
      chain.entities_touched.some(
        (e) => e === entityKey || e.startsWith(entityKey)
      )
    )
    .slice(0, limit);
}

// ── Revert Pattern Detection ─────────────────────────────────────────

/**
 * Detect tool sequences that frequently lead to reverts.
 * A revert is detected when a chain contains "unerr_revert_to_working_state"
 * or when the same entity is modified multiple times in a session (thrashing).
 */
export function getRevertPatterns(
  entries: LedgerEntry[],
  minFrequency = 2
): PatternSummary[] {
  const chains = extractChains(entries);
  const sequenceMap = new Map<
    string,
    {
      count: number;
      revertCount: number;
      lengths: number[];
      exampleId: string;
      tools: string[];
    }
  >();

  for (const chain of chains) {
    const seqKey = chain.tools_used.slice(0, 4).join(" → ");
    const existing = sequenceMap.get(seqKey);
    const isRevert = chain.outcome === "reverted";

    if (existing) {
      existing.count++;
      if (isRevert) existing.revertCount++;
      existing.lengths.push(chain.entries.length);
    } else {
      sequenceMap.set(seqKey, {
        count: 1,
        revertCount: isRevert ? 1 : 0,
        lengths: [chain.entries.length],
        exampleId: chain.root_id,
        tools: chain.tools_used.slice(0, 4),
      });
    }
  }

  const patterns: PatternSummary[] = [];
  for (const [pattern, data] of sequenceMap) {
    if (data.count < minFrequency) continue;
    if (data.revertCount === 0) continue;

    const avgLength =
      data.lengths.reduce((a, b) => a + b, 0) / data.lengths.length;

    patterns.push({
      pattern,
      tool_sequence: data.tools,
      frequency: data.count,
      revert_rate: data.revertCount / data.count,
      avg_chain_length: Math.round(avgLength * 10) / 10,
      example_chain_id: data.exampleId,
    });
  }

  return patterns.sort((a, b) => b.revert_rate - a.revert_rate);
}

// ── Session Timeline ─────────────────────────────────────────────────

/**
 * Get session summaries from ledger entries, most recent first.
 */
export function getSessionTimeline(
  entries: LedgerEntry[],
  count = 5
): SessionSummary[] {
  const sessionMap = new Map<string, LedgerEntry[]>();

  for (const entry of entries) {
    const group = sessionMap.get(entry.session_id);
    if (group) {
      group.push(entry);
    } else {
      sessionMap.set(entry.session_id, [entry]);
    }
  }

  const summaries: SessionSummary[] = [];

  for (const [sessionId, sessionEntries] of sessionMap) {
    if (sessionEntries.length === 0) continue;

    const sorted = sessionEntries.sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;

    const chains = extractChains(sorted);
    const files = new Set<string>();
    const entities = new Set<string>();
    const toolCounts: Record<string, number> = {};
    const featureAreas = new Set<string>();
    let factsRecorded = 0;
    let revertCount = 0;

    for (const entry of sorted) {
      toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;

      if (entry.tool === "record_fact") factsRecorded++;

      const filePath = extractFilePath(entry);
      if (filePath) files.add(filePath);

      const entityKeys = extractEntityKeys(entry);
      for (const key of entityKeys) entities.add(key);

      if (entry.feature_area) featureAreas.add(entry.feature_area);
    }

    for (const chain of chains) {
      if (chain.outcome === "reverted") revertCount++;
    }

    summaries.push({
      session_id: sessionId,
      started_at: first.ts,
      ended_at: last.ts,
      duration_ms: new Date(last.ts).getTime() - new Date(first.ts).getTime(),
      tool_calls: sorted.length,
      chains: chains.length,
      files_modified: [...files],
      entities_touched: [...entities],
      tools_used: toolCounts,
      feature_areas: [...featureAreas],
      facts_recorded: factsRecorded,
      revert_count: revertCount,
    });
  }

  return summaries
    .sort(
      (a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    )
    .slice(0, count);
}

// ── Internal Helpers ─────────────────────────────────────────────────

function extractEntitiesFromChain(entries: LedgerEntry[]): string[] {
  const entities = new Set<string>();
  for (const entry of entries) {
    const keys = extractEntityKeys(entry);
    for (const key of keys) entities.add(key);
    const filePath = extractFilePath(entry);
    if (filePath) entities.add(filePath);
  }
  return [...entities];
}

function extractEntityKeys(entry: LedgerEntry): string[] {
  const keys: string[] = [];
  const args = entry.args_summary;
  if (typeof args.key === "string" && args.key.length > 0) {
    keys.push(args.key);
  }
  if (typeof args.entity === "string" && args.entity.length > 0) {
    keys.push(args.entity);
  }
  if (typeof args.subject === "string" && args.subject.length > 0) {
    keys.push(args.subject);
  }
  return keys;
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

function inferFeatureArea(entries: LedgerEntry[]): string | null {
  for (const entry of entries) {
    if (entry.feature_area) return entry.feature_area;
  }

  const paths = entries
    .map(extractFilePath)
    .filter((p): p is string => p !== null);
  if (paths.length === 0) return null;

  const segments = paths[0]?.split("/");
  if (segments && segments.length >= 2) {
    return segments.slice(0, 2).join("/");
  }
  return null;
}

function classifyChainOutcome(entries: LedgerEntry[]): ChainOutcome {
  const hasRevert = entries.some(
    (e) =>
      e.tool === "unerr_revert_to_working_state" ||
      e.result_summary?.reverted === true
  );
  if (hasRevert) return "reverted";

  const hasModify = entries.some(
    (e) => e.tool === "sync_local_diff" || e.result_summary?.modified === true
  );
  if (hasModify) return "modified";

  const hasCommit = entries.some(
    (e) => e.commit_sha != null && e.commit_sha.length > 0
  );
  if (hasCommit) return "survived";

  return "unknown";
}
