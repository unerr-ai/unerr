/**
 * Negative Knowledge — learns from rewinds and reverts.
 *
 * When a rewind occurs (detected from shadow ledger), analyzes what went wrong:
 *   - Entity modified then reverted → the modification pattern is an anti-pattern
 *   - Stores entity key + error description as a correction entry
 *
 * Corrections feed into convention enforcement (H.4) and session context (C.2).
 * No LLM required — pure heuristic analysis from ledger + diff data.
 *
 * Temporal intelligence note: corrections are procedural memory (Section 13.2)
 * with near-permanent decay — only overwritten by demonstrated evolution.
 */

interface LedgerEntryLike {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
}

export interface CorrectionEntry {
  id: string;
  entityKey: string;
  pattern: string;
  reason: string;
  detectedAt: string;
  rewindEntryId: string;
  confidence: number;
}

/**
 * Detect anti-patterns from a rewind event in the ledger.
 *
 * Scans entries before the rewind to find what was modified,
 * then generates correction entries for the reverted changes.
 */
export function detectAntiPatterns(
  entries: LedgerEntryLike[],
  rewindEntryId: string
): CorrectionEntry[] {
  const rewindIdx = entries.findIndex((e) => e.id === rewindEntryId);
  if (rewindIdx < 0) return [];

  const rewindEntry = entries[rewindIdx]!;
  const rewindResult = rewindEntry.result_summary as Record<string, unknown>;
  const targetId = rewindResult.rewind_target_id as string | undefined;

  if (!targetId) return [];

  const targetIdx = entries.findIndex((e) => e.id === targetId);
  if (targetIdx < 0) return [];

  const revertedEntries = entries.slice(targetIdx + 1, rewindIdx);

  const corrections: CorrectionEntry[] = [];
  const seenEntities = new Set<string>();

  for (const entry of revertedEntries) {
    if (entry.tool !== "sync_local_diff") continue;

    const files = extractFiles(entry.args_summary);
    for (const file of files) {
      if (seenEntities.has(file)) continue;
      seenEntities.add(file);

      corrections.push({
        id: `correction-${rewindEntryId}-${corrections.length}`,
        entityKey: file,
        pattern: "modified-then-reverted",
        reason: `File ${file} was modified and subsequently reverted. The modification approach was incorrect.`,
        detectedAt: new Date().toISOString(),
        rewindEntryId,
        confidence: 0.7,
      });
    }
  }

  return corrections;
}

/**
 * Detect repeated modification patterns that indicate instability.
 * Entity modified 3+ times in rapid succession → likely anti-pattern.
 */
export function detectInstableEntities(
  entries: LedgerEntryLike[],
  windowMs = 10 * 60 * 1000
): CorrectionEntry[] {
  const entityTimestamps = new Map<string, number[]>();

  for (const entry of entries) {
    if (entry.tool !== "sync_local_diff") continue;
    const files = extractFiles(entry.args_summary);
    const ts = new Date(entry.ts).getTime();

    for (const file of files) {
      const timestamps = entityTimestamps.get(file) ?? [];
      timestamps.push(ts);
      entityTimestamps.set(file, timestamps);
    }
  }

  const corrections: CorrectionEntry[] = [];

  for (const [entityKey, timestamps] of entityTimestamps) {
    if (timestamps.length < 3) continue;

    timestamps.sort((a, b) => a - b);
    for (let i = 2; i < timestamps.length; i++) {
      const window = timestamps[i]! - timestamps[i - 2]!;
      if (window < windowMs) {
        corrections.push({
          id: `instability-${entityKey}-${i}`,
          entityKey,
          pattern: "rapid-modification",
          reason: `${entityKey} was modified ${timestamps.length} times in rapid succession, suggesting instability.`,
          detectedAt: new Date().toISOString(),
          rewindEntryId: "",
          confidence: 0.5 + Math.min(0.4, timestamps.length * 0.05),
        });
        break;
      }
    }
  }

  return corrections;
}

function extractFiles(args: Record<string, unknown>): string[] {
  const files = args.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) =>
      typeof f === "string" ? f : ((f as { path?: string })?.path ?? "")
    )
    .filter(Boolean);
}
