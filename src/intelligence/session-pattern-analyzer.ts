/**
 * Sprint 5: Session Pattern Analyzer — auto-detects facts from coding session patterns.
 *
 * Runs async (not in hot path) at two trigger points:
 * 1. Every 20 tool calls (daemon mode only, via setImmediate)
 * 2. At session shutdown (both unerr and unerr --mcp modes)
 *
 * Four sub-analyzers (all heuristic, no LLM):
 * A. Entity Access Frequency — entities accessed 3+ times → procedural fact
 * B. File Coupling — files co-occurring in correlation window 3+ times → semantic fact
 * C. Hot File Detection — files read 5+ times → procedural fact
 * D. Convention Stability — conventions stable across runs → high-confidence convention fact
 *
 * All use existing createFact() dedup: duplicate (fact_type, scope, subject) → reinforceFact().
 *
 * ── Content shape is forward-only ──────────────────────────────────────
 * Fact content strings here are persisted to facts.db. Rewriting the
 * template strings below (e.g., nudge wording v2.1 → v2.2) does NOT
 * backfill existing rows — old facts keep their original content until
 * the underlying signal disappears or is dedup-reinforced with new text.
 * If a future rewrite needs to migrate stored facts, add an explicit
 * one-shot migration that rewrites by (fact_type, scope, subject) match.
 */

import type { LedgerEntry } from "../tracking/shadow-ledger.js";

/** Minimal fact store interface — avoids importing the full TemporalFactStore. */
interface FactStoreWriter {
  createFact(input: {
    fact_type: string;
    scope: string;
    subject: string;
    content: string;
    source: string;
    confidence?: number;
  }): Promise<{ fact_id: string; deduplicated: boolean }>;
}

/** Result of pattern analysis. */
export interface PatternAnalysisResult {
  factsCreated: number;
  factsReinforced: number;
  patternsDetected: string[];
}

/** Correlation window for grouping related tool calls. */
const CORRELATION_WINDOW_MS = 30_000;

/** Minimum access count thresholds (Sprint 7: raised to reduce noise). */
const ENTITY_ACCESS_THRESHOLD = 5;
const FILE_COUPLING_THRESHOLD = 3; // Already reasonable — keep
const HOT_FILE_THRESHOLD = 8;

/** Sprint 7: Minimum actionability — facts below this confidence are noise. */
const MIN_FACT_CONFIDENCE = 0.4;

/**
 * Analyze session patterns from shadow ledger entries and create/reinforce facts.
 *
 * Designed to be called asynchronously — not in the tool-call hot path.
 * Safe to call multiple times (idempotent via createFact dedup).
 */
export async function analyzeSessionPatterns(input: {
  ledgerEntries: LedgerEntry[];
  factStore: FactStoreWriter;
  sessionId: string;
}): Promise<PatternAnalysisResult> {
  const { ledgerEntries, factStore, sessionId } = input;
  const result: PatternAnalysisResult = {
    factsCreated: 0,
    factsReinforced: 0,
    patternsDetected: [],
  };

  if (ledgerEntries.length === 0) return result;

  // Run all sub-analyzers
  const [entityResults, couplingResults, hotFileResults] = await Promise.all([
    analyzeEntityAccess(ledgerEntries, factStore, sessionId),
    analyzeFileCoupling(ledgerEntries, factStore),
    analyzeHotFiles(ledgerEntries, factStore),
  ]);

  // Aggregate results
  for (const sub of [entityResults, couplingResults, hotFileResults]) {
    result.factsCreated += sub.factsCreated;
    result.factsReinforced += sub.factsReinforced;
    result.patternsDetected.push(...sub.patternsDetected);
  }

  return result;
}

/**
 * Sub-analyzer A: Entity Access Frequency.
 * Entities accessed >= 3 times → procedural fact about entity importance.
 */
async function analyzeEntityAccess(
  entries: LedgerEntry[],
  factStore: FactStoreWriter,
  sessionId: string
): Promise<PatternAnalysisResult> {
  const result: PatternAnalysisResult = {
    factsCreated: 0,
    factsReinforced: 0,
    patternsDetected: [],
  };

  // Count entity accesses from tool args
  const entityCounts = new Map<string, { count: number; file: string }>();

  for (const entry of entries) {
    const entityKey =
      (entry.args_summary.key as string) ??
      (entry.args_summary.entity as string);
    const filePath =
      (entry.args_summary.file_path as string) ??
      (entry.args_summary.path as string);

    if (entityKey) {
      const existing = entityCounts.get(entityKey);
      if (existing) {
        existing.count++;
        if (filePath) existing.file = filePath;
      } else {
        entityCounts.set(entityKey, {
          count: 1,
          file: filePath ?? "unknown",
        });
      }
    }
  }

  // Create facts for frequently accessed entities
  for (const [entityKey, data] of entityCounts) {
    const confidence = Math.min(0.5 + data.count * 0.05, 0.85);
    if (
      data.count >= ENTITY_ACCESS_THRESHOLD &&
      confidence >= MIN_FACT_CONFIDENCE
    ) {
      await factStore.createFact({
        fact_type: "procedural",
        scope: data.file,
        subject: entityKey,
        content: `${entityKey} — key entity (accessed ${data.count}× in session ${sessionId}) — pin via record_fact if it's a stable invariant`,
        source: "session_analysis",
        confidence,
      });

      result.factsCreated++;
      result.patternsDetected.push(`entity:${entityKey}(${data.count}x)`);
    }
  }

  return result;
}

/**
 * Sub-analyzer B: File Coupling.
 * Files co-occurring in correlation windows >= 3 times → semantic fact.
 */
async function analyzeFileCoupling(
  entries: LedgerEntry[],
  factStore: FactStoreWriter
): Promise<PatternAnalysisResult> {
  const result: PatternAnalysisResult = {
    factsCreated: 0,
    factsReinforced: 0,
    patternsDetected: [],
  };

  // Group entries into correlation windows
  const windows: LedgerEntry[][] = [];
  let currentWindow: LedgerEntry[] = [];

  for (const entry of entries) {
    const ts = new Date(entry.ts).getTime();
    if (
      currentWindow.length === 0 ||
      ts - new Date(currentWindow[0]!.ts).getTime() <= CORRELATION_WINDOW_MS
    ) {
      currentWindow.push(entry);
    } else {
      if (currentWindow.length > 0) windows.push(currentWindow);
      currentWindow = [entry];
    }
  }
  if (currentWindow.length > 0) windows.push(currentWindow);

  // Count file co-occurrences within windows
  const coOccurrences = new Map<string, number>();

  for (const window of windows) {
    const filesInWindow = new Set<string>();
    for (const entry of window) {
      const filePath =
        (entry.args_summary.file_path as string) ??
        (entry.args_summary.path as string);
      if (filePath) filesInWindow.add(filePath);
    }

    // Generate sorted pairs
    const fileList = [...filesInWindow].sort();
    for (let i = 0; i < fileList.length; i++) {
      for (let j = i + 1; j < fileList.length; j++) {
        const pairKey = `${fileList[i]}↔${fileList[j]}`;
        coOccurrences.set(pairKey, (coOccurrences.get(pairKey) ?? 0) + 1);
      }
    }
  }

  // Create facts for frequently coupled files
  for (const [pairKey, count] of coOccurrences) {
    const confidence = Math.min(0.5 + count * 0.05, 0.85);
    if (count >= FILE_COUPLING_THRESHOLD && confidence >= MIN_FACT_CONFIDENCE) {
      const [fileA, fileB] = pairKey.split("↔");
      await factStore.createFact({
        fact_type: "semantic",
        scope: "project",
        subject: `coupling:${pairKey}`,
        content: `${fileA} ↔ ${fileB} co-change (${count}×) — open both before editing either`,
        source: "session_analysis",
        confidence,
      });

      result.factsCreated++;
      result.patternsDetected.push(
        `coupling:${shortPath(fileA!)}↔${shortPath(fileB!)}(${count}x)`
      );
    }
  }

  return result;
}

/**
 * Sub-analyzer C: Hot File Detection.
 * Files accessed via file_read >= 5 times → procedural fact about file importance.
 */
async function analyzeHotFiles(
  entries: LedgerEntry[],
  factStore: FactStoreWriter
): Promise<PatternAnalysisResult> {
  const result: PatternAnalysisResult = {
    factsCreated: 0,
    factsReinforced: 0,
    patternsDetected: [],
  };

  const fileCounts = new Map<string, number>();

  for (const entry of entries) {
    const filePath =
      (entry.args_summary.file_path as string) ??
      (entry.args_summary.path as string);
    if (filePath) {
      fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1);
    }
  }

  for (const [filePath, count] of fileCounts) {
    const confidence = Math.min(0.5 + count * 0.03, 0.8);
    if (count >= HOT_FILE_THRESHOLD && confidence >= MIN_FACT_CONFIDENCE) {
      await factStore.createFact({
        fact_type: "procedural",
        scope: filePath,
        subject: "hot-file",
        // Imperative tail so the agent has a concrete follow-up — bare
        // "hot file (N accesses)" is descriptive only and gets discarded.
        content: `${filePath} — hot file (${count} accesses) — call get_test_coverage to verify it has coverage`,
        source: "session_analysis",
        confidence,
      });

      result.factsCreated++;
      result.patternsDetected.push(
        `hot-file:${shortPath(filePath)}(${count}x)`
      );
    }
  }

  return result;
}

/** Shorten a file path for display (last 2 segments). */
function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
}
