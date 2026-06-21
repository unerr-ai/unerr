/**
 * Layer 3 Sprint T: Token Accounting & Visibility tests.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskCostSummaries } from "../proxy/task-token-display.js";
import {
  type SessionHistoryEntry,
  aggregateStats,
  appendSessionHistory,
  getWeeklyStats,
  readSessionHistory,
} from "../tracking/session-history.js";

let tempRoot: string;
let tempDir: string;
beforeEach(() => {
  // Nest the unerr dir as <uniqueParent>/.unerr so MetricsStore's
  // repoRoot = dirname(unerrDir) is unique per test. A bare temp dir would
  // collapse repoRoot to the shared os.tmpdir(), letting "fresh dir" /
  // "missing history" tests read session rows written by sibling tests.
  tempRoot = mkdtempSync(join(tmpdir(), "unerr-t-"));
  tempDir = join(tempRoot, ".unerr");
  mkdirSync(tempDir, { recursive: true });
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Session History (T.8)", () => {
  it("appends and reads session entries", () => {
    const entry: SessionHistoryEntry = {
      sessionId: "s1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 60000,
      toolCalls: 47,
      tokensSaved: 23400,
      tokensProcessed: 35000,
      efficiency: 67,
      modelId: "claude-sonnet-4-20250514",
      entityCount: 847,
    };

    appendSessionHistory(tempDir, entry);
    const history = readSessionHistory(tempDir);
    expect(history).toHaveLength(1);
    expect(history[0]?.sessionId).toBe("s1");
    expect(history[0]?.tokensSaved).toBe(23400);
  });

  it("handles missing history file", () => {
    expect(readSessionHistory(tempDir)).toHaveLength(0);
  });

  it("aggregates stats correctly", () => {
    const entries: SessionHistoryEntry[] = [
      {
        sessionId: "s1",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 60000,
        toolCalls: 40,
        tokensSaved: 20000,
        tokensProcessed: 30000,
        efficiency: 67,
        modelId: "claude-sonnet-4-20250514",
        entityCount: 500,
      },
      {
        sessionId: "s2",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 120000,
        toolCalls: 80,
        tokensSaved: 40000,
        tokensProcessed: 60000,
        efficiency: 67,
        modelId: "claude-sonnet-4-20250514",
        entityCount: 500,
      },
    ];

    const stats = aggregateStats(entries, "Test");
    expect(stats.sessions).toBe(2);
    expect(stats.tokensSaved).toBe(60000);
    expect(stats.totalToolCalls).toBe(120);
    expect(stats.avgEfficiency).toBe(67);
  });

  it("getWeeklyStats returns empty for fresh dir", () => {
    const stats = getWeeklyStats(tempDir);
    expect(stats.sessions).toBe(0);
  });
});

describe("Task Token Display (T.12)", () => {
  it("builds task cost summaries from intent groups", () => {
    const groups = [
      {
        intentId: "i1",
        prompt: "Add currency param",
        toolCalls: 12,
        tokensConsumed: 5000,
        tokensSaved: 12000,
        entitiesModified: ["processPayment"],
        outcome: "completed",
      },
      {
        intentId: "i2",
        prompt: "Fix auth tests",
        toolCalls: 8,
        tokensConsumed: 3000,
        tokensSaved: 6000,
        entitiesModified: ["authService"],
        outcome: "completed",
      },
      {
        intentId: "i3",
        prompt: "Update README",
        toolCalls: 3,
        tokensConsumed: 800,
        tokensSaved: 400,
        entitiesModified: [],
        outcome: "completed",
      },
    ];

    const result = buildTaskCostSummaries(groups);
    expect(result.tasks).toHaveLength(3);
    expect(result.totalCalls).toBe(23);
    expect(result.formattedLines.length).toBeGreaterThan(0);
    expect(result.formattedLines[0]).toContain("Tasks this session");
  });

  it("sorts by most expensive first", () => {
    const groups = [
      {
        intentId: "i1",
        prompt: "Cheap",
        toolCalls: 2,
        tokensConsumed: 100,
        tokensSaved: 50,
        entitiesModified: [],
        outcome: "completed",
      },
      {
        intentId: "i2",
        prompt: "Expensive",
        toolCalls: 20,
        tokensConsumed: 50000,
        tokensSaved: 30000,
        entitiesModified: [],
        outcome: "completed",
      },
    ];

    const result = buildTaskCostSummaries(groups);
    expect(result.tasks[0]?.taskDescription).toBe("Expensive");
  });

  it("computes efficiency correctly", () => {
    const groups = [
      {
        intentId: "i1",
        prompt: "Task",
        toolCalls: 5,
        tokensConsumed: 3000,
        tokensSaved: 7000,
        entitiesModified: [],
        outcome: "completed",
      },
    ];

    const result = buildTaskCostSummaries(groups);
    expect(result.tasks[0]?.efficiency).toBe(70);
  });

  it("handles empty groups", () => {
    const result = buildTaskCostSummaries([]);
    expect(result.tasks).toHaveLength(0);
    expect(result.totalCalls).toBe(0);
  });
});
