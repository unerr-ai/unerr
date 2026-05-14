/**
 * Code Durability Scoring — per-entity survival metric (0.0–1.0).
 *
 * Reads shadow ledger history to compute how long an entity survives
 * between modifications. Higher durability = more stable code.
 *
 *   durability = time_survived / total_observation_window
 *
 * Computed on-demand from ledger (not stored permanently). Cached
 * in memory for the session.
 *
 * Temporal intelligence note: durability feeds into the relevance
 * scoring engine (Section 13.3). High-durability entities get
 * structural importance boost; low-durability entities surface
 * as instability warnings.
 */

interface LedgerEntryLike {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
}

export interface DurabilityScore {
  entityKey: string;
  score: number;
  modificationCount: number;
  totalObservationMs: number;
  avgSurvivalMs: number;
  lastModified: string;
}

export interface DurabilityScorer {
  computeScores: (entries: LedgerEntryLike[]) => Map<string, DurabilityScore>;
  getScore: (entityKey: string) => DurabilityScore | null;
  getTopUnstable: (limit?: number) => DurabilityScore[];
  getTopDurable: (limit?: number) => DurabilityScore[];
}

export function createDurabilityScorer(): DurabilityScorer {
  const cache = new Map<string, DurabilityScore>();

  function computeScores(
    entries: LedgerEntryLike[],
  ): Map<string, DurabilityScore> {
    cache.clear();

    const entityTimeline = new Map<string, number[]>();

    for (const entry of entries) {
      if (entry.tool !== "sync_local_diff") continue;
      const files = extractFiles(entry.args_summary);
      const ts = new Date(entry.ts).getTime();

      for (const file of files) {
        const timeline = entityTimeline.get(file) ?? [];
        timeline.push(ts);
        entityTimeline.set(file, timeline);
      }
    }

    if (entries.length === 0) return cache;

    const firstTs = new Date(entries[0]!.ts).getTime();
    const lastTs = new Date(entries[entries.length - 1]!.ts).getTime();
    const totalWindow = Math.max(lastTs - firstTs, 1);

    for (const [entityKey, timestamps] of entityTimeline) {
      timestamps.sort((a, b) => a - b);

      const modCount = timestamps.length;
      const lastModified = new Date(
        timestamps[timestamps.length - 1]!,
      ).toISOString();

      let totalSurvival = 0;
      for (let i = 1; i < timestamps.length; i++) {
        totalSurvival += timestamps[i]! - timestamps[i - 1]!;
      }

      const timeSinceLastMod = lastTs - timestamps[timestamps.length - 1]!;
      totalSurvival += timeSinceLastMod;

      const avgSurvival = modCount > 0 ? totalSurvival / modCount : totalWindow;
      const score = Math.min(1.0, avgSurvival / Math.max(totalWindow, 1));

      const durability: DurabilityScore = {
        entityKey,
        score: Math.round(score * 100) / 100,
        modificationCount: modCount,
        totalObservationMs: totalWindow,
        avgSurvivalMs: Math.round(avgSurvival),
        lastModified,
      };

      cache.set(entityKey, durability);
    }

    return cache;
  }

  function getScore(entityKey: string): DurabilityScore | null {
    return cache.get(entityKey) ?? null;
  }

  function getTopUnstable(limit = 10): DurabilityScore[] {
    return [...cache.values()]
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);
  }

  function getTopDurable(limit = 10): DurabilityScore[] {
    return [...cache.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return { computeScores, getScore, getTopUnstable, getTopDurable };
}

function extractFiles(args: Record<string, unknown>): string[] {
  const files = args.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) =>
      typeof f === "string" ? f : ((f as { path?: string })?.path ?? ""),
    )
    .filter(Boolean);
}
