/**
 * Compound Intelligence Counter — tracks accumulated knowledge.
 *
 * VS.7: Displays in status + weekly: entity count, edge count,
 * conventions learned, rules generated, corrections applied.
 */

export interface IntelligenceMetrics {
  entityCount: number;
  edgeCount: number;
  conventionsLearned: number;
  rulesGenerated: number;
  correctionsApplied: number;
  communitiesDetected: number;
  sessionsIndexed: number;
}

export interface IntelligenceCounter {
  record: (field: keyof IntelligenceMetrics, value: number) => void;
  increment: (field: keyof IntelligenceMetrics) => void;
  getMetrics: () => IntelligenceMetrics;
  formatSummary: () => string;
  reset: () => void;
}

export function createIntelligenceCounter(): IntelligenceCounter {
  const metrics: IntelligenceMetrics = {
    entityCount: 0,
    edgeCount: 0,
    conventionsLearned: 0,
    rulesGenerated: 0,
    correctionsApplied: 0,
    communitiesDetected: 0,
    sessionsIndexed: 0,
  };

  function record(field: keyof IntelligenceMetrics, value: number): void {
    metrics[field] = value;
  }

  function increment(field: keyof IntelligenceMetrics): void {
    metrics[field]++;
  }

  function getMetrics(): IntelligenceMetrics {
    return { ...metrics };
  }

  function formatSummary(): string {
    const parts = [
      `${metrics.entityCount.toLocaleString()} entities`,
      `${metrics.edgeCount.toLocaleString()} edges`,
      `${metrics.communitiesDetected} communities`,
    ];
    if (metrics.conventionsLearned > 0)
      parts.push(`${metrics.conventionsLearned} conventions`);
    if (metrics.rulesGenerated > 0)
      parts.push(`${metrics.rulesGenerated} rules`);
    if (metrics.correctionsApplied > 0)
      parts.push(`${metrics.correctionsApplied} corrections`);
    return `Intelligence: ${parts.join(", ")}`;
  }

  function reset(): void {
    for (const k of Object.keys(metrics) as Array<keyof IntelligenceMetrics>) {
      metrics[k] = 0;
    }
  }

  return { record, increment, getMetrics, formatSummary, reset };
}
