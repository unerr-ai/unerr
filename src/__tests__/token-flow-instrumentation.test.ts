import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EfficiencyTracker,
  createEfficiencyTracker,
} from "../proxy/efficiency-tracker.js";
import {
  type TokenFlowEvent,
  TokenFlowWriter,
  aggregateSession,
} from "../tracking/token-flow.js";

describe("token-flow-instrumentation", () => {
  let tmpDir: string;
  let unerrDir: string;
  let writer: TokenFlowWriter;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-tfi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    writer = new TokenFlowWriter(unerrDir, "test-session");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── TF-B.1: Graph Query Instrumentation ─────────────────────────

  describe("graph_query mechanism", () => {
    it("records savings from graph query vs file exploration counterfactual", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
        detail: { counterfactual: "file_read" },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mechanism).toBe("graph_query");
      expect(events[0]!.tokens_saved).toBe(3200);
      expect(events[0]!.detail?.counterfactual).toBe("file_read");
    });

    it("graph_query dominates typical session savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "search_code",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
      });
      writer.record({
        session_id: "test-session",
        turn: 2,
        mechanism: "graph_query",
        tool: "get_entity",
        tokens_without: 3000,
        tokens_with: 2400,
        tokens_saved: 600,
      });
      writer.record({
        session_id: "test-session",
        turn: 3,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 6800,
        tokens_with: 2000,
        tokens_saved: 4800,
      });

      const summary = aggregateSession(
        writer.getSessionEvents(),
        "test-session",
      );
      expect(summary.by_mechanism.graph_query!.tokens_saved).toBe(8600);
      expect(summary.by_mechanism.graph_query!.pct_of_total).toBe(100);
    });
  });

  // ── TF-B.2: Session Dedup Instrumentation ───────────────────────

  describe("session_dedup mechanism", () => {
    it("records deduped context keys as savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 5,
        mechanism: "session_dedup",
        tool: "get_entity",
        tokens_without: 480,
        tokens_with: 0,
        tokens_saved: 480,
        detail: { keys_deduped: 3 },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mechanism).toBe("session_dedup");
      expect(events[0]!.tokens_with).toBe(0);
    });
  });

  // ── TF-B.3: Format Encoding Instrumentation ────────────────────

  describe("format_encoding mechanism", () => {
    it("records columnar encoding savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 3,
        mechanism: "format_encoding",
        tool: "get_callers",
        tokens_without: 2000,
        tokens_with: 1680,
        tokens_saved: 320,
        detail: { format: "columnar" },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mechanism).toBe("format_encoding");
      expect(events[0]!.detail?.format).toBe("columnar");
    });
  });

  // ── TF-B.4: Shell Compression Instrumentation ──────────────────

  describe("shell_compression mechanism", () => {
    it("records shell compression with null tool and turn 0", () => {
      writer.record({
        session_id: "test-session",
        turn: 0,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 3400,
        tokens_with: 800,
        tokens_saved: 2600,
        detail: { command: "ps aux", category: "tabular", strategy: "tabular" },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.tool).toBeNull();
      expect(events[0]!.turn).toBe(0);
      expect(events[0]!.mechanism).toBe("shell_compression");
    });

    it("shell compression savings aggregate into session totals", () => {
      writer.record({
        session_id: "test-session",
        turn: 0,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 3400,
        tokens_with: 800,
        tokens_saved: 2600,
      });
      writer.record({
        session_id: "test-session",
        turn: 0,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 2100,
        tokens_with: 600,
        tokens_saved: 1500,
      });

      expect(writer.getSessionTokensSaved()).toBe(4100);
    });
  });

  // ── TF-B.5: Smart Truncation Instrumentation ───────────────────

  describe("smart_truncation mechanism", () => {
    it("records entity truncation savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 4,
        mechanism: "smart_truncation",
        tool: "get_entity",
        tokens_without: 5000,
        tokens_with: 2000,
        tokens_saved: 3000,
        detail: { level: "signatures_and_bodies" },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mechanism).toBe("smart_truncation");
      expect(events[0]!.detail?.level).toBe("signatures_and_bodies");
    });

    it("records list truncation savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 2,
        mechanism: "smart_truncation",
        tool: "get_callers",
        tokens_without: 8000,
        tokens_with: 2000,
        tokens_saved: 6000,
        detail: { type: "list", total: 50, returned: 12 },
      });

      const events = writer.getSessionEvents();
      expect(events[0]!.detail?.type).toBe("list");
    });
  });

  // ── TF-B.6: File Read Optimization Instrumentation ─────────────

  describe("file_read mechanism", () => {
    it("records file read windowing savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 6,
        mechanism: "file_read",
        tool: "file_read",
        tokens_without: 10000,
        tokens_with: 600,
        tokens_saved: 9400,
        detail: {
          optimization: "file_read window lines 45-55 · entity",
          total_lines: 500,
        },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mechanism).toBe("file_read");
      expect(events[0]!.tokens_saved).toBe(9400);
    });
  });

  // ── TF-B.7: Behavior Automation Instrumentation ────────────────

  describe("behavior_automation mechanism", () => {
    it("records halted tool call as savings", () => {
      writer.record({
        session_id: "test-session",
        turn: 7,
        mechanism: "behavior_automation",
        tool: "get_entity",
        tokens_without: 3200,
        tokens_with: 400,
        tokens_saved: 2800,
        detail: { behavior: "cascade_guard", action: "halted" },
      });

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.mechanism).toBe("behavior_automation");
      expect(events[0]!.detail?.behavior).toBe("cascade_guard");
    });
  });

  // ── TF-B.8: _meta Enrichment ───────────────────────────────────

  describe("session-level _meta enrichment", () => {
    it("getSessionTokensSaved tracks running total", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
      });
      writer.record({
        session_id: "test-session",
        turn: 2,
        mechanism: "format_encoding",
        tool: "t",
        tokens_without: 1800,
        tokens_with: 1480,
        tokens_saved: 320,
      });

      expect(writer.getSessionTokensSaved()).toBe(3520);
    });

    it("getSessionEfficiency computes percentage from all events", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 10000,
        tokens_with: 4000,
        tokens_saved: 6000,
      });

      expect(writer.getSessionEfficiency()).toBe(60);
    });
  });

  // ── TF-B.9: EfficiencyTracker Supersession ─────────────────────

  describe("EfficiencyTracker backed by TokenFlow", () => {
    it("getSnapshot derives from token flow events", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
      });
      writer.record({
        session_id: "test-session",
        turn: 2,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 2000,
        tokens_with: 800,
        tokens_saved: 1200,
      });

      const tracker = createEfficiencyTracker(writer);
      const snap = tracker.getSnapshot();

      expect(snap.totalCalls).toBe(2);
      expect(snap.originalTokens).toBe(7000);
      expect(snap.deliveredTokens).toBe(2600);
      expect(snap.savedTokens).toBe(4400);
      expect(snap.efficiency).toBe(63);
      expect(snap.avgSavingsPerCall).toBe(2200);
    });

    it("record() is a no-op when backed by TokenFlow", () => {
      const tracker = createEfficiencyTracker(writer);

      // Record should not affect TokenFlow-backed tracker
      tracker.record(9999, 1111);
      const snap = tracker.getSnapshot();
      expect(snap.totalCalls).toBe(0);
      expect(snap.savedTokens).toBe(0);
    });

    it("getEfficiency delegates to TokenFlow", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 10000,
        tokens_with: 3000,
        tokens_saved: 7000,
      });

      const tracker = createEfficiencyTracker(writer);
      expect(tracker.getEfficiency()).toBe(70);
    });

    it("getSavedTokens delegates to TokenFlow", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 5000,
        tokens_with: 2000,
        tokens_saved: 3000,
      });

      const tracker = createEfficiencyTracker(writer);
      expect(tracker.getSavedTokens()).toBe(3000);
    });

    it("fallback mode works without TokenFlow", () => {
      const tracker = createEfficiencyTracker();
      tracker.record(5000, 2000);
      tracker.record(3000, 1000);

      const snap = tracker.getSnapshot();
      expect(snap.totalCalls).toBe(2);
      expect(snap.originalTokens).toBe(8000);
      expect(snap.deliveredTokens).toBe(3000);
      expect(snap.savedTokens).toBe(5000);
      expect(snap.efficiency).toBe(63);
    });
  });

  // ── Multi-Mechanism Session ────────────────────────────────────

  describe("multi-mechanism session scenario", () => {
    it("aggregates 7 mechanism types with correct attribution", () => {
      const events: Array<{
        mechanism: string;
        saved: number;
        without: number;
        with_: number;
      }> = [
        {
          mechanism: "graph_query",
          saved: 38400,
          without: 52000,
          with_: 13600,
        },
        {
          mechanism: "shell_compression",
          saved: 4200,
          without: 6200,
          with_: 2000,
        },
        {
          mechanism: "behavior_automation",
          saved: 2400,
          without: 2400,
          with_: 0,
        },
        {
          mechanism: "smart_truncation",
          saved: 2100,
          without: 3500,
          with_: 1400,
        },
        { mechanism: "file_read", saved: 1800, without: 2400, with_: 600 },
        {
          mechanism: "format_encoding",
          saved: 1600,
          without: 5600,
          with_: 4000,
        },
        { mechanism: "session_dedup", saved: 1100, without: 1100, with_: 0 },
      ];

      for (const [i, e] of events.entries()) {
        writer.record({
          session_id: "test-session",
          turn: i + 1,
          mechanism: e.mechanism as any,
          tool: i === 1 ? null : `tool_${i}`,
          tokens_without: e.without,
          tokens_with: e.with_,
          tokens_saved: e.saved,
        });
      }

      const summary = aggregateSession(
        writer.getSessionEvents(),
        "test-session",
      );

      expect(summary.total_turns).toBe(7);
      expect(summary.total_tokens_saved).toBe(51600);
      expect(summary.total_tokens_with).toBe(21600);
      expect(summary.total_tokens_without).toBe(73200);

      // graph_query should be the top mechanism
      expect(summary.by_mechanism.graph_query!.pct_of_total).toBeGreaterThan(
        70,
      );

      // All 7 mechanisms present
      expect(Object.keys(summary.by_mechanism)).toHaveLength(7);

      // Top turn should be graph_query
      expect(summary.top_turns[0]!.primary_mechanism).toBe("graph_query");

      // Efficiency matches the doc scenario (~70%)
      expect(summary.efficiency_pct).toBeGreaterThan(60);
      expect(summary.efficiency_pct).toBeLessThan(80);
    });
  });

  // ── Cross-Process Shell Compression ────────────────────────────

  describe("cross-process shell compression", () => {
    it("shell compression events from exec processes include session_id from env", () => {
      const sessionId = "cross-process-session-123";
      writer.record({
        session_id: sessionId,
        turn: 0,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 3400,
        tokens_with: 800,
        tokens_saved: 2600,
        detail: { command: "ps aux", category: "tabular" },
      });

      const events = writer.getSessionEvents();
      expect(events[0]!.session_id).toBe(sessionId);
      expect(events[0]!.turn).toBe(0);
    });
  });

  // ── Zero-Savings Edge Case ────────────────────────────────────

  describe("zero-savings edge cases", () => {
    it("zero-savings events are valid and aggregated", () => {
      writer.record({
        session_id: "test-session",
        turn: 1,
        mechanism: "format_encoding",
        tool: "get_entity",
        tokens_without: 500,
        tokens_with: 500,
        tokens_saved: 0,
      });

      const summary = aggregateSession(
        writer.getSessionEvents(),
        "test-session",
      );
      expect(summary.total_tokens_saved).toBe(0);
      expect(summary.efficiency_pct).toBe(0);
    });
  });
});
