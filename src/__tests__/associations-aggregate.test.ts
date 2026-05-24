import { describe, expect, it } from "vitest";

import {
  aggregateWeek,
  formatDriverSummary,
  getWeekBounds,
} from "../router/associations/aggregate.js";
import type {
  AssociationRecord,
  SubsequentCall,
  TriggerSignal,
} from "../router/associations/types.js";

function makeRecord(
  overrides: Partial<AssociationRecord> = {}
): AssociationRecord {
  return {
    id: `assoc_${Math.random().toString(36).slice(2)}`,
    ts: "2026-05-12T10:00:00.000Z",
    sessionId: "s1",
    triggerSignal: {
      type: "ur_tag",
      tag: "rsk",
      turnNumber: 0,
      timestamp: 1000,
    },
    subsequentCall: {
      toolName: "gh_search",
      family: "gh",
      turnNumber: 1,
      timestamp: 5000,
      outcome: "success",
      responseTokens: 300,
    },
    gapTurns: 1,
    gapMs: 4000,
    outcomeQuality: "medium",
    ...overrides,
  };
}

describe("aggregateWeek — basic aggregation", () => {
  it("counts total associations", () => {
    const records = [makeRecord(), makeRecord(), makeRecord()];
    const agg = aggregateWeek(records, 20, "2026-05-12", "2026-05-18");
    expect(agg.totalAssociations).toBe(3);
  });

  it("computes driver percentage (associations / total calls)", () => {
    const records = [makeRecord(), makeRecord(), makeRecord()];
    const agg = aggregateWeek(records, 12, "2026-05-12", "2026-05-18");
    expect(agg.driverPercentage).toBeCloseTo(3 / 12);
  });

  it("driver percentage is 0 when no calls", () => {
    const agg = aggregateWeek([makeRecord()], 0, "2026-05-12", "2026-05-18");
    expect(agg.driverPercentage).toBe(0);
  });

  it("empty records produce zero aggregate", () => {
    const agg = aggregateWeek([], 50, "2026-05-12", "2026-05-18");
    expect(agg.totalAssociations).toBe(0);
    expect(agg.highQualityCount).toBe(0);
    expect(agg.topAssociations).toHaveLength(0);
  });
});

describe("aggregateWeek — quality distribution", () => {
  it("counts quality levels correctly", () => {
    const records = [
      makeRecord({ outcomeQuality: "high" }),
      makeRecord({ outcomeQuality: "high" }),
      makeRecord({ outcomeQuality: "medium" }),
      makeRecord({ outcomeQuality: "low" }),
      makeRecord({ outcomeQuality: "low" }),
      makeRecord({ outcomeQuality: "low" }),
    ];
    const agg = aggregateWeek(records, 30, "2026-05-12", "2026-05-18");
    expect(agg.highQualityCount).toBe(2);
    expect(agg.mediumQualityCount).toBe(1);
    expect(agg.lowQualityCount).toBe(3);
  });
});

describe("aggregateWeek — breakdown by type and family", () => {
  it("groups by trigger type", () => {
    const records = [
      makeRecord({
        triggerSignal: {
          type: "ur_tag",
          tag: "rsk",
          turnNumber: 0,
          timestamp: 1000,
        },
      }),
      makeRecord({
        triggerSignal: {
          type: "ur_tag",
          tag: "hnt",
          turnNumber: 0,
          timestamp: 1000,
        },
      }),
      makeRecord({
        triggerSignal: {
          type: "family_nudge",
          family: "pg",
          turnNumber: 0,
          timestamp: 1000,
        },
      }),
    ];
    const agg = aggregateWeek(records, 20, "2026-05-12", "2026-05-18");
    expect(agg.byTriggerType.get("ur_tag")).toBe(2);
    expect(agg.byTriggerType.get("family_nudge")).toBe(1);
  });

  it("groups by family", () => {
    const records = [
      makeRecord({
        subsequentCall: {
          toolName: "gh_search",
          family: "gh",
          turnNumber: 1,
          timestamp: 5000,
          outcome: "success",
          responseTokens: 200,
        },
      }),
      makeRecord({
        subsequentCall: {
          toolName: "gh_list",
          family: "gh",
          turnNumber: 1,
          timestamp: 5000,
          outcome: "success",
          responseTokens: 200,
        },
      }),
      makeRecord({
        subsequentCall: {
          toolName: "pg_query",
          family: "pg",
          turnNumber: 1,
          timestamp: 5000,
          outcome: "success",
          responseTokens: 200,
        },
      }),
    ];
    const agg = aggregateWeek(records, 20, "2026-05-12", "2026-05-18");
    expect(agg.byFamily.get("gh")).toBe(2);
    expect(agg.byFamily.get("pg")).toBe(1);
  });
});

describe("aggregateWeek — top-association ranking", () => {
  it("ranks by count × quality", () => {
    const records = [
      makeRecord({
        triggerSignal: {
          type: "ur_tag",
          tag: "rsk",
          turnNumber: 0,
          timestamp: 1000,
        },
        outcomeQuality: "high",
      }),
      makeRecord({
        triggerSignal: {
          type: "ur_tag",
          tag: "rsk",
          turnNumber: 0,
          timestamp: 1000,
        },
        outcomeQuality: "high",
      }),
      makeRecord({
        triggerSignal: {
          type: "ur_tag",
          tag: "rsk",
          turnNumber: 0,
          timestamp: 1000,
        },
        outcomeQuality: "medium",
      }),
      makeRecord({
        triggerSignal: {
          type: "ur_tag",
          tag: "hnt",
          turnNumber: 0,
          timestamp: 1000,
        },
        outcomeQuality: "low",
      }),
    ];
    const agg = aggregateWeek(records, 20, "2026-05-12", "2026-05-18");
    expect(agg.topAssociations.length).toBeGreaterThan(0);
    expect(agg.topAssociations[0]!.triggerDetail).toBe("rsk");
    expect(agg.topAssociations[0]!.count).toBe(3);
  });

  it("limits to 10 entries", () => {
    const records: AssociationRecord[] = [];
    for (let i = 0; i < 15; i++) {
      records.push(
        makeRecord({
          triggerSignal: {
            type: "ur_tag",
            tag: `tag${i}`,
            turnNumber: 0,
            timestamp: 1000,
          },
          subsequentCall: {
            toolName: `tool_${i}`,
            family: `fam${i}`,
            turnNumber: 1,
            timestamp: 5000,
            outcome: "success",
            responseTokens: 200,
          },
        })
      );
    }
    const agg = aggregateWeek(records, 50, "2026-05-12", "2026-05-18");
    expect(agg.topAssociations.length).toBeLessThanOrEqual(10);
  });
});

describe("getWeekBounds", () => {
  it("returns Monday-Sunday for a Wednesday", () => {
    const wed = new Date("2026-05-13T15:00:00Z"); // Wednesday
    const { weekStart, weekEnd } = getWeekBounds(wed);
    const start = new Date(weekStart);
    const end = new Date(weekEnd);
    expect(start.getDay()).toBe(1); // Monday
    expect(end.getDay()).toBe(0); // Sunday
  });

  it("returns same week for Monday", () => {
    const mon = new Date("2026-05-11T10:00:00Z"); // Monday May 11
    const { weekStart } = getWeekBounds(mon);
    const start = new Date(weekStart);
    expect(start.getDay()).toBe(1); // Monday
  });

  it("returns correct week for Sunday", () => {
    const sun = new Date("2026-05-17T10:00:00Z"); // Sunday May 17
    const { weekStart, weekEnd } = getWeekBounds(sun);
    const start = new Date(weekStart);
    const end = new Date(weekEnd);
    expect(start.getDay()).toBe(1); // Monday
    expect(end.getDay()).toBe(0); // Sunday
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});

describe("formatDriverSummary", () => {
  it("formats with percentage and family", () => {
    const agg = aggregateWeek(
      [
        makeRecord({ outcomeQuality: "high" }),
        makeRecord({ outcomeQuality: "high" }),
        makeRecord({ outcomeQuality: "medium" }),
      ],
      13,
      "2026-05-12",
      "2026-05-18"
    );
    const summary = formatDriverSummary(agg);
    expect(summary).toContain("23%");
    expect(summary).toContain("gh");
    expect(summary).toContain("3 associations");
  });

  it("handles zero associations gracefully", () => {
    const agg = aggregateWeek([], 0, "2026-05-12", "2026-05-18");
    const summary = formatDriverSummary(agg);
    expect(summary).toContain("0%");
    expect(summary).toContain("0 associations");
  });
});

describe("Verification gate: weekly rollup with known input", () => {
  it("full week aggregation produces correct metrics", () => {
    const records: AssociationRecord[] = [];

    for (let i = 0; i < 10; i++) {
      records.push(
        makeRecord({
          triggerSignal: {
            type: "ur_tag",
            tag: "rsk",
            entityName: "User.ts",
            family: "gh",
            turnNumber: i * 2,
            timestamp: i * 5000,
          },
          subsequentCall: {
            toolName: "gh_search",
            family: "gh",
            turnNumber: i * 2 + 1,
            timestamp: i * 5000 + 3000,
            outcome: "success",
            responseTokens: 400,
          },
          outcomeQuality: i < 7 ? "high" : "medium",
        })
      );
    }

    for (let i = 0; i < 5; i++) {
      records.push(
        makeRecord({
          triggerSignal: {
            type: "family_nudge",
            family: "pg",
            turnNumber: i * 3,
            timestamp: 50000 + i * 5000,
          },
          subsequentCall: {
            toolName: "pg_query",
            family: "pg",
            turnNumber: i * 3 + 1,
            timestamp: 50000 + i * 5000 + 2000,
            outcome: "success",
            responseTokens: 200,
          },
          outcomeQuality: "medium",
        })
      );
    }

    const agg = aggregateWeek(records, 60, "2026-05-12", "2026-05-18");

    expect(agg.totalAssociations).toBe(15);
    expect(agg.highQualityCount).toBe(7);
    expect(agg.mediumQualityCount).toBe(8);
    expect(agg.driverPercentage).toBeCloseTo(15 / 60);
    expect(agg.byFamily.get("gh")).toBe(10);
    expect(agg.byFamily.get("pg")).toBe(5);
    expect(agg.byTriggerType.get("ur_tag")).toBe(10);
    expect(agg.byTriggerType.get("family_nudge")).toBe(5);
    expect(agg.topAssociations[0]!.family).toBe("gh");
    expect(agg.topAssociations[0]!.count).toBe(10);
  });
});
