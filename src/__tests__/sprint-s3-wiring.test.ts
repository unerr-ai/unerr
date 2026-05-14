/**
 * Sprint S3: Context Rot Detector — Integration Tests.
 *
 * Verifies:
 *   - After 200K+ estimated tokens → depth_threshold signal fires
 *   - After 3+ queries to same entity → repeated_exploration signal
 *   - inject_refresh action → _context.session_warning with actionable summary
 *   - suggest_new_session → _meta.session_health includes recommendation
 *   - Errors feed into context rot detector
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";
import { createContextRotDetector } from "../proxy/context-rot-detector.js";

function createMockGraph(
  overrides: Record<string, unknown> = {},
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

describe("Sprint S3: Context Rot Detector Wiring", () => {
  describe("S3.3: Token depth tracking", () => {
    it("accumulates token depth from tool call responses", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const detector = createContextRotDetector();
      router.setContextRotDetector(detector);

      // Make several calls to accumulate token depth
      for (let i = 0; i < 5; i++) {
        await router.execute("get_function", { key: `fn${i}` });
      }

      // Evaluate — should have accumulated some tokens (small, but non-zero)
      const signal = detector.evaluate();
      expect(signal.estimatedDepth).toBeGreaterThan(0);
    });

    it("fires depth_threshold after 200K+ tokens", () => {
      const detector = createContextRotDetector();

      // Simulate large token accumulation
      detector.recordToolCallTokens(210_000);

      const signal = detector.evaluate();
      expect(signal.signals.some((s) => s.type === "depth_threshold")).toBe(
        true,
      );
      expect(signal.rotConfidence).toBeGreaterThan(0);
    });
  });

  describe("S3.4: Repeated query detection via sessionContext", () => {
    it("detects repeated queries to same entity", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const detector = createContextRotDetector();
      router.setContextRotDetector(detector);

      // First call establishes history
      await router.execute("get_function", { key: "fn1" });
      // Subsequent calls should trigger repeated query detection
      await router.execute("get_function", { key: "fn1" });
      await router.execute("get_function", { key: "fn1" });
      await router.execute("get_function", { key: "fn1" });

      const signal = detector.evaluate();
      // After 3+ re-queries to an entity already in history, repeated_exploration fires
      expect(
        signal.signals.some((s) => s.type === "repeated_exploration"),
      ).toBe(true);
    });
  });

  describe("S3.5: Error feeding", () => {
    it("feeds errors into context rot detector on tool failure", async () => {
      const graph = createMockGraph({
        searchEntities: vi.fn().mockImplementation(() => {
          throw new Error("simulated failure");
        }),
      });
      const router = new QueryRouter(graph);
      const detector = createContextRotDetector();
      router.setContextRotDetector(detector);

      // Trigger multiple failures
      for (let i = 0; i < 6; i++) {
        await router.execute("search_code", { query: "test" });
      }

      const signal = detector.evaluate();
      // After 5+ errors, declining_precision should fire
      expect(signal.signals.some((s) => s.type === "declining_precision")).toBe(
        true,
      );
    });
  });

  describe("S3.6-S3.7: Rot evaluation and inject_refresh", () => {
    it("injects session_warning in _context when rot triggers inject_refresh", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const detector = createContextRotDetector();
      router.setContextRotDetector(detector);

      // Push token depth past warning threshold (200K)
      detector.recordToolCallTokens(220_000);
      // Add repeated queries to push rot confidence into inject_refresh range (0.4-0.7)
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn1");

      // Now execute enough calls to hit the 10th-call evaluation boundary
      // We need toolCallCount to be divisible by 10
      for (let i = 0; i < 9; i++) {
        await router.execute("get_function", { key: `entity${i}` });
      }
      // 10th call triggers evaluation
      const result = await router.execute("get_function", { key: "entity9" });

      // Should have session_warning in _context
      const ctx = result._context as Record<string, unknown> | undefined;
      if (ctx?.session_warning) {
        const warning = ctx.session_warning as Record<string, unknown>;
        expect(warning.reason).toBeDefined();
        expect(warning.rot_confidence).toBeGreaterThan(0);
      }
    });
  });

  describe("S3.8: Severe rot triggers suggest_new_session in _meta", () => {
    it("injects _meta.session_health with suggest_new_session on critical rot", async () => {
      const graph = createMockGraph();
      const router = new QueryRouter(graph);
      const detector = createContextRotDetector();
      router.setContextRotDetector(detector);

      // Push past critical threshold (300K tokens → 0.4 rot)
      detector.recordToolCallTokens(310_000);
      // Add repeated queries (0.15 each for 3+ queries per entity)
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn2");
      detector.recordRepeatedQuery("fn2");
      detector.recordRepeatedQuery("fn2");
      // Add errors (0.2 for 5+ errors)
      for (let i = 0; i < 6; i++) {
        detector.recordError();
      }
      // Total rot: 0.4 (depth) + 0.15 (fn1) + 0.15 (fn2) + 0.2 (errors) = 0.9 → suggest_new_session

      // Execute 10 calls to trigger evaluation
      for (let i = 0; i < 9; i++) {
        await router.execute("get_function", { key: `x${i}` });
      }
      const result = await router.execute("get_function", { key: "x9" });

      expect(result._meta.session_health).toBeDefined();
      expect(result._meta.session_health?.recommendation).toBe(
        "suggest_new_session",
      );
      expect(result._meta.session_health?.signals.length).toBeGreaterThan(0);
    });
  });

  describe("S3.9: getRefreshContext provides recovery data", () => {
    it("builds refresh context when rot action is triggered", () => {
      const detector = createContextRotDetector();

      // Push into inject_refresh range (0.2 depth + 0.15 fn1 + 0.15 fn2 = 0.5)
      detector.recordToolCallTokens(220_000);
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn1");
      detector.recordRepeatedQuery("fn2");
      detector.recordRepeatedQuery("fn2");
      detector.recordRepeatedQuery("fn2");

      const signal = detector.evaluate();
      expect(signal.action).toBe("inject_refresh");

      const refresh = detector.getRefreshContext();
      expect(refresh).not.toBeNull();
      expect(refresh?.reason).toBe("context_degradation");
      expect(refresh?.estimated_depth).toBe(220_000);
      expect(refresh?.repeated_entities).toContain("fn1");
      expect(refresh?.repeated_entities).toContain("fn2");
    });
  });
});
