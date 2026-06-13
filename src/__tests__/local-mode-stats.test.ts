/**
 * Sprint L4 Tests: Statistical Proof Engine — LocalModeStats, shutdown summary, cumulative stats.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CumulativeLocalStats,
  type LocalModeStats,
  type SessionStats,
  createLocalModeStats,
  createSessionStats,
  formatLocalModeSessionStats,
  formatSessionStats,
  loadCumulativeLocalStats,
  persistCumulativeLocalStats,
  recordBlastRadius,
  recordCommunityContext,
  recordCorrectionInjection,
  recordGraphQuery,
  recordIndexingResult,
  recordLatency,
  recordToolCall,
  recordTruncationSavings,
  recordViolation,
  snapshotFirewallCount,
} from "../proxy/session-stats.js";

// ── LocalModeStats Creation ─────────────────────────────────────

describe("createLocalModeStats", () => {
  it("initializes all counters to zero", () => {
    const lm = createLocalModeStats();
    expect(lm.filesIndexed).toBe(0);
    expect(lm.entitiesExtracted).toBe(0);
    expect(lm.edgesComputed).toBe(0);
    expect(lm.indexingTimeMs).toBe(0);
    expect(lm.communitiesDetected).toBe(0);
    expect(lm.tokensSavedByTruncation).toBe(0);
    expect(lm.truncatedResponses).toBe(0);
    expect(lm.correctionPatternsInjected).toBe(0);
    expect(lm.communityContextsInjected).toBe(0);
    expect(lm.blastRadiusComputations).toBe(0);
    expect(lm.firewallBlockedCount).toBe(0);
    expect(lm.graphQueriesByType).toEqual({});
  });
});

// ── SessionStats with Local Mode ────────────────────────────────

describe("createSessionStats with isLocalMode", () => {
  it("creates localMode=null for standard mode", () => {
    const stats = createSessionStats(false);
    expect(stats.localMode).toBeNull();
  });

  it("creates localMode stats for local mode", () => {
    const stats = createSessionStats(true);
    expect(stats.localMode).not.toBeNull();
    expect(stats.localMode?.filesIndexed).toBe(0);
  });
});

// ── Recording Functions ─────────────────────────────────────────

describe("LocalModeStats recording functions", () => {
  let lm: LocalModeStats;

  beforeEach(() => {
    lm = createLocalModeStats();
  });

  it("recordGraphQuery tracks per-tool counts", () => {
    recordGraphQuery(lm, "get_function");
    recordGraphQuery(lm, "get_function");
    recordGraphQuery(lm, "search_code");
    recordGraphQuery(lm, "get_callers");

    expect(lm.graphQueriesByType.get_function).toBe(2);
    expect(lm.graphQueriesByType.search_code).toBe(1);
    expect(lm.graphQueriesByType.get_callers).toBe(1);
  });

  it("recordTruncationSavings accumulates token savings", () => {
    recordTruncationSavings(lm, 10000, 3000); // saved 7000
    recordTruncationSavings(lm, 5000, 2000); // saved 3000
    recordTruncationSavings(lm, 1000, 1500); // no savings (used > full)

    expect(lm.tokensSavedByTruncation).toBe(10000);
    expect(lm.truncatedResponses).toBe(2);
  });

  it("recordIndexingResult sets all indexing fields", () => {
    recordIndexingResult(lm, {
      fileCount: 500,
      entityCount: 2000,
      edgeCount: 5000,
      elapsedMs: 3200,
      communityCount: 25,
    });

    expect(lm.filesIndexed).toBe(500);
    expect(lm.entitiesExtracted).toBe(2000);
    expect(lm.edgesComputed).toBe(5000);
    expect(lm.indexingTimeMs).toBe(3200);
    expect(lm.communitiesDetected).toBe(25);
  });

  it("recordBlastRadius increments counter", () => {
    recordBlastRadius(lm);
    recordBlastRadius(lm);
    expect(lm.blastRadiusComputations).toBe(2);
  });

  it("recordCorrectionInjection increments counter", () => {
    recordCorrectionInjection(lm);
    recordCorrectionInjection(lm);
    recordCorrectionInjection(lm);
    expect(lm.correctionPatternsInjected).toBe(3);
  });

  it("recordCommunityContext increments counter", () => {
    recordCommunityContext(lm);
    expect(lm.communityContextsInjected).toBe(1);
  });
});

// ── Local Mode Shutdown Summary ─────────────────────────────────

describe("formatLocalModeSessionStats", () => {
  function makeStats(): SessionStats {
    const stats = createSessionStats(true);
    // Simulate a session with activity
    for (let i = 0; i < 50; i++) {
      recordToolCall(stats);
      recordLatency(stats.latency, 2 + Math.random() * 3);
    }
    stats.violationsCaught = 3;
    stats.riskWarningsIssued = 1;
    stats.events.chokepointWarningsIssued = 2;

    const lm = stats.localMode as LocalModeStats;
    recordGraphQuery(lm, "get_function");
    recordGraphQuery(lm, "get_function");
    recordGraphQuery(lm, "get_class");
    recordGraphQuery(lm, "search_code");
    recordGraphQuery(lm, "get_callers");
    recordBlastRadius(lm);
    recordBlastRadius(lm);
    recordTruncationSavings(lm, 10000, 3000);
    recordCorrectionInjection(lm);
    return stats;
  }

  it("returns null for zero tool calls", () => {
    const stats = createSessionStats(true);
    expect(formatLocalModeSessionStats(stats)).toBeNull();
  });

  it("falls back to standard format when localMode is null", () => {
    const stats = createSessionStats(false);
    recordToolCall(stats);
    const result = formatLocalModeSessionStats(stats);
    // Should use formatSessionStats (standard mode output)
    expect(result).toContain("unerr session");
  });

  it("renders Local Mode session summary header", () => {
    const result = formatLocalModeSessionStats(makeStats());
    expect(result).toContain("Local Mode Session Summary");
  });

  it("includes MCP tool call counts", () => {
    const result = formatLocalModeSessionStats(makeStats()) as string;
    expect(result).toContain("50 (all local)");
  });

  it("includes latency percentiles", () => {
    const result = formatLocalModeSessionStats(makeStats()) as string;
    expect(result).toContain("(p50)");
    expect(result).toContain("(p95)");
  });

  it("includes graph intelligence section", () => {
    const result = formatLocalModeSessionStats(makeStats()) as string;
    expect(result).toContain("Graph Intelligence:");
    expect(result).toContain("Entity lookups:");
    expect(result).toContain("Blast radius:");
    expect(result).toContain("Search queries:");
    expect(result).toContain("Callers/callees:");
  });

  it("includes token discipline section", () => {
    const result = formatLocalModeSessionStats(makeStats()) as string;
    expect(result).toContain("Token Discipline:");
    expect(result).toContain("Tokens saved:");
    expect(result).toContain("Responses truncated:");
  });

  it("includes safety catches section", () => {
    const result = formatLocalModeSessionStats(makeStats()) as string;
    expect(result).toContain("Safety Catches:");
    expect(result).toContain("Violations caught:");
    expect(result).toContain("Corrections applied:");
  });

  it("includes network isolation section", () => {
    const result = formatLocalModeSessionStats(makeStats()) as string;
    expect(result).toContain("Network Isolation:");
    expect(result).toContain("0 (firewall sealed)");
  });

  it("omits empty sections", () => {
    const stats = createSessionStats(true);
    recordToolCall(stats);
    recordLatency(stats.latency, 2);
    const result = formatLocalModeSessionStats(stats) as string;
    expect(result).not.toContain("Graph Intelligence:");
    expect(result).not.toContain("Token Discipline:");
    expect(result).not.toContain("Safety Catches:");
    expect(result).not.toContain("Semantic Intelligence:");
    // Network Isolation always shown
    expect(result).toContain("Network Isolation:");
  });
});

// ── Cumulative Local Stats Persistence ──────────────────────────

describe("CumulativeLocalStats", () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `unerr-cumul-test-${Date.now()}`);
    mkdirSync(join(tmpDir, ".unerr"), { recursive: true });
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns empty stats when no file exists", () => {
    const cls = loadCumulativeLocalStats();
    expect(cls.totalSessions).toBe(0);
    expect(cls.totalToolCalls).toBe(0);
    expect(cls.totalTokensSaved).toBe(0);
  });

  it("persists and loads stats across calls", () => {
    const stats = createSessionStats(true);
    for (let i = 0; i < 10; i++) recordToolCall(stats);
    stats.violationsCaught = 2;
    recordTruncationSavings(stats.localMode as LocalModeStats, 5000, 1000);
    recordCorrectionInjection(stats.localMode as LocalModeStats);

    const result = persistCumulativeLocalStats(stats);
    expect(result.totalSessions).toBe(1);
    expect(result.totalToolCalls).toBe(10);
    expect(result.totalTokensSaved).toBe(4000);
    expect(result.totalViolationsCaught).toBe(2);
    expect(result.totalCorrectionsApplied).toBe(1);

    // Second session accumulates
    const stats2 = createSessionStats(true);
    for (let i = 0; i < 5; i++) recordToolCall(stats2);
    stats2.violationsCaught = 1;
    recordTruncationSavings(stats2.localMode as LocalModeStats, 3000, 1000);

    const result2 = persistCumulativeLocalStats(stats2);
    expect(result2.totalSessions).toBe(2);
    expect(result2.totalToolCalls).toBe(15);
    expect(result2.totalTokensSaved).toBe(6000);
    expect(result2.totalViolationsCaught).toBe(3);
  });

  it("resets on new week", () => {
    // Write stats with a stale week
    const staleStats: CumulativeLocalStats = {
      weekStartDate: "2020-01-06",
      totalSessions: 100,
      totalToolCalls: 5000,
      totalTokensSaved: 999999,
      totalViolationsCaught: 50,
      totalCorrectionsApplied: 10,
      totalFilesIndexed: 200,
      avgLatencyP50: 2.5,
    };
    const filePath = join(tmpDir, ".unerr", "cumulative-local-stats.json");
    writeFileSync(filePath, JSON.stringify(staleStats));

    const loaded = loadCumulativeLocalStats();
    expect(loaded.totalSessions).toBe(0);
    expect(loaded.totalToolCalls).toBe(0);
  });

  it("returns existing cumulative when localMode is null", () => {
    const stats = createSessionStats(false); // standard mode
    const result = persistCumulativeLocalStats(stats);
    expect(result.totalSessions).toBe(0);
  });
});
