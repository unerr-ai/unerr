/**
 * Correction Detector — learns error→fix patterns from the shadow ledger.
 *
 * Adapted from rtk's `learn/detector.rs` 6-phase pipeline, re-targeted at
 * unerr's JSONL shadow ledger (LedgerEntry) instead of CLI command logs.
 *
 * Pipeline:
 *   Phase 1: Read & parse shadow ledger entries (last N days)
 *   Phase 2: Group by session, sort chronologically
 *   Phase 3: Detect error signals (entity queried → edited → re-queried within window)
 *   Phase 4: Find correction pairs (fix attempt within max_correction_distance)
 *   Phase 5: Score confidence + filter false positives
 *   Phase 6: Deduplicate by (entity_key, error_type), sum occurrences
 *
 * Constraints:
 *   - Never runs during MCP request handling (SC-5)
 *   - Triggered by `unerr learn` or proxy shutdown
 *   - <500ms for 10K ledger entries
 *
 * Leapfrog Sprint B, Task B.1
 */

import { existsSync, readFileSync } from "node:fs";
import type { LedgerEntry } from "./shadow-ledger.js";

export type ErrorType =
  | "type_error"
  | "import_error"
  | "missing_field"
  | "wrong_argument"
  | "test_failure"
  | "runtime_error";

export interface CorrectionPattern {
  entity_key: string;
  error_type: ErrorType;
  correction_summary: string;
  confidence: number;
  occurrences: number;
  last_seen: string;
  example_session_id?: string;
}

export interface CorrectionDetectorOptions {
  min_confidence?: number;
  correction_window_ms?: number;
  max_correction_distance?: number;
  since_days?: number;
}

interface ErrorSignal {
  entity_key: string;
  error_type: ErrorType;
  timestamp: number;
  session_id: string;
  index: number;
  args_keys: string[];
}

interface CorrectionPair {
  entity_key: string;
  error_type: ErrorType;
  error_timestamp: number;
  fix_timestamp: number;
  fix_succeeded: boolean;
  session_id: string;
  similarity: number;
  error_args_keys: string[];
  fix_args_keys: string[];
}

const ENTITY_TOOLS = new Set([
  "get_function",
  "get_class",
  "get_file",
  "get_callers",
  "get_callees",
  "get_imports",
  "get_business_context",
]);

const TEST_TOOLS = new Set(["bash"]);
const EDIT_INDICATORS = new Set(["sync_local_diff"]);

/**
 * Detect correction patterns from the shadow ledger.
 *
 * Reads the JSONL ledger file, groups entries by session, and identifies
 * error→fix sequences where an entity was queried, modified, then re-queried
 * (indicating the first modification failed).
 */
export function detectCorrections(
  ledgerPath: string,
  options?: CorrectionDetectorOptions
): CorrectionPattern[] {
  const MIN_CONFIDENCE = options?.min_confidence ?? 0.6;
  const CORRECTION_WINDOW = options?.correction_window_ms ?? 60_000;
  const MAX_DISTANCE = options?.max_correction_distance ?? 3;
  const SINCE_DAYS = options?.since_days ?? 7;

  // Phase 1: Read and parse shadow ledger entries
  const entries = readLedgerEntries(ledgerPath, SINCE_DAYS);
  if (entries.length === 0) return [];

  // Phase 2: Group by session, sort chronologically
  const sessions = groupBySession(entries);

  // Phase 3 + 4: Detect error signals and find correction pairs
  const pairs: CorrectionPair[] = [];
  for (const sessionEntries of sessions.values()) {
    const sessionPairs = findCorrectionPairs(
      sessionEntries,
      CORRECTION_WINDOW,
      MAX_DISTANCE
    );
    pairs.push(...sessionPairs);
  }

  if (pairs.length === 0) return [];

  // Phase 5: Score confidence + filter false positives
  const scored = pairs
    .map((pair) => scoreAndClassify(pair))
    .filter((p) => p !== null)
    .filter((p) => p.confidence >= MIN_CONFIDENCE);

  // Phase 6: Deduplicate by (entity_key, error_type), sum occurrences
  return deduplicatePatterns(scored);
}

/**
 * Read JSONL ledger entries from disk, filtered to the last N days.
 */
function readLedgerEntries(
  ledgerPath: string,
  sinceDays: number
): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];

  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const entries: LedgerEntry[] = [];

  try {
    const content = readFileSync(ledgerPath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (new Date(entry.ts).getTime() >= cutoff) {
          entries.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    return [];
  }

  return entries;
}

/**
 * Group entries by session_id, each group sorted chronologically.
 */
function groupBySession(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const sessions = new Map<string, LedgerEntry[]>();

  for (const entry of entries) {
    const sid = entry.session_id;
    let group = sessions.get(sid);
    if (!group) {
      group = [];
      sessions.set(sid, group);
    }
    group.push(entry);
  }

  for (const group of sessions.values()) {
    group.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }

  return sessions;
}

/**
 * Extract the entity key from a tool call's arguments.
 * Returns null if the tool doesn't target a specific entity.
 */
function extractEntityKey(entry: LedgerEntry): string | null {
  const args = entry.args_summary;
  if (typeof args.key === "string") return args.key;
  if (typeof args.name === "string") return args.name;
  if (typeof args.entity_key === "string") return args.entity_key;
  if (typeof args.file_path === "string") return args.file_path;
  return null;
}

/**
 * Classify error type from tool result content.
 */
function classifyError(entry: LedgerEntry): ErrorType | null {
  const result = JSON.stringify(entry.result_summary).toLowerCase();
  const tool = entry.tool;

  if (result.includes("typeerror") || result.includes("type error"))
    return "type_error";
  if (
    result.includes("cannot find module") ||
    result.includes("cannot resolve") ||
    result.includes("import error")
  )
    return "import_error";
  if (
    (result.includes("property") && result.includes("does not exist")) ||
    result.includes("missing field") ||
    result.includes("is not defined")
  )
    return "missing_field";
  if (
    (result.includes("expected") && result.includes("argument")) ||
    result.includes("wrong number of arg")
  )
    return "wrong_argument";
  if (
    (tool === "bash" || TEST_TOOLS.has(tool)) &&
    (result.includes("fail") ||
      result.includes("error") ||
      result.includes("assert"))
  )
    return "test_failure";
  if (result.includes("runtime") || result.includes("exception"))
    return "runtime_error";
  return null;
}

/**
 * Find correction pairs within a single session's entries.
 *
 * Pattern: entity X queried → edit → re-query of entity X within window
 * (the re-query signals the first edit failed; the subsequent edit is the fix)
 */
function findCorrectionPairs(
  entries: LedgerEntry[],
  correctionWindowMs: number,
  maxDistance: number
): CorrectionPair[] {
  const pairs: CorrectionPair[] = [];
  const len = entries.length;

  for (let i = 0; i < len; i++) {
    const queryEntry = entries[i] as LedgerEntry;

    // Only consider entity-targeting query tools
    if (!ENTITY_TOOLS.has(queryEntry.tool)) continue;
    const entityKey = extractEntityKey(queryEntry);
    if (!entityKey) continue;

    const queryTs = new Date(queryEntry.ts).getTime();
    const queryArgsKeys = Object.keys(queryEntry.args_summary);

    // Look for: edit → re-query of same entity within window
    let sawEdit = false;
    for (let j = i + 1; j < Math.min(i + maxDistance + 2, len); j++) {
      const next = entries[j] as LedgerEntry;
      const nextTs = new Date(next.ts).getTime();

      // Outside correction window — stop searching
      if (nextTs - queryTs > correctionWindowMs) break;

      // An edit operation (sync_local_diff)
      if (EDIT_INDICATORS.has(next.tool)) {
        sawEdit = true;
        continue;
      }

      // Re-query of the SAME entity after an edit → error signal
      if (sawEdit && ENTITY_TOOLS.has(next.tool)) {
        const reQueryKey = extractEntityKey(next);
        if (reQueryKey === entityKey) {
          // Found error signal. Now look for the fix: another edit within distance.
          let fixSucceeded = true;
          const fixArgsKeys = Object.keys(next.args_summary);
          let fixTimestamp = nextTs;

          // Check if there's a subsequent re-query (indicating fix also failed)
          for (let k = j + 1; k < Math.min(j + maxDistance + 1, len); k++) {
            const afterFix = entries[k] as LedgerEntry;
            const afterFixTs = new Date(afterFix.ts).getTime();
            if (afterFixTs - nextTs > 5 * 60 * 1000) break; // 5-min window

            const afterKey = extractEntityKey(afterFix);
            if (afterKey === entityKey && ENTITY_TOOLS.has(afterFix.tool)) {
              fixSucceeded = false;
              break;
            }
            if (EDIT_INDICATORS.has(afterFix.tool)) {
              fixTimestamp = afterFixTs;
            }
          }

          // Check for error type from the re-query's result
          const errorType = classifyError(next) ?? classifyError(queryEntry);

          if (errorType) {
            pairs.push({
              entity_key: entityKey,
              error_type: errorType,
              error_timestamp: queryTs,
              fix_timestamp: fixTimestamp,
              fix_succeeded: fixSucceeded,
              session_id: queryEntry.session_id,
              similarity: argumentSimilarity(queryArgsKeys, fixArgsKeys),
              error_args_keys: queryArgsKeys,
              fix_args_keys: fixArgsKeys,
            });
          }

          // Don't double-count: skip ahead past this pair
          break;
        }
      }
    }
  }

  return pairs;
}

/**
 * Jaccard similarity between two sets of argument keys.
 * Returns 0.5 + 0.5 * (|intersection| / |union|)
 */
function argumentSimilarity(keysA: string[], keysB: string[]): number {
  const setA = new Set(keysA);
  const setB = new Set(keysB);
  const intersection = [...setA].filter((k) => setB.has(k)).length;
  const union = new Set([...setA, ...setB]).size;
  if (union === 0) return 0.5;
  return 0.5 + 0.5 * (intersection / union);
}

/**
 * Score a correction pair's confidence and classify it.
 * Returns null if it's a false positive.
 *
 * Note: path exploration filtering (Jaccard > 0.9) does NOT apply here because
 * findCorrectionPairs already requires sawEdit=true — there was a code edit between
 * the initial query and the re-query. High similarity after an edit is a genuine
 * correction pattern, not browsing.
 */
function scoreAndClassify(pair: CorrectionPair): CorrectionPattern | null {
  // Build confidence score
  let confidence = 0.5; // base: same entity queried + edited + re-queried
  if (pair.fix_succeeded) confidence += 0.2;
  confidence += (pair.similarity - 0.5) * 0.6; // 0.0-0.3 range from similarity

  confidence = Math.round(confidence * 100) / 100;

  const summary = buildCorrectionSummary(pair.entity_key, pair.error_type);

  return {
    entity_key: pair.entity_key,
    error_type: pair.error_type,
    correction_summary: summary,
    confidence,
    occurrences: 1,
    last_seen: new Date(pair.fix_timestamp).toISOString(),
    example_session_id: pair.session_id,
  };
}

/**
 * Build a human-readable correction summary.
 */
function buildCorrectionSummary(
  entityKey: string,
  errorType: ErrorType
): string {
  const name = entityKey.split("/").pop()?.split(":").pop() ?? entityKey;

  switch (errorType) {
    case "type_error":
      return `Agents frequently encounter type errors when modifying ${name} — check return types and null handling`;
    case "import_error":
      return `Import/module resolution issues when editing ${name} — verify import paths and module exports`;
    case "missing_field":
      return `Missing field/property errors on ${name} — check required fields and interface contracts`;
    case "wrong_argument":
      return `Wrong argument errors when calling ${name} — verify function signature and parameter types`;
    case "test_failure":
      return `Tests frequently fail after modifying ${name} — run tests before committing changes`;
    case "runtime_error":
      return `Runtime errors associated with ${name} — check error handling and edge cases`;
  }
}

/**
 * Deduplicate patterns by (entity_key, error_type).
 * Keeps highest confidence, sums occurrences, uses latest timestamp.
 */
function deduplicatePatterns(
  patterns: CorrectionPattern[]
): CorrectionPattern[] {
  const grouped = new Map<string, CorrectionPattern>();

  for (const p of patterns) {
    const key = `${p.entity_key}::${p.error_type}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...p });
    } else {
      existing.occurrences += p.occurrences;
      if (p.confidence > existing.confidence) {
        existing.confidence = p.confidence;
        existing.correction_summary = p.correction_summary;
        existing.example_session_id = p.example_session_id;
      }
      if (p.last_seen > existing.last_seen) {
        existing.last_seen = p.last_seen;
      }
    }
  }

  return [...grouped.values()].sort((a, b) => b.confidence - a.confidence);
}
