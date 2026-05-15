// @ts-nocheck — test file
/**
 * HealthMapData tests — health score computation and tree building.
 */

import { describe, expect, it, vi } from "vitest";
import { HealthMapData } from "../intelligence/health-map-data.js";

function createMockGraph(
  entities: Array<{
    key: string;
    kind: string;
    name: string;
    file_path: string;
    start_line: number;
    end_line: number;
    signature: string;
    body: string;
    fan_in: number;
    fan_out: number;
    risk_level: string;
    community: number;
  }> = [],
  conventions: Array<{ adherence_rate: number }> = []
) {
  return {
    getLocalProjectStats: vi.fn(() =>
      Promise.resolve({ entity_count: entities.length, edge_count: 0 })
    ),
    getCriticalNodes: vi.fn(() => Promise.resolve(entities)),
    getEntitiesByFile: vi.fn((filePath: string) =>
      Promise.resolve(entities.filter((e) => e.file_path === filePath))
    ),
    getConventions: vi.fn(() => Promise.resolve(conventions)),
  };
}

function createMockFactStore(
  projectFacts: Array<{
    fact_id: string;
    fact_type: string;
    subject: string;
    content: string;
    effective_confidence: number;
    source: string;
  }> = [],
  fileFacts: Array<{
    fact_id: string;
    fact_type: string;
    subject: string;
    content: string;
    effective_confidence: number;
  }> = []
) {
  return {
    recallByScope: vi.fn(() => Promise.resolve(projectFacts)),
    recallForFile: vi.fn(() => Promise.resolve(fileFacts)),
  };
}

const ENTITY_A = {
  key: "src/a.ts::funcA",
  kind: "function",
  name: "funcA",
  file_path: "src/a.ts",
  start_line: 1,
  end_line: 10,
  signature: "function funcA()",
  body: "",
  fan_in: 5,
  fan_out: 3,
  risk_level: "medium",
  community: 0,
};

const ENTITY_B = {
  key: "src/b.ts::funcB",
  kind: "function",
  name: "funcB",
  file_path: "src/b.ts",
  start_line: 1,
  end_line: 20,
  signature: "function funcB()",
  body: "",
  fan_in: 2,
  fan_out: 1,
  risk_level: "low",
  community: 0,
};

const ENTITY_C = {
  key: "src/a.ts::funcC",
  kind: "function",
  name: "funcC",
  file_path: "src/a.ts",
  start_line: 12,
  end_line: 25,
  signature: "function funcC()",
  body: "",
  fan_in: 15,
  fan_out: 10,
  risk_level: "high",
  community: 1,
};

describe("HealthMapData", () => {
  describe("buildTree", () => {
    it("returns a root node with children grouped by directory", async () => {
      const graph = createMockGraph([ENTITY_A, ENTITY_B, ENTITY_C]);
      const healthMap = new HealthMapData(graph as any, null);
      const tree = await healthMap.buildTree();

      expect(tree.path).toBe(".");
      expect(tree.children).toBeDefined();
      expect(tree.children!.length).toBeGreaterThan(0);
      expect(tree.entity_count).toBe(3);
    });

    it("computes health scores between 0 and 1", async () => {
      const graph = createMockGraph([ENTITY_A, ENTITY_B]);
      const healthMap = new HealthMapData(graph as any, null);
      const tree = await healthMap.buildTree();

      expect(tree.health_score).toBeGreaterThanOrEqual(0);
      expect(tree.health_score).toBeLessThanOrEqual(1);
    });

    it("assigns risk levels based on health score", async () => {
      const graph = createMockGraph([ENTITY_A]);
      const healthMap = new HealthMapData(graph as any, null);
      const tree = await healthMap.buildTree();

      expect(["low", "medium", "high", "critical"]).toContain(tree.risk_level);
    });

    it("includes coupling counts from fact store", async () => {
      const graph = createMockGraph([ENTITY_A, ENTITY_B]);
      const factStore = createMockFactStore([
        {
          fact_id: "1",
          fact_type: "semantic",
          subject: "coupling:src/a.ts↔src/b.ts",
          content: "Often changed together",
          effective_confidence: 0.7,
          source: "session_analysis",
        },
      ]);
      const healthMap = new HealthMapData(graph as any, factStore);
      const tree = await healthMap.buildTree();

      // Both files should have coupling_count >= 1
      const srcDir = tree.children?.find((c) => c.name === "src");
      expect(srcDir).toBeDefined();
      expect(srcDir!.metrics.coupling_count).toBeGreaterThanOrEqual(1);
    });

    it("filters by rootPath when provided", async () => {
      const graph = createMockGraph([
        ENTITY_A,
        { ...ENTITY_B, file_path: "lib/b.ts", key: "lib/b.ts::funcB" },
      ]);
      const healthMap = new HealthMapData(graph as any, null);
      const tree = await healthMap.buildTree("src");

      expect(tree.entity_count).toBe(1);
    });

    it("handles empty graph gracefully", async () => {
      const graph = createMockGraph([]);
      const healthMap = new HealthMapData(graph as any, null);
      const tree = await healthMap.buildTree();

      expect(tree.entity_count).toBe(0);
      expect(tree.children).toEqual([]);
    });

    it("high risk entities lower the health score", async () => {
      const graph1 = createMockGraph([ENTITY_B]); // low risk
      const graph2 = createMockGraph([ENTITY_C]); // high risk

      const map1 = new HealthMapData(graph1 as any, null);
      const map2 = new HealthMapData(graph2 as any, null);

      const tree1 = await map1.buildTree();
      const tree2 = await map2.buildTree();

      expect(tree1.health_score).toBeGreaterThan(tree2.health_score);
    });
  });

  describe("getFileHealth", () => {
    it("returns health for a specific file", async () => {
      const graph = createMockGraph([ENTITY_A, ENTITY_C]);
      const healthMap = new HealthMapData(graph as any, null);
      const result = await healthMap.getFileHealth("src/a.ts");

      expect(result).not.toBeNull();
      expect(result!.path).toBe("src/a.ts");
      expect(result!.entity_count).toBe(2);
      expect(result!.health_score).toBeGreaterThanOrEqual(0);
      expect(result!.health_score).toBeLessThanOrEqual(1);
    });

    it("returns null for unknown file", async () => {
      const graph = createMockGraph([ENTITY_A]);
      const healthMap = new HealthMapData(graph as any, null);
      const result = await healthMap.getFileHealth("src/unknown.ts");

      expect(result).toBeNull();
    });

    it("includes change frequency from episodic facts", async () => {
      const graph = createMockGraph([ENTITY_A]);
      const factStore = createMockFactStore(
        [],
        [
          {
            fact_id: "1",
            fact_type: "episodic",
            subject: "src/a.ts",
            content: "Modified",
            effective_confidence: 0.8,
          },
          {
            fact_id: "2",
            fact_type: "episodic",
            subject: "src/a.ts",
            content: "Modified again",
            effective_confidence: 0.7,
          },
        ]
      );
      const healthMap = new HealthMapData(graph as any, factStore);
      const result = await healthMap.getFileHealth("src/a.ts");

      expect(result).not.toBeNull();
      expect(result!.metrics.change_frequency).toBe(2);
    });
  });
});
