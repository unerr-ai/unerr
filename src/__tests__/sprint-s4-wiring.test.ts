/**
 * Sprint S4: Token Accounting & Visibility — Integration Tests.
 *
 * Verifies:
 *   - TokenCounter accumulates totals and emits at configurable interval
 *   - EfficiencyTracker accumulates session totals
 *   - Session summary displays: total tokens saved, dollar savings, efficiency %
 *
 * NOTE: Tests no longer use estimateExplorationCost — counterfactual savings
 * estimates were removed. Tokens_saved now comes from real-measurement sources
 * (file_read, fetch_url, shell_compression) recorded via TokenFlowWriter.
 * PREVENT-class events (graph queries, behaviors) are tracked via
 * BehaviorEventWriter as named counters, not synthetic savings.
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";
import { createEfficiencyTracker } from "../proxy/efficiency-tracker.js";
import { calculateDollarSavings } from "../proxy/model-pricing.js";
import { createTokenCounter } from "../proxy/token-counter.js";

function createMockGraph(
  overrides: Record<string, unknown> = {}
): CozoGraphStore {
  return {
    getEntity: vi.fn().mockReturnValue({
      key: "fn1",
      name: "fn1",
      kind: "function",
      file_path: "src/main.ts",
      risk_level: "normal",
    }),
    getBlastRadius: vi.fn().mockReturnValue({
      direct_callers: 5,
      direct_callees: 2,
      transitive_count: 10,
      is_chokepoint: false,
      summary: "5 callers, 10 transitive dependents",
    }),
    getBlastRadiusEntities: vi.fn().mockReturnValue(["caller1", "caller2"]),
    getConventionsForEntity: vi.fn().mockReturnValue([]),
    getCorrections: vi.fn().mockReturnValue([]),
    getCommunityForEntity: vi.fn().mockReturnValue(null),
    getCrossCommunityEdges: vi.fn().mockReturnValue([]),
    getEntitiesByFile: vi.fn().mockReturnValue([]),
    queryEntities: vi.fn().mockReturnValue([]),
    searchEntities: vi.fn().mockReturnValue([]),
    getDriftOverlayEntity: vi.fn().mockReturnValue(null),
    getDriftSummary: vi
      .fn()
      .mockReturnValue({ added: 0, modified: 0, removed: 0, total: 0 }),
    getCriticalNodes: vi.fn().mockReturnValue([]),
    getCrossBoundaryLinks: vi.fn().mockReturnValue([]),
    getCallers: vi.fn().mockReturnValue([]),
    getCallersOf: vi.fn().mockReturnValue([]),
    getCalleesOf: vi.fn().mockReturnValue([]),
    getCallees: vi.fn().mockReturnValue([]),
    getImports: vi.fn().mockReturnValue([]),
    getRules: vi.fn().mockReturnValue([]),
    getJustificationsForEntity: vi.fn().mockReturnValue([]),
    getDriftEntitiesForFile: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    ...overrides,
  } as unknown as CozoGraphStore;
}

describe("Sprint S4: Token Accounting & Visibility Wiring", () => {
  describe("S4.2: Efficiency tracker exposed via router", () => {
    it("returns null when no efficiency tracker set", () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      expect(router.getEfficiencySnapshot()).toBeNull();
    });

    it("getEfficiencySnapshot returns a snapshot when tracker is wired", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const efficiencyTracker = createEfficiencyTracker();
      router.setEfficiencyTracker(efficiencyTracker);

      await router.execute("get_function", { key: "fn1" });

      // The tracker is fed by TokenFlowWriter (COMPRESS-class real
      // measurements), wired in proxy.ts — not by router.execute
      // directly. Graph queries are PREVENT-class behavior events with
      // no byte savings, so they don't feed the efficiency tracker.
      const snap = router.getEfficiencySnapshot();
      expect(snap).not.toBeNull();
    });
  });

  describe("S4.5: Stderr live counter at configurable interval", () => {
    it("emits to stderr every Nth response when savings are recorded", () => {
      const messages: string[] = [];
      const tokenCounter = createTokenCounter({
        emitEveryN: 5,
        sink: (msg) => messages.push(msg),
      });

      // Counter operates independently of the data source — simulate
      // recorded savings directly (real source: TokenFlowWriter +
      // BehaviorEventWriter, exercised in proxy integration tests).
      for (let i = 0; i < 5; i++) {
        tokenCounter.record(100, 150);
      }

      expect(messages.length).toBe(1);
      expect(messages[0]).toContain("[unerr]");
      expect(messages[0]).toContain("tokens saved");
      expect(messages[0]).toContain("efficiency");
    });

    it("does not emit before reaching the interval", () => {
      const messages: string[] = [];
      const tokenCounter = createTokenCounter({
        emitEveryN: 5,
        sink: (msg) => messages.push(msg),
      });

      for (let i = 0; i < 4; i++) {
        tokenCounter.record(100, 150);
      }

      expect(messages.length).toBe(0);
    });
  });

  describe("S4: Model pricing calculations", () => {
    it("calculateDollarSavings returns positive value for saved tokens", () => {
      const savings = calculateDollarSavings(10_000);
      // Default model is Sonnet 4 at $3/M input tokens
      // 10K tokens × $3/M = $0.03
      expect(savings).toBeCloseTo(0.03, 4);
    });

    it("calculateDollarSavings respects model selection", () => {
      const sonnet = calculateDollarSavings(10_000, "claude-sonnet-4-20250514");
      const opus = calculateDollarSavings(10_000, "claude-opus-4-20250514");
      // Opus is 5x more expensive than Sonnet
      expect(opus).toBeGreaterThan(sonnet);
      expect(opus).toBeCloseTo(0.15, 4);
    });
  });
});
