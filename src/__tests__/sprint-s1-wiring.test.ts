/**
 * Sprint S1: Output Compression & Quality Loop — Integration Tests.
 *
 * Verifies:
 *   - Large text output (>2K tokens) is automatically compressed
 *   - Session dedup filters repeated _context keys for same entity
 *   - Quality monitor adapts retention on retry spikes
 *   - Budget enforcer caps total response size
 *   - Retry detection feeds into quality monitor
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";
import { createCompressionQualityMonitor } from "../proxy/compression-quality-monitor.js";
import { createSessionDedup } from "../proxy/session-dedup.js";

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

describe("Sprint S1: Output Compression Wiring", () => {
  describe("S1.5: Compression triggered on large text output", () => {
    it("compresses large string results exceeding 2K tokens", async () => {
      // search_code returning a large string simulates a tool that returns raw text
      const largeText = "line of code here\n".repeat(2000); // ~8K tokens
      const graph = createMockGraph({
        searchEntities: vi.fn().mockReturnValue(largeText),
      });

      const router = new QueryRouter(graph);
      const monitor = createCompressionQualityMonitor();
      router.setCompressionMonitor(monitor);

      const result = await router.execute("search_code", { query: "test" });

      // The content should be compressed (shorter than original)
      const contentStr =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);
      expect(contentStr.length).toBeLessThan(largeText.length);
    });

    it("does not compress output under 2K tokens", async () => {
      const shortText = "function foo() { return 42; }";
      const graph = createMockGraph({
        searchEntities: vi.fn().mockReturnValue(shortText),
      });

      const router = new QueryRouter(graph);
      const result = await router.execute("search_code", { query: "foo" });

      // Short output passes through unchanged
      expect(result.content).toBe(shortText);
    });

    it("does not compress structured object results", async () => {
      const graph = createMockGraph();
      // get_function returns an entity object via resolveEntityWithOverlay
      const router = new QueryRouter(graph);
      const result = await router.execute("get_function", { key: "fn1" });

      // Structured objects pass through — no string compression
      expect(typeof result.content).toBe("object");
    });
  });

  // S1.4 checked `_context.blast_radius` as a direct field. After the
  // Three-Layer Experience System rollout (Sprint 8/9), that field was
  // replaced by `_context.signals[]`. Session dedup still works — it now
  // dedups individual signals — but the wire shape changed. Coverage
  // continues in signal-scorer.test.ts (dedup branch).

  describe.skip("S1.4: Session dedup filters repeated _context (deprecated — see signal-scorer.test.ts)", () => {
    it("first call for entity delivers blast_radius in _context", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const dedup = createSessionDedup();
      router.setSessionDedup(dedup);

      const r1 = await router.execute("get_function", { key: "fn1" });
      // First call should have blast_radius in _context
      expect(r1._context?.blast_radius).toBeDefined();
    });

    it("second call for same entity does not repeat blast_radius", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const dedup = createSessionDedup();
      router.setSessionDedup(dedup);

      // First call delivers blast_radius
      await router.execute("get_function", { key: "fn1" });

      // Second call — SessionContext already deduplicates via shouldInjectBlastRadius
      // AND session dedup filters any remaining repeated keys
      const r2 = await router.execute("get_function", { key: "fn1" });
      if (r2._context) {
        expect(r2._context.blast_radius).toBeUndefined();
      }
    });

    it("different entities get independent context delivery", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const dedup = createSessionDedup();
      router.setSessionDedup(dedup);

      await router.execute("get_function", { key: "fn1" });
      const r2 = await router.execute("get_function", { key: "fn2" });
      // fn2 is a fresh entity — should get blast_radius
      expect(r2._context?.blast_radius).toBeDefined();
    });
  });

  describe("S1.7-S1.9: Quality monitor integration", () => {
    it("feeds compression events into quality monitor on large output", async () => {
      const largeText = "error: test failure\n".repeat(2000);
      const graph = createMockGraph({
        searchEntities: vi.fn().mockReturnValue(largeText),
      });

      const router = new QueryRouter(graph);
      const monitor = createCompressionQualityMonitor();
      router.setCompressionMonitor(monitor);

      await router.execute("search_code", { query: "test" });

      // Adaptive config reflects the compression event was recorded
      const config = monitor.getAdaptiveConfig();
      expect(config).toBeDefined();
      expect(config.confidence).toBeGreaterThanOrEqual(0);
    });

    it("increases retention after repeated over-compression signals", () => {
      const monitor = createCompressionQualityMonitor();
      const initialRetention = monitor.getRetention("generic");

      // Simulate 3 compression + retry cycles (over-compression)
      for (let i = 0; i < 3; i++) {
        monitor.recordCompression(`c${i}`, "generic", 0.5);
        monitor.recordAgentAction(`entity-${i}`, true, false);
      }

      const adaptedRetention = monitor.getRetention("generic");
      expect(adaptedRetention).toBeGreaterThan(initialRetention);
    });

    it("reduces retention cautiously after 10+ successful compressions", () => {
      const monitor = createCompressionQualityMonitor();

      // First force retention up
      for (let i = 0; i < 3; i++) {
        monitor.recordCompression(`up${i}`, "generic", 0.5);
        monitor.recordAgentAction(`e${i}`, true, false);
      }
      const highRetention = monitor.getRetention("generic");

      // Then 10 good compressions
      for (let i = 0; i < 10; i++) {
        monitor.recordCompression(`good${i}`, "generic", 0.7);
        monitor.recordAgentAction(`g${i}`, false, false);
      }

      const loweredRetention = monitor.getRetention("generic");
      expect(loweredRetention).toBeLessThanOrEqual(highRetention);
    });
  });

  describe("S1.8: Retry detection in enrichResult", () => {
    it("detects retry when same entity queried within 60s", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const monitor = createCompressionQualityMonitor();
      router.setCompressionMonitor(monitor);

      // We need a compression event first for the monitor to register retries
      // Simulate by querying a tool that returns large text (triggers compression)
      const largeText = "content\n".repeat(2000);
      (graph as any).searchEntities = vi.fn().mockReturnValue(largeText);
      await router.execute("search_code", { query: "a" });

      // Now query an enrichable tool twice within 60s
      await router.execute("get_function", { key: "fn1" });
      await router.execute("get_function", { key: "fn1" });

      // The second query should trigger retry detection
      // which feeds into the monitor (if there was a recent compression)
      expect(monitor.getSignalCount()).toBeGreaterThan(0);
    });
  });

  describe("S1.10: Budget enforcer as final cap", () => {
    it("caps extremely large multi-line output to within budget", async () => {
      // Real-world content has newlines — budget enforcer splits by line
      const hugeText = Array.from(
        { length: 5000 },
        (_, i) =>
          `line ${i}: some content that takes up space in the output buffer`
      ).join("\n"); // ~5000 lines, ~300K chars, ~75K tokens
      const graph = createMockGraph({
        searchEntities: vi.fn().mockReturnValue(hugeText),
      });

      const router = new QueryRouter(graph);
      const monitor = createCompressionQualityMonitor();
      router.setCompressionMonitor(monitor);

      const result = await router.execute("search_code", { query: "line" });
      const contentStr =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);

      // Budget enforcer ensures content stays well under original size
      // 4K tokens ≈ 16K chars — allow some overhead from markers
      expect(contentStr.length).toBeLessThan(hugeText.length * 0.3);
    });
  });
});
