import { describe, expect, it } from "vitest";
import type { IndexedEdge } from "../intelligence/indexer/plugin-interface.js";
import {
  classifyAllRisks,
  classifyRisk,
  detectBridges,
} from "../intelligence/risk-classifier.js";

describe("Risk Classifier (M.4)", () => {
  it("classifies high fan-in entity as critical", () => {
    const result = classifyRisk("hub", 60, false, false, false);
    expect(result.level).toBe("critical");
    expect(result.score).toBeGreaterThanOrEqual(35);
    expect(result.reasoning).toContain("chokepoint");
  });

  it("classifies bridge entity with elevated risk", () => {
    const result = classifyRisk("bridge", 10, true, false, false);
    expect(["high", "medium"]).toContain(result.level);
    expect(result.reasoning).toContain("bridges");
  });

  it("classifies entity with mutations as higher risk", () => {
    const result = classifyRisk("mutator", 5, false, true, false);
    expect(result.score).toBeGreaterThan(
      classifyRisk("pure", 5, false, false, false).score,
    );
  });

  it("reduces risk when entity is guarded", () => {
    const unguarded = classifyRisk("fn", 30, false, false, false);
    const guarded = classifyRisk("fn", 30, false, false, true);
    expect(guarded.score).toBeLessThanOrEqual(unguarded.score);
  });

  it("classifies low-risk entity as low", () => {
    const result = classifyRisk("simple", 2, false, false, false);
    expect(result.level).toBe("low");
    expect(result.score).toBeLessThan(25);
  });

  it("fan-in of 20+ triggers high classification", () => {
    const result = classifyRisk("busy", 25, false, false, false);
    expect(["high", "medium"]).toContain(result.level);
    expect(result.reasoning).toContain("callers");
  });

  it("combines multiple factors", () => {
    const result = classifyRisk("dangerous", 40, true, true, false);
    expect(result.level).toBe("critical");
    expect(result.factors.fanIn).toBeGreaterThan(0);
    expect(result.factors.bridgeScore).toBeGreaterThan(0);
    expect(result.factors.mutationScore).toBeGreaterThan(0);
  });
});

describe("Bridge Detection (M.4)", () => {
  it("detects entity bridging two communities", () => {
    const edges: IndexedEdge[] = [
      {
        from_key: "bridge",
        to_key: "a",
        type: "calls",
        file_path: "f.ts",
        line: 1,
      },
      {
        from_key: "bridge",
        to_key: "b",
        type: "calls",
        file_path: "f.ts",
        line: 2,
      },
    ];
    const assignments = new Map([
      ["bridge", 0],
      ["a", 0],
      ["b", 1],
    ]);

    expect(detectBridges("bridge", edges, assignments)).toBe(true);
  });

  it("non-bridge entity returns false", () => {
    const edges: IndexedEdge[] = [
      {
        from_key: "local",
        to_key: "neighbor",
        type: "calls",
        file_path: "f.ts",
        line: 1,
      },
    ];
    const assignments = new Map([
      ["local", 0],
      ["neighbor", 0],
    ]);

    expect(detectBridges("local", edges, assignments)).toBe(false);
  });
});

describe("Batch Risk Classification", () => {
  it("classifies all entities", () => {
    const entities = [{ key: "a" }, { key: "b" }, { key: "c" }];
    const fanInMap = new Map([
      ["a", 50],
      ["b", 5],
      ["c", 0],
    ]);
    const edges: IndexedEdge[] = [];
    const assignments = new Map<string, number>();
    const mutations = new Set(["b"]);
    const guarded = new Set(["c"]);

    const results = classifyAllRisks(
      entities,
      fanInMap,
      edges,
      assignments,
      mutations,
      guarded,
    );
    expect(results).toHaveLength(3);
    expect(results[0]?.level).toBe("critical");
    expect(results[1]?.factors.mutationScore).toBeGreaterThan(0);
  });
});
