import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import {
  type SessionTokenSummary,
  type TokenFlowEvent,
  type TokenFlowInput,
  TokenFlowWriter,
  aggregateByMechanism,
  aggregateSession,
  readTokenFlowEvents,
} from "../tracking/token-flow.js";

describe("token-flow", () => {
  let tmpDir: string;
  let unerrDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-tokenflow-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    dbPath = join(unerrDir, "metrics.db");
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeInput(overrides?: Partial<TokenFlowInput>): TokenFlowInput {
    return {
      session_id: "test-session-001",
      turn: 1,
      mechanism: "graph_query",
      tool: "get_callers",
      tokens_without: 5000,
      tokens_with: 1800,
      tokens_saved: 3200,
      ...overrides,
    };
  }

  // ── Writer Tests ──────────────────────────────────────────────────

  describe("TokenFlowWriter", () => {
    it("creates metrics.db on first write", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput());
      expect(existsSync(dbPath)).toBe(true);
    });

    it("writes events with auto-populated fields", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput());

      const [event] = readTokenFlowEvents(unerrDir);
      expect(event).toBeDefined();
      expect(event!.id).toBeGreaterThan(0);
      expect(event!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event!.pid).toBe(process.pid);
      expect(event!.session_id).toBe("test-session-001");
      expect(event!.turn).toBe(1);
      expect(event!.mechanism).toBe("graph_query");
      expect(event!.tool).toBe("get_callers");
      expect(event!.tokens_without).toBe(5000);
      expect(event!.tokens_with).toBe(1800);
      expect(event!.tokens_saved).toBe(3200);
    });

    it("assigns monotonic IDs across multiple writes", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput({ turn: 1 }));
      writer.record(makeInput({ turn: 2 }));
      writer.record(makeInput({ turn: 3 }));

      const events = readTokenFlowEvents(unerrDir);
      expect(events).toHaveLength(3);
      const ids = events.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(3);
    });

    it("records detail metadata when provided", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(
        makeInput({ detail: { counterfactual: "file_read", depth: 3 } })
      );

      const [event] = readTokenFlowEvents(unerrDir);
      expect(event!.detail).toEqual({ counterfactual: "file_read", depth: 3 });
    });

    it("records events with null tool (shell compression)", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(
        makeInput({
          mechanism: "shell_compression",
          tool: null,
          turn: 0,
          tokens_without: 3400,
          tokens_with: 800,
          tokens_saved: 2600,
        })
      );

      const [event] = readTokenFlowEvents(unerrDir);
      expect(event!.tool).toBeNull();
      expect(event!.mechanism).toBe("shell_compression");
    });

    it("getSessionEvents returns in-memory buffer", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput({ turn: 1 }));
      writer.record(makeInput({ turn: 2 }));

      const events = writer.getSessionEvents();
      expect(events).toHaveLength(2);
      expect(events[0]!.turn).toBe(1);
      expect(events[1]!.turn).toBe(2);
    });

    it("getSessionTokensSaved computes running total", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput({ tokens_saved: 3200 }));
      writer.record(makeInput({ tokens_saved: 1200 }));
      writer.record(makeInput({ tokens_saved: 480 }));

      expect(writer.getSessionTokensSaved()).toBe(4880);
    });

    it("getSessionEfficiency computes correct percentage", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput({ tokens_without: 10000, tokens_saved: 7000 }));
      writer.record(makeInput({ tokens_without: 5000, tokens_saved: 2000 }));

      // Total without: 15000, total saved: 9000 → 60%
      expect(writer.getSessionEfficiency()).toBe(60);
    });

    it("getSessionEfficiency returns 0 when no events", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      expect(writer.getSessionEfficiency()).toBe(0);
    });

    it("handles zero-savings events", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(
        makeInput({
          tokens_without: 100,
          tokens_with: 100,
          tokens_saved: 0,
        })
      );

      expect(writer.getSessionTokensSaved()).toBe(0);
      expect(writer.getSessionEfficiency()).toBe(0);
    });
  });

  // ── Reader Tests ──────────────────────────────────────────────────

  describe("readTokenFlowEvents", () => {
    it("returns empty array when file does not exist", () => {
      const events = readTokenFlowEvents(unerrDir);
      expect(events).toEqual([]);
    });

    it("reads all events from JSONL file", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput({ turn: 1 }));
      writer.record(makeInput({ turn: 2 }));
      writer.record(makeInput({ turn: 3 }));

      const events = readTokenFlowEvents(unerrDir);
      expect(events).toHaveLength(3);
    });

    it("filters by session_id", () => {
      const writer1 = new TokenFlowWriter(unerrDir, "session-a");
      writer1.record(makeInput({ session_id: "session-a" }));
      writer1.record(makeInput({ session_id: "session-a" }));

      const writer2 = new TokenFlowWriter(unerrDir, "session-b");
      writer2.record(makeInput({ session_id: "session-b" }));

      const eventsA = readTokenFlowEvents(unerrDir, {
        session_id: "session-a",
      });
      expect(eventsA).toHaveLength(2);

      const eventsB = readTokenFlowEvents(unerrDir, {
        session_id: "session-b",
      });
      expect(eventsB).toHaveLength(1);
    });

    it("filters by mechanism", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      writer.record(makeInput({ mechanism: "graph_query" }));
      writer.record(makeInput({ mechanism: "shell_compression" }));
      writer.record(makeInput({ mechanism: "format_encoding" }));
      writer.record(makeInput({ mechanism: "graph_query" }));

      const graphEvents = readTokenFlowEvents(unerrDir, {
        mechanism: "graph_query",
      });
      expect(graphEvents).toHaveLength(2);
    });

    it("skips malformed detail JSON gracefully", () => {
      // SQLite stores detail as a TEXT column; if a row ever has a corrupt
      // JSON payload (e.g. external migration), the reader returns it but
      // simply leaves `detail` undefined rather than throwing.
      const store = openMetricsStore(unerrDir);
      store.insertTokenFlow({
        ts: Date.now(),
        ts_iso: new Date().toISOString(),
        session_id: "s1",
        pid: 1,
        turn: 1,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 100,
        tokens_with: 50,
        tokens_saved: 50,
        detail: "{not valid json",
      });
      store.insertTokenFlow({
        ts: Date.now(),
        ts_iso: new Date().toISOString(),
        session_id: "s1",
        pid: 1,
        turn: 2,
        mechanism: "graph_query",
        tool: "t",
        tokens_without: 200,
        tokens_with: 100,
        tokens_saved: 100,
        detail: null,
      });

      expect(() => readTokenFlowEvents(unerrDir)).not.toThrow();
      const events = readTokenFlowEvents(unerrDir);
      expect(events).toHaveLength(2);
    });
  });

  // ── Aggregation Tests ─────────────────────────────────────────────

  describe("aggregateSession", () => {
    it("computes correct session totals", () => {
      const writer = new TokenFlowWriter(unerrDir, "s1");
      writer.record(
        makeInput({
          session_id: "s1",
          turn: 1,
          tokens_without: 5000,
          tokens_with: 1800,
          tokens_saved: 3200,
        })
      );
      writer.record(
        makeInput({
          session_id: "s1",
          turn: 2,
          tokens_without: 2000,
          tokens_with: 800,
          tokens_saved: 1200,
        })
      );
      writer.record(
        makeInput({
          session_id: "s1",
          turn: 3,
          tokens_without: 1000,
          tokens_with: 520,
          tokens_saved: 480,
        })
      );

      const summary = aggregateSession(writer.getSessionEvents(), "s1");

      expect(summary.session_id).toBe("s1");
      expect(summary.total_turns).toBe(3);
      expect(summary.total_tokens_without).toBe(8000);
      expect(summary.total_tokens_with).toBe(3120);
      expect(summary.total_tokens_saved).toBe(4880);
      expect(summary.efficiency_pct).toBe(61);
    });

    it("filters to correct session when multiple sessions present", () => {
      const events: TokenFlowEvent[] = [
        {
          id: 1,
          ts: "t1",
          session_id: "s1",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: 100,
          tokens_with: 50,
          tokens_saved: 50,
        },
        {
          id: 2,
          ts: "t2",
          session_id: "s2",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: 200,
          tokens_with: 100,
          tokens_saved: 100,
        },
        {
          id: 3,
          ts: "t3",
          session_id: "s1",
          pid: 1,
          turn: 2,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: 300,
          tokens_with: 150,
          tokens_saved: 150,
        },
      ];

      const s1Summary = aggregateSession(events, "s1");
      expect(s1Summary.total_tokens_saved).toBe(200);
      expect(s1Summary.total_turns).toBe(2);

      const s2Summary = aggregateSession(events, "s2");
      expect(s2Summary.total_tokens_saved).toBe(100);
      expect(s2Summary.total_turns).toBe(1);
    });

    it("builds mechanism breakdown with percentages", () => {
      const events: TokenFlowEvent[] = [
        {
          id: 1,
          ts: "t1",
          session_id: "s1",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "get_callers",
          tokens_without: 5000,
          tokens_with: 1800,
          tokens_saved: 3200,
        },
        {
          id: 2,
          ts: "t2",
          session_id: "s1",
          pid: 1,
          turn: 2,
          mechanism: "shell_compression",
          tool: null,
          tokens_without: 2000,
          tokens_with: 800,
          tokens_saved: 1200,
        },
        {
          id: 3,
          ts: "t3",
          session_id: "s1",
          pid: 1,
          turn: 3,
          mechanism: "graph_query",
          tool: "search_code",
          tokens_without: 1000,
          tokens_with: 600,
          tokens_saved: 400,
        },
      ];

      const summary = aggregateSession(events, "s1");

      expect(summary.by_mechanism.graph_query).toBeDefined();
      expect(summary.by_mechanism.graph_query!.tokens_saved).toBe(3600);
      expect(summary.by_mechanism.graph_query!.event_count).toBe(2);

      expect(summary.by_mechanism.shell_compression).toBeDefined();
      expect(summary.by_mechanism.shell_compression!.tokens_saved).toBe(1200);
      expect(summary.by_mechanism.shell_compression!.event_count).toBe(1);

      // Percentages should sum close to 100
      const totalPct = Object.values(summary.by_mechanism).reduce(
        (sum, m) => sum + m.pct_of_total,
        0
      );
      expect(totalPct).toBeCloseTo(100, 0);
    });

    it("identifies top turns sorted by tokens_saved", () => {
      const events: TokenFlowEvent[] = [
        {
          id: 1,
          ts: "t1",
          session_id: "s1",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "search_code",
          tokens_without: 1000,
          tokens_with: 800,
          tokens_saved: 200,
        },
        {
          id: 2,
          ts: "t2",
          session_id: "s1",
          pid: 1,
          turn: 2,
          mechanism: "graph_query",
          tool: "get_callers",
          tokens_without: 5000,
          tokens_with: 1000,
          tokens_saved: 4000,
        },
        {
          id: 3,
          ts: "t3",
          session_id: "s1",
          pid: 1,
          turn: 3,
          mechanism: "shell_compression",
          tool: null,
          tokens_without: 3000,
          tokens_with: 1200,
          tokens_saved: 1800,
        },
        {
          id: 4,
          ts: "t4",
          session_id: "s1",
          pid: 1,
          turn: 2,
          mechanism: "format_encoding",
          tool: "get_callers",
          tokens_without: 800,
          tokens_with: 500,
          tokens_saved: 300,
        },
      ];

      const summary = aggregateSession(events, "s1");

      expect(summary.top_turns[0]!.turn).toBe(2);
      expect(summary.top_turns[0]!.tokens_saved).toBe(4300);
      expect(summary.top_turns[0]!.tool).toBe("get_callers");
      expect(summary.top_turns[0]!.primary_mechanism).toBe("graph_query");

      expect(summary.top_turns[1]!.turn).toBe(3);
      expect(summary.top_turns[1]!.tokens_saved).toBe(1800);
    });

    it("limits top_turns to 5", () => {
      const events: TokenFlowEvent[] = [];
      for (let i = 1; i <= 10; i++) {
        events.push({
          id: i,
          ts: `t${i}`,
          session_id: "s1",
          pid: 1,
          turn: i,
          mechanism: "graph_query",
          tool: `tool_${i}`,
          tokens_without: i * 1000,
          tokens_with: i * 100,
          tokens_saved: i * 900,
        });
      }

      const summary = aggregateSession(events, "s1");
      expect(summary.top_turns).toHaveLength(5);
      expect(summary.top_turns[0]!.turn).toBe(10);
    });

    it("returns zero efficiency when no events for session", () => {
      const summary = aggregateSession([], "nonexistent");
      expect(summary.total_turns).toBe(0);
      expect(summary.total_tokens_saved).toBe(0);
      expect(summary.efficiency_pct).toBe(0);
      expect(summary.top_turns).toHaveLength(0);
    });

    it("handles multiple operations within same turn", () => {
      const events: TokenFlowEvent[] = [
        {
          id: 1,
          ts: "t1",
          session_id: "s1",
          pid: 1,
          turn: 3,
          mechanism: "graph_query",
          tool: "get_callers",
          tokens_without: 4800,
          tokens_with: 1800,
          tokens_saved: 3000,
        },
        {
          id: 2,
          ts: "t2",
          session_id: "s1",
          pid: 1,
          turn: 3,
          mechanism: "format_encoding",
          tool: "get_callers",
          tokens_without: 1800,
          tokens_with: 1480,
          tokens_saved: 320,
        },
        {
          id: 3,
          ts: "t3",
          session_id: "s1",
          pid: 1,
          turn: 3,
          mechanism: "session_dedup",
          tool: "get_callers",
          tokens_without: 480,
          tokens_with: 0,
          tokens_saved: 480,
        },
      ];

      const summary = aggregateSession(events, "s1");
      expect(summary.total_turns).toBe(1);
      expect(summary.total_tokens_saved).toBe(3800);

      const turn3 = summary.top_turns[0]!;
      expect(turn3.turn).toBe(3);
      expect(turn3.tokens_saved).toBe(3800);
      expect(turn3.primary_mechanism).toBe("graph_query");
    });
  });

  describe("aggregateByMechanism", () => {
    it("aggregates across all sessions", () => {
      const events: TokenFlowEvent[] = [
        {
          id: 1,
          ts: "t1",
          session_id: "s1",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: 100,
          tokens_with: 50,
          tokens_saved: 50,
        },
        {
          id: 2,
          ts: "t2",
          session_id: "s2",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: 200,
          tokens_with: 100,
          tokens_saved: 100,
        },
        {
          id: 3,
          ts: "t3",
          session_id: "s1",
          pid: 1,
          turn: 2,
          mechanism: "shell_compression",
          tool: null,
          tokens_without: 300,
          tokens_with: 100,
          tokens_saved: 200,
        },
      ];

      const breakdown = aggregateByMechanism(events);

      expect(breakdown.graph_query!.tokens_saved).toBe(150);
      expect(breakdown.graph_query!.event_count).toBe(2);
      expect(breakdown.shell_compression!.tokens_saved).toBe(200);
      expect(breakdown.shell_compression!.event_count).toBe(1);
    });

    it("computes correct percentages", () => {
      const events: TokenFlowEvent[] = [
        {
          id: 1,
          ts: "t1",
          session_id: "s1",
          pid: 1,
          turn: 1,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: 1000,
          tokens_with: 250,
          tokens_saved: 750,
        },
        {
          id: 2,
          ts: "t2",
          session_id: "s1",
          pid: 1,
          turn: 2,
          mechanism: "shell_compression",
          tool: null,
          tokens_without: 500,
          tokens_with: 250,
          tokens_saved: 250,
        },
      ];

      const breakdown = aggregateByMechanism(events);
      expect(breakdown.graph_query!.pct_of_total).toBe(75);
      expect(breakdown.shell_compression!.pct_of_total).toBe(25);
    });

    it("returns empty record for empty events", () => {
      const breakdown = aggregateByMechanism([]);
      expect(Object.keys(breakdown)).toHaveLength(0);
    });
  });

  // ── High-volume insert Tests ──────────────────────────────────────
  // (Replaces the prior "JSONL rotation" test — SQLite doesn't trim rows,
  // it indexes them.)

  describe("high-volume writes", () => {
    it("persists 2200 events without loss", () => {
      const writer = new TokenFlowWriter(unerrDir, "test-session-001");
      for (let i = 0; i < 2200; i++) {
        writer.record(makeInput({ turn: i, tokens_saved: i }));
      }
      const events = readTokenFlowEvents(unerrDir);
      expect(events).toHaveLength(2200);
      // Ordered by id ASC — the last inserted event is the last in the array.
      expect(events[events.length - 1]!.turn).toBe(2199);
    });
  });

  // ── Cross-Process Tests ───────────────────────────────────────────

  describe("cross-process coordination", () => {
    it("events from different PIDs coexist in same store", () => {
      // Simulate events written by two child processes by inserting via
      // the metrics-store directly with custom pid values.
      const store = openMetricsStore(unerrDir);
      store.insertTokenFlow({
        ts: Date.parse("2026-01-01T00:00:00Z"),
        ts_iso: "2026-01-01T00:00:00Z",
        session_id: "s1",
        pid: 12345,
        turn: 1,
        mechanism: "graph_query",
        tool: "get_callers",
        tokens_without: 5000,
        tokens_with: 1800,
        tokens_saved: 3200,
        detail: null,
      });
      store.insertTokenFlow({
        ts: Date.parse("2026-01-01T00:00:01Z"),
        ts_iso: "2026-01-01T00:00:01Z",
        session_id: "s1",
        pid: 54321,
        turn: 0,
        mechanism: "shell_compression",
        tool: null,
        tokens_without: 3400,
        tokens_with: 800,
        tokens_saved: 2600,
        detail: null,
      });

      const events = readTokenFlowEvents(unerrDir, { session_id: "s1" });
      expect(events).toHaveLength(2);

      const summary = aggregateSession(events, "s1");
      expect(summary.total_tokens_saved).toBe(5800);
      expect(summary.by_mechanism.graph_query!.tokens_saved).toBe(3200);
      expect(summary.by_mechanism.shell_compression!.tokens_saved).toBe(2600);
    });

    it("session_id filtering isolates concurrent sessions", () => {
      const store = openMetricsStore(unerrDir);
      const baseTs = Date.parse("2026-01-01T00:00:00Z");
      const insert = (
        sessionId: string,
        pid: number,
        turn: number,
        without: number,
        saved: number,
        offsetSec: number
      ): void => {
        store.insertTokenFlow({
          ts: baseTs + offsetSec * 1000,
          ts_iso: new Date(baseTs + offsetSec * 1000).toISOString(),
          session_id: sessionId,
          pid,
          turn,
          mechanism: "graph_query",
          tool: "t",
          tokens_without: without,
          tokens_with: without - saved,
          tokens_saved: saved,
          detail: null,
        });
      };

      insert("session-a", 100, 1, 100, 50, 0);
      insert("session-b", 200, 1, 200, 100, 1);
      insert("session-a", 100, 2, 300, 150, 2);

      const summaryA = aggregateSession(
        readTokenFlowEvents(unerrDir),
        "session-a"
      );
      const summaryB = aggregateSession(
        readTokenFlowEvents(unerrDir),
        "session-b"
      );

      expect(summaryA.total_tokens_saved).toBe(200);
      expect(summaryA.total_turns).toBe(2);
      expect(summaryB.total_tokens_saved).toBe(100);
      expect(summaryB.total_turns).toBe(1);
    });
  });

  // ── All Mechanism Types ───────────────────────────────────────────

  describe("all mechanism types", () => {
    it("handles all 7 mechanism types", () => {
      const writer = new TokenFlowWriter(unerrDir, "s1");
      const mechanisms = [
        "graph_query",
        "session_dedup",
        "shell_compression",
        "format_encoding",
        "smart_truncation",
        "file_read",
        "behavior_automation",
      ] as const;

      for (const [i, mechanism] of mechanisms.entries()) {
        writer.record(
          makeInput({
            session_id: "s1",
            turn: i + 1,
            mechanism,
            tokens_saved: (i + 1) * 100,
            tokens_without: (i + 1) * 200,
            tokens_with: (i + 1) * 100,
          })
        );
      }

      const summary = aggregateSession(writer.getSessionEvents(), "s1");
      expect(Object.keys(summary.by_mechanism)).toHaveLength(7);
      for (const mech of mechanisms) {
        expect(summary.by_mechanism[mech]).toBeDefined();
      }
    });
  });

  // ── Performance Smoke Test ────────────────────────────────────────

  describe("performance", () => {
    it("record() completes in under 1ms per write", () => {
      const writer = new TokenFlowWriter(unerrDir, "perf-test");
      const iterations = 100;

      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        writer.record(makeInput({ turn: i }));
      }
      const elapsed = performance.now() - start;

      const perWrite = elapsed / iterations;
      expect(perWrite).toBeLessThan(1);
    });

    it("aggregateSession handles 100 events in under 5ms", () => {
      const events: TokenFlowEvent[] = [];
      for (let i = 0; i < 100; i++) {
        events.push({
          id: i,
          ts: new Date().toISOString(),
          session_id: "s1",
          pid: 1,
          turn: Math.floor(i / 2) + 1,
          mechanism: i % 2 === 0 ? "graph_query" : "shell_compression",
          tool: i % 2 === 0 ? "get_callers" : null,
          tokens_without: 1000 + i * 10,
          tokens_with: 500 + i * 5,
          tokens_saved: 500 + i * 5,
        });
      }

      const start = performance.now();
      const summary = aggregateSession(events, "s1");
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5);
      expect(summary.total_turns).toBe(50);
    });
  });
});
