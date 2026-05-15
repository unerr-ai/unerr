/**
 * Sprint S4: Token Accounting & Visibility — Integration Tests.
 *
 * Verifies:
 *   - Every MCP response includes _meta.tokens_saved (combined sources)
 *   - Every MCP response includes _meta.dollar_savings (model-priced)
 *   - TokenCounter emits to stderr at configurable interval (default: every 5th)
 *   - EfficiencyTracker accumulates session totals
 *   - Session summary displays: total tokens saved, dollar savings, efficiency %
 */

import { describe, expect, it, vi } from "vitest";
import { createExplorationAccumulator } from "../intelligence/exploration-cost.js";
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
  describe("S4.1+S4.3: Combined tokens_saved on every response", () => {
    it("tracks tokens saved from exploration cost (internal accumulator)", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const tokenCounter = createTokenCounter({ emitEveryN: 10 });
      const efficiencyTracker = createEfficiencyTracker();
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);
      router.setEfficiencyTracker(efficiencyTracker);

      await router.execute("get_function", { key: "fn1" });

      // Vanity wire fields stripped; verify via internal counter.
      expect(tokenCounter.getTotalSaved()).toBeGreaterThan(0);
    });

    it("feeds savings into token counter and efficiency tracker", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const tokenCounter = createTokenCounter({ emitEveryN: 100 });
      const efficiencyTracker = createEfficiencyTracker();
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);
      router.setEfficiencyTracker(efficiencyTracker);

      await router.execute("get_function", { key: "fn1" });
      await router.execute("get_function", { key: "fn2" });

      expect(tokenCounter.getTotalSaved()).toBeGreaterThan(0);
      expect(tokenCounter.getCallCount()).toBe(2);
      expect(efficiencyTracker.getSavedTokens()).toBeGreaterThan(0);
    });
  });

  describe("S4.4: Dollar savings tracked internally", () => {
    it("derivable from token counter via model pricing", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const tokenCounter = createTokenCounter({ emitEveryN: 100 });
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);

      await router.execute("get_function", { key: "fn1" });

      // Dollar savings stripped from wire to reduce metadata overhead;
      // dashboard derives them from the internal token counter.
      const tokensSaved = tokenCounter.getTotalSaved();
      expect(tokensSaved).toBeGreaterThan(0);
      const dollars = calculateDollarSavings(tokensSaved);
      expect(dollars).toBeGreaterThan(0);
    });
  });

  describe("S4.5: Stderr live counter at configurable interval", () => {
    it("emits to stderr every Nth response (default: 5)", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const messages: string[] = [];
      const tokenCounter = createTokenCounter({
        emitEveryN: 5,
        sink: (msg) => messages.push(msg),
      });
      const efficiencyTracker = createEfficiencyTracker();
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);
      router.setEfficiencyTracker(efficiencyTracker);

      // Make 5 calls to trigger the first emission
      for (let i = 0; i < 5; i++) {
        await router.execute("get_function", { key: `fn${i}` });
      }

      expect(messages.length).toBe(1);
      expect(messages[0]).toContain("[unerr]");
      expect(messages[0]).toContain("tokens saved");
      expect(messages[0]).toContain("efficiency");
    });

    it("does not emit before reaching the interval", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const messages: string[] = [];
      const tokenCounter = createTokenCounter({
        emitEveryN: 5,
        sink: (msg) => messages.push(msg),
      });
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);

      // Make 4 calls — should NOT emit
      for (let i = 0; i < 4; i++) {
        await router.execute("get_function", { key: `fn${i}` });
      }

      expect(messages.length).toBe(0);
    });
  });

  describe("S4.2: Efficiency tracker session totals", () => {
    it("getEfficiencySnapshot returns cumulative data", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const tokenCounter = createTokenCounter({ emitEveryN: 100 });
      const efficiencyTracker = createEfficiencyTracker();
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);
      router.setEfficiencyTracker(efficiencyTracker);

      await router.execute("get_function", { key: "fn1" });
      await router.execute("get_function", { key: "fn2" });
      await router.execute("search_code", { query: "test" });

      const snap = router.getEfficiencySnapshot();
      expect(snap).not.toBeNull();
      expect(snap?.totalCalls).toBe(3);
      expect(snap?.savedTokens).toBeGreaterThan(0);
      expect(snap?.efficiency).toBeGreaterThan(0);
      expect(snap?.efficiency).toBeLessThanOrEqual(100);
    });

    it("returns null when no efficiency tracker set", () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      expect(router.getEfficiencySnapshot()).toBeNull();
    });
  });

  describe("S4.6+S4.7: Session summary data", () => {
    it("token counter provides formatted summary data", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const accumulator = createExplorationAccumulator();
      const tokenCounter = createTokenCounter({ emitEveryN: 100 });
      const efficiencyTracker = createEfficiencyTracker();
      router.setExplorationAccumulator(accumulator);
      router.setTokenCounter(tokenCounter);
      router.setEfficiencyTracker(efficiencyTracker);

      for (let i = 0; i < 10; i++) {
        await router.execute("get_function", { key: `fn${i}` });
      }

      // Token counter provides totals for session summary
      expect(tokenCounter.getTotalSaved()).toBeGreaterThan(0);
      expect(tokenCounter.getTotalProcessed()).toBeGreaterThan(0);
      expect(tokenCounter.getEfficiency()).toBeGreaterThan(0);

      // Efficiency tracker provides snapshot for session card
      const snap = efficiencyTracker.getSnapshot();
      expect(snap.totalCalls).toBe(10);
      expect(snap.savedTokens).toBeGreaterThan(0);
      expect(snap.avgSavingsPerCall).toBeGreaterThan(0);
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
