// @ts-nocheck — test file
/**
 * GraphTemporalJoiner tests — co-change prediction, hidden coupling detection.
 */

import { describe, expect, it, vi } from "vitest";
import { GraphTemporalJoiner } from "../intelligence/graph-temporal-joiner.js";

function createMockGraph(
  fileEntities: Record<string, Array<{ key: string; file_path: string }>>,
  callerMap: Record<string, Array<{ key: string; file_path: string }>>,
  calleeMap: Record<string, Array<{ key: string; file_path: string }>>,
) {
  return {
    getEntitiesByFile: vi.fn((filePath: string) =>
      Promise.resolve(fileEntities[filePath] ?? []),
    ),
    getCallersOf: vi.fn((key: string) => Promise.resolve(callerMap[key] ?? [])),
    getCalleesOf: vi.fn((key: string) => Promise.resolve(calleeMap[key] ?? [])),
  };
}

function createMockFactStore(
  facts: Array<{
    fact_type: string;
    scope: string;
    subject: string;
    content: string;
    base_confidence: number;
  }>,
) {
  return {
    recallBySubject: vi.fn((subject: string) =>
      Promise.resolve(
        facts.filter(
          (f) => f.subject === subject || f.subject.startsWith(subject),
        ),
      ),
    ),
    recallByScope: vi.fn((scope: string) =>
      Promise.resolve(facts.filter((f) => f.scope === scope)),
    ),
  };
}

describe("GraphTemporalJoiner", () => {
  describe("predictCoChanges", () => {
    it("returns co-changes from graph structure only", async () => {
      const graph = createMockGraph(
        {
          "src/a.ts": [{ key: "fnA", file_path: "src/a.ts" }],
        },
        {
          fnA: [
            { key: "fnB", file_path: "src/b.ts" },
            { key: "fnC", file_path: "src/c.ts" },
          ],
        },
        { fnA: [] },
      );

      const joiner = new GraphTemporalJoiner(graph as any, null);
      const results = await joiner.predictCoChanges("src/a.ts");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].file_a).toBe("src/a.ts");
      expect(results[0].graph_coupling).toBeGreaterThan(0);
      expect(results[0].temporal_coupling).toBe(0);
      // With no temporal data, combined = 0.4 * graph
      expect(results[0].combined_score).toBeGreaterThan(0);
    });

    it("returns co-changes from temporal data only", async () => {
      const graph = createMockGraph({}, {}, {});
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/a.ts↔src/d.ts",
          content: "Files co-accessed in 5 sessions",
          base_confidence: 0.8,
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const results = await joiner.predictCoChanges("src/a.ts");

      // Temporal-only: combined = 0.6 * 0.8 = 0.48
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].file_b).toBe("src/d.ts");
      expect(results[0].temporal_coupling).toBe(0.8);
      expect(results[0].graph_coupling).toBe(0);
      expect(results[0].combined_score).toBeCloseTo(0.48, 1);
    });

    it("combines graph and temporal signals", async () => {
      const graph = createMockGraph(
        {
          "src/a.ts": [{ key: "fnA", file_path: "src/a.ts" }],
        },
        {
          fnA: [{ key: "fnB", file_path: "src/b.ts" }],
        },
        { fnA: [] },
      );
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/a.ts↔src/b.ts",
          content: "Files co-accessed in 3 sessions",
          base_confidence: 0.7,
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const results = await joiner.predictCoChanges("src/a.ts");

      expect(results.length).toBe(1);
      expect(results[0].file_b).toBe("src/b.ts");
      expect(results[0].graph_coupling).toBeGreaterThan(0);
      expect(results[0].temporal_coupling).toBe(0.7);
      // Combined should be > either alone
      expect(results[0].combined_score).toBeGreaterThan(
        0.6 * results[0].temporal_coupling,
      );
    });

    it("filters out low-score noise (< 0.1)", async () => {
      const graph = createMockGraph({}, {}, {});
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/a.ts↔src/noise.ts",
          content: "1 session",
          base_confidence: 0.05,
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const results = await joiner.predictCoChanges("src/a.ts");

      // 0.6 * 0.05 = 0.03 < 0.1 threshold
      expect(results).toHaveLength(0);
    });

    it("returns empty for files with no connections", async () => {
      const graph = createMockGraph({}, {}, {});
      const joiner = new GraphTemporalJoiner(graph as any, null);
      const results = await joiner.predictCoChanges("src/isolated.ts");
      expect(results).toHaveLength(0);
    });

    it("excludes self-references", async () => {
      const graph = createMockGraph(
        {
          "src/a.ts": [{ key: "fnA", file_path: "src/a.ts" }],
        },
        {
          fnA: [{ key: "fnA2", file_path: "src/a.ts" }],
        },
        { fnA: [] },
      );

      const joiner = new GraphTemporalJoiner(graph as any, null);
      const results = await joiner.predictCoChanges("src/a.ts");
      expect(results.every((r) => r.file_b !== "src/a.ts")).toBe(true);
    });

    it("sorts results by combined_score descending", async () => {
      const graph = createMockGraph(
        {
          "src/a.ts": [{ key: "fnA", file_path: "src/a.ts" }],
        },
        {
          fnA: [
            { key: "fnB", file_path: "src/b.ts" },
            { key: "fnC", file_path: "src/c.ts" },
          ],
        },
        {
          fnA: [{ key: "fnD", file_path: "src/b.ts" }],
        },
      );

      const joiner = new GraphTemporalJoiner(graph as any, null);
      const results = await joiner.predictCoChanges("src/a.ts");

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].combined_score).toBeGreaterThanOrEqual(
          results[i].combined_score,
        );
      }
    });
  });

  describe("detectHiddenCouplings", () => {
    it("detects files with temporal coupling but no graph edges", async () => {
      const graph = createMockGraph({}, {}, {});
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/config.ts↔src/deploy.ts",
          content: "Files co-accessed in 5 sessions",
          base_confidence: 0.8,
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const hidden = await joiner.detectHiddenCouplings();

      expect(hidden).toHaveLength(1);
      expect(hidden[0].file_a).toBe("src/config.ts");
      expect(hidden[0].file_b).toBe("src/deploy.ts");
      expect(hidden[0].temporal_coupling).toBe(0.8);
      expect(hidden[0].graph_coupling).toBeLessThan(0.1);
      expect(hidden[0].sessions_observed).toBe(5);
      expect(hidden[0].evidence).toContain("no import/call edges");
    });

    it("excludes files with structural connections", async () => {
      const graph = createMockGraph(
        {
          "src/a.ts": [{ key: "fnA", file_path: "src/a.ts" }],
        },
        { fnA: [{ key: "fnB", file_path: "src/b.ts" }] },
        { fnA: [] },
      );
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/a.ts↔src/b.ts",
          content: "Files co-accessed in 4 sessions",
          base_confidence: 0.7,
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const hidden = await joiner.detectHiddenCouplings();

      // src/a.ts → src/b.ts has a structural connection, so NOT hidden
      expect(hidden).toHaveLength(0);
    });

    it("ignores low-confidence temporal couplings", async () => {
      const graph = createMockGraph({}, {}, {});
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/x.ts↔src/y.ts",
          content: "1 session",
          base_confidence: 0.3, // Below 0.5 threshold
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const hidden = await joiner.detectHiddenCouplings();

      expect(hidden).toHaveLength(0);
    });

    it("returns empty when no fact store", async () => {
      const graph = createMockGraph({}, {}, {});
      const joiner = new GraphTemporalJoiner(graph as any, null);
      const hidden = await joiner.detectHiddenCouplings();
      expect(hidden).toHaveLength(0);
    });

    it("sorts by temporal_coupling descending", async () => {
      const graph = createMockGraph({}, {}, {});
      const factStore = createMockFactStore([
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/a.ts↔src/b.ts",
          content: "3 sessions",
          base_confidence: 0.6,
        },
        {
          fact_type: "semantic",
          scope: "project",
          subject: "coupling:src/c.ts↔src/d.ts",
          content: "7 sessions",
          base_confidence: 0.9,
        },
      ]);

      const joiner = new GraphTemporalJoiner(graph as any, factStore as any);
      const hidden = await joiner.detectHiddenCouplings();

      expect(hidden.length).toBe(2);
      expect(hidden[0].temporal_coupling).toBeGreaterThanOrEqual(
        hidden[1].temporal_coupling,
      );
    });
  });
});
