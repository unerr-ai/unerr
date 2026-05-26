import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SessionHistoryEntry,
  appendSessionHistory,
  readSessionHistory,
} from "../tracking/session-history.js";
import {
  type SessionReceiptInput,
  formatSessionReceipt,
} from "../tracking/session-receipt.js";
import {
  type SessionTokenSummary,
  TokenFlowWriter,
  aggregateSession,
} from "../tracking/token-flow.js";

describe("token-flow-persistence", () => {
  let tmpDir: string;
  let unerrDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-tfp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── TF-C.1 + TF-C.2: Session history persistence ─────────────────

  describe("session history with tokenFlowSummary", () => {
    it("persists tokenFlowSummary in session history entries", () => {
      const entry: SessionHistoryEntry = {
        sessionId: "test-sess-001",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:23:00Z",
        durationMs: 23 * 60_000,
        toolCalls: 15,
        tokensSaved: 51600,
        tokensProcessed: 80200,
        efficiency: 64,
        modelId: "unknown",
        entityCount: 0,
        tokenFlowSummary: {
          by_mechanism: {
            graph_query: { tokens_saved: 38400, event_count: 8 },
            shell_compression: { tokens_saved: 4200, event_count: 3 },
            format_encoding: { tokens_saved: 1600, event_count: 5 },
          },
          top_mechanism: "graph_query",
          efficiency_pct: 64,
          total_tokens_saved: 51600,
          total_tokens_delivered: 28800,
        },
      };

      appendSessionHistory(unerrDir, entry);
      const entries = readSessionHistory(unerrDir);

      expect(entries).toHaveLength(1);
      expect(entries[0]!.tokenFlowSummary).toBeDefined();
      expect(entries[0]!.tokenFlowSummary!.top_mechanism).toBe("graph_query");
      expect(
        entries[0]!.tokenFlowSummary!.by_mechanism.graph_query!.tokens_saved
      ).toBe(38400);
      expect(entries[0]!.tokenFlowSummary!.total_tokens_saved).toBe(51600);
    });

    it("reads entries without tokenFlowSummary (backward compatibility)", () => {
      const entry: SessionHistoryEntry = {
        sessionId: "old-session",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:10:00Z",
        durationMs: 600_000,
        toolCalls: 5,
        tokensSaved: 10000,
        tokensProcessed: 20000,
        efficiency: 50,
        modelId: "unknown",
        entityCount: 0,
      };

      appendSessionHistory(unerrDir, entry);
      const entries = readSessionHistory(unerrDir);

      expect(entries).toHaveLength(1);
      expect(entries[0]!.tokenFlowSummary).toBeUndefined();
    });

    it("aggregates multiple sessions with tokenFlowSummary", () => {
      for (let i = 0; i < 3; i++) {
        appendSessionHistory(unerrDir, {
          sessionId: `session-${i}`,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 60_000,
          toolCalls: 5,
          tokensSaved: 1000 * (i + 1),
          tokensProcessed: 5000,
          efficiency: 20 * (i + 1),
          modelId: "unknown",
          entityCount: 0,
          tokenFlowSummary: {
            by_mechanism: {
              graph_query: { tokens_saved: 800 * (i + 1), event_count: 3 },
              shell_compression: {
                tokens_saved: 200 * (i + 1),
                event_count: 1,
              },
            },
            top_mechanism: "graph_query",
            efficiency_pct: 20 * (i + 1),
            total_tokens_saved: 1000 * (i + 1),
            total_tokens_delivered: 4000,
          },
        });
      }

      const entries = readSessionHistory(unerrDir);
      expect(entries).toHaveLength(3);

      const totalGraphSaved = entries.reduce(
        (s, e) =>
          s + (e.tokenFlowSummary?.by_mechanism.graph_query?.tokens_saved ?? 0),
        0
      );
      expect(totalGraphSaved).toBe(800 + 1600 + 2400);
    });
  });

  // ── TF-C.4: Session receipt formatting ────────────────────────────

  describe("session receipt", () => {
    function makeSummary(): SessionTokenSummary {
      const writer = new TokenFlowWriter(unerrDir, "receipt-test");
      writer.record({
        session_id: "receipt-test",
        turn: 1,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
      });
      writer.record({
        session_id: "receipt-test",
        turn: 2,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 2000,
        tokens_with: 800,
        tokens_saved: 1200,
      });
      writer.record({
        session_id: "receipt-test",
        turn: 3,
        mechanism: "format_encoding",
        tool: "get_callers",
        tokens_without: 1800,
        tokens_with: 1480,
        tokens_saved: 320,
      });
      return aggregateSession(writer.getSessionEvents(), "receipt-test");
    }

    it("produces formatted receipt with all sections", () => {
      const summary = makeSummary();
      const receipt = formatSessionReceipt({
        summary,
        durationMs: 23 * 60_000,
        toolCalls: 15,
        weeklyTokensSaved: 312_000,
        weeklySessions: 7,
      });

      expect(receipt).toContain("unerr");
      expect(receipt).toContain("session receipt");
      expect(receipt).toContain("23 minutes");
      expect(receipt).toContain("15");
      expect(receipt).toContain("graph_query");
      expect(receipt).toContain("shell_compression");
      expect(receipt).toContain("312.0K");
    });

    it("receipt includes efficiency percentage", () => {
      const summary = makeSummary();
      const receipt = formatSessionReceipt({
        summary,
        durationMs: 60_000,
        toolCalls: 3,
      });

      expect(receipt).toContain(`${summary.efficiency_pct}%`);
    });

    it("receipt includes most efficient turn", () => {
      const summary = makeSummary();
      const receipt = formatSessionReceipt({
        summary,
        durationMs: 60_000,
        toolCalls: 3,
      });

      expect(receipt).toContain("get_callers");
    });

    it("receipt handles empty session gracefully", () => {
      const emptySummary: SessionTokenSummary = {
        session_id: "empty",
        total_turns: 0,
        total_tokens_without: 0,
        total_tokens_with: 0,
        total_tokens_saved: 0,
        efficiency_pct: 0,
        by_mechanism: {},
        top_turns: [],
      };

      const receipt = formatSessionReceipt({
        summary: emptySummary,
        durationMs: 0,
        toolCalls: 0,
      });

      expect(receipt).toContain("0%");
    });

    it("receipt includes box-drawing characters", () => {
      const summary = makeSummary();
      const receipt = formatSessionReceipt({
        summary,
        durationMs: 60_000,
        toolCalls: 3,
      });

      expect(receipt).toContain("┌");
      expect(receipt).toContain("└");
      expect(receipt).toContain("│");
    });
  });

  // ── TF-C.3: WeeklyStats tokensByMechanism ────────────────────────

  describe("weekly stats mechanism breakdown", () => {
    it("formatStatsReport includes mechanism breakdown when present", async () => {
      const { formatStatsReport } = await import(
        "../tracking/weekly-accumulator.js"
      );
      const stats = {
        version: 1 as const,
        weekly: {
          weekStart: "2026-01-06",
          sessions: 5,
          tokensSaved: 100_000,
          toolCalls: 75,
          violationsCaught: 2,
          chokepointWarnings: 1,
          correctionsApplied: 0,
          blastRadiusComputed: 3,
          avgEfficiency: 65,
          avgLatencyP50: 2.1,
          tokensByMechanism: {
            graph_query: 74000,
            shell_compression: 12000,
            format_encoding: 8000,
            smart_truncation: 6000,
          },
        },
        allTime: {
          firstSessionDate: "2026-01-01T00:00:00Z",
          totalSessions: 20,
          totalTokensSaved: 500_000,
          totalViolationsCaught: 10,
        },
        lastUpdated: new Date().toISOString(),
      };

      const report = formatStatsReport(stats);

      expect(report).toContain("By mechanism:");
      expect(report).toContain("graph_query");
      expect(report).toContain("shell_compression");
      expect(report).toContain("format_encoding");
      expect(report).toContain("█");
    });

    it("formatStatsReport omits mechanism section when empty", async () => {
      const { formatStatsReport } = await import(
        "../tracking/weekly-accumulator.js"
      );
      const stats = {
        version: 1 as const,
        weekly: {
          weekStart: "2026-01-06",
          sessions: 1,
          tokensSaved: 1000,
          toolCalls: 5,
          violationsCaught: 0,
          chokepointWarnings: 0,
          correctionsApplied: 0,
          blastRadiusComputed: 0,
          avgEfficiency: 50,
          avgLatencyP50: 1.5,
        },
        allTime: {
          firstSessionDate: "2026-01-01T00:00:00Z",
          totalSessions: 1,
          totalTokensSaved: 1000,
          totalViolationsCaught: 0,
        },
        lastUpdated: new Date().toISOString(),
      };

      const report = formatStatsReport(stats);

      expect(report).not.toContain("By mechanism:");
    });
  });

  // ── End-to-End: Token Flow → Summary → Receipt ───────────────────

  describe("end-to-end flow", () => {
    it("events → aggregation → session history → receipt", () => {
      const writer = new TokenFlowWriter(unerrDir, "e2e-session");

      writer.record({
        session_id: "e2e-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "search_code",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
      });
      writer.record({
        session_id: "e2e-session",
        turn: 2,
        mechanism: "graph_query",
        tool: "get_entity",
        tokens_without: 3000,
        tokens_with: 2400,
        tokens_saved: 600,
      });
      writer.record({
        session_id: "e2e-session",
        turn: 3,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 6800,
        tokens_with: 2000,
        tokens_saved: 4800,
      });
      writer.record({
        session_id: "e2e-session",
        turn: 4,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 2000,
        tokens_with: 800,
        tokens_saved: 1200,
      });

      const summary = aggregateSession(
        writer.getSessionEvents(),
        "e2e-session"
      );

      expect(summary.total_tokens_saved).toBe(9800);
      expect(summary.by_mechanism.graph_query!.tokens_saved).toBe(8600);

      const topMech = Object.entries(summary.by_mechanism).sort(
        ([, a], [, b]) => b.tokens_saved - a.tokens_saved
      )[0];

      appendSessionHistory(unerrDir, {
        sessionId: "e2e-session",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 300_000,
        toolCalls: 4,
        tokensSaved: summary.total_tokens_saved,
        tokensProcessed: summary.total_tokens_without,
        efficiency: summary.efficiency_pct,
        modelId: "unknown",
        entityCount: 0,
        tokenFlowSummary: {
          by_mechanism: Object.fromEntries(
            Object.entries(summary.by_mechanism).map(([k, v]) => [
              k,
              { tokens_saved: v.tokens_saved, event_count: v.event_count },
            ])
          ),
          top_mechanism: topMech?.[0] ?? "none",
          efficiency_pct: summary.efficiency_pct,
          total_tokens_saved: summary.total_tokens_saved,
          total_tokens_delivered: summary.total_tokens_with,
        },
      });

      const history = readSessionHistory(unerrDir);
      expect(history).toHaveLength(1);
      expect(history[0]!.tokenFlowSummary!.top_mechanism).toBe("graph_query");

      const receipt = formatSessionReceipt({
        summary,
        durationMs: 300_000,
        toolCalls: 4,
      });

      expect(receipt).toContain("graph_query");
      expect(receipt).toContain("shell_compression");
    });
  });
});
