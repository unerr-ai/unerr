/**
 * Sprint P2-5: Per-week aggregation + top-association ranking.
 *
 * Aggregates association records into weekly summaries showing:
 *   - Total associations detected
 *   - Breakdown by trigger type and family
 *   - Quality distribution (high/medium/low)
 *   - Top-ranked associations (highest leverage)
 *   - Driver percentage: "X% of tool calls were intelligence-driven"
 *
 * Used by the dashboard to show:
 *   "Your graph drove 23% of GitHub calls this week"
 */

import type {
  AssociationRecord,
  AssociationAggregate,
  RankedAssociation,
} from "./types.js";
import { qualityToNumeric } from "./quality.js";

/**
 * Aggregate association records for a given week.
 *
 * @param records - all records for the week
 * @param totalCallsInWeek - total tool calls in the same period (for driver %)
 */
export function aggregateWeek(
  records: readonly AssociationRecord[],
  totalCallsInWeek: number,
  weekStart: string,
  weekEnd: string,
): AssociationAggregate {
  const byTriggerType = new Map<string, number>();
  const byFamily = new Map<string, number>();
  let highQuality = 0;
  let mediumQuality = 0;
  let lowQuality = 0;

  const groupedAssociations = new Map<string, {
    triggerType: string;
    triggerDetail: string;
    family: string;
    count: number;
    qualities: number[];
  }>();

  for (const record of records) {
    const triggerType = record.triggerSignal.type;
    byTriggerType.set(triggerType, (byTriggerType.get(triggerType) ?? 0) + 1);
    byFamily.set(record.subsequentCall.family, (byFamily.get(record.subsequentCall.family) ?? 0) + 1);

    switch (record.outcomeQuality) {
      case "high": highQuality++; break;
      case "medium": mediumQuality++; break;
      case "low": lowQuality++; break;
    }

    const triggerDetail = record.triggerSignal.tag
      ?? record.triggerSignal.entityName
      ?? record.triggerSignal.filePath
      ?? record.triggerSignal.family
      ?? "unknown";

    const key = `${triggerType}:${triggerDetail}:${record.subsequentCall.family}`;
    const existing = groupedAssociations.get(key);
    if (existing) {
      existing.count++;
      existing.qualities.push(qualityToNumeric(record.outcomeQuality));
    } else {
      groupedAssociations.set(key, {
        triggerType,
        triggerDetail,
        family: record.subsequentCall.family,
        count: 1,
        qualities: [qualityToNumeric(record.outcomeQuality)],
      });
    }
  }

  const ranked: RankedAssociation[] = [...groupedAssociations.values()]
    .map((g) => ({
      triggerType: g.triggerType,
      triggerDetail: g.triggerDetail,
      family: g.family,
      count: g.count,
      avgQuality: g.qualities.reduce((a, b) => a + b, 0) / g.qualities.length,
    }))
    .sort((a, b) => {
      const scoreA = a.count * a.avgQuality;
      const scoreB = b.count * b.avgQuality;
      return scoreB - scoreA;
    })
    .slice(0, 10);

  const driverPercentage = totalCallsInWeek > 0
    ? records.length / totalCallsInWeek
    : 0;

  return {
    weekStart,
    weekEnd,
    totalAssociations: records.length,
    byTriggerType,
    byFamily,
    highQualityCount: highQuality,
    mediumQualityCount: mediumQuality,
    lowQualityCount: lowQuality,
    topAssociations: ranked,
    driverPercentage,
  };
}

/**
 * Compute week boundaries from a date.
 * Returns ISO strings for Monday 00:00:00 → Sunday 23:59:59.
 */
export function getWeekBounds(date: Date): { weekStart: string; weekEnd: string } {
  const d = new Date(date);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return {
    weekStart: monday.toISOString(),
    weekEnd: sunday.toISOString(),
  };
}

/**
 * Format the driver percentage as a human-readable string.
 * "Your graph drove 23% of GitHub calls this week"
 */
export function formatDriverSummary(aggregate: AssociationAggregate): string {
  const pct = Math.round(aggregate.driverPercentage * 100);
  const topFamily = aggregate.topAssociations[0]?.family ?? "tool";
  return `Your graph drove ${pct}% of ${topFamily} calls this week (${aggregate.totalAssociations} associations detected)`;
}
