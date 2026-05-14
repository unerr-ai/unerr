/**
 * Durability Tracker — tracks AI modifications and their survival time.
 *
 * U.7: Records when AI modifies an entity and whether it survives 24h.
 * U.8: Computes durability score = survived / total modifications.
 *
 * A modification "survives" if the entity's body_hash is unchanged 24h later.
 * Entities with low durability (<0.5) trigger warnings surfaced as `ur|wrn` prefix lines.
 */

export interface ModificationRecord {
  entityKey: string;
  modifiedAt: number;
  sessionId: string;
  bodyHashAtModification: string;
  survived: boolean | null;
  evaluatedAt: number | null;
}

export interface DurabilityResult {
  entityKey: string;
  score: number;
  totalModifications: number;
  survived: number;
  reverted: number;
  pending: number;
  lastModified: number;
}

const SURVIVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DurabilityTracker {
  recordModification: (
    entityKey: string,
    sessionId: string,
    bodyHash: string,
  ) => void;
  evaluateSurvival: (entityKey: string, currentBodyHash: string) => void;
  getScore: (entityKey: string) => DurabilityResult | null;
  getLowDurabilityEntities: (threshold?: number) => DurabilityResult[];
  getAllScores: () => Map<string, DurabilityResult>;
}

export function createDurabilityTracker(): DurabilityTracker {
  const records = new Map<string, ModificationRecord[]>();

  function recordModification(
    entityKey: string,
    sessionId: string,
    bodyHash: string,
  ): void {
    if (!records.has(entityKey)) records.set(entityKey, []);
    records.get(entityKey)!.push({
      entityKey,
      modifiedAt: Date.now(),
      sessionId,
      bodyHashAtModification: bodyHash,
      survived: null,
      evaluatedAt: null,
    });
  }

  function evaluateSurvival(entityKey: string, currentBodyHash: string): void {
    const mods = records.get(entityKey);
    if (!mods) return;

    const now = Date.now();
    for (const mod of mods) {
      if (mod.survived !== null) continue;
      if (now - mod.modifiedAt < SURVIVAL_WINDOW_MS) continue;

      mod.survived = mod.bodyHashAtModification === currentBodyHash;
      mod.evaluatedAt = now;
    }
  }

  function getScore(entityKey: string): DurabilityResult | null {
    const mods = records.get(entityKey);
    if (!mods || mods.length === 0) return null;

    let survived = 0;
    let reverted = 0;
    let pending = 0;

    for (const mod of mods) {
      if (mod.survived === null) pending++;
      else if (mod.survived) survived++;
      else reverted++;
    }

    const evaluated = survived + reverted;
    const score = evaluated > 0 ? survived / evaluated : 0.5;

    return {
      entityKey,
      score: Math.round(score * 100) / 100,
      totalModifications: mods.length,
      survived,
      reverted,
      pending,
      lastModified: mods[mods.length - 1]!.modifiedAt,
    };
  }

  function getLowDurabilityEntities(threshold = 0.5): DurabilityResult[] {
    const results: DurabilityResult[] = [];
    for (const entityKey of records.keys()) {
      const result = getScore(entityKey);
      if (
        result &&
        result.score < threshold &&
        result.totalModifications >= 2
      ) {
        results.push(result);
      }
    }
    return results.sort((a, b) => a.score - b.score);
  }

  function getAllScores(): Map<string, DurabilityResult> {
    const scores = new Map<string, DurabilityResult>();
    for (const entityKey of records.keys()) {
      const result = getScore(entityKey);
      if (result) scores.set(entityKey, result);
    }
    return scores;
  }

  return {
    recordModification,
    evaluateSurvival,
    getScore,
    getLowDurabilityEntities,
    getAllScores,
  };
}
