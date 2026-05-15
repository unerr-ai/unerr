import { describe, expect, it } from "vitest";
import {
  analyzeFanInDistribution,
  computeHealthGrade,
  computeTestCoverageProxy,
  detectCircularDeps,
  measureImportDepth,
} from "../intelligence/health-grader.js";
import { entityKey } from "../intelligence/indexer/entity-key.js";
import type {
  IndexedEdge,
  IndexedEntity,
} from "../intelligence/indexer/plugin-interface.js";

function makeEntity(name: string, filePath: string): IndexedEntity {
  return {
    key: entityKey(filePath, "function", name, ""),
    kind: "function",
    name,
    file_path: filePath,
    start_line: 1,
    end_line: 5,
    signature: `${name}()`,
    body_hash: "h",
    exported: true,
    parent_key: null,
    language: "typescript",
    is_async: false,
    parameter_count: 0,
    doc: null,
  };
}

describe("Health Grading (O.1-O.5)", () => {
  it("detects circular dependencies", () => {
    const edges: IndexedEdge[] = [
      { from_key: "a", to_key: "b", type: "calls", file_path: "f.ts", line: 1 },
      { from_key: "b", to_key: "c", type: "calls", file_path: "f.ts", line: 2 },
      { from_key: "c", to_key: "a", type: "calls", file_path: "f.ts", line: 3 },
    ];
    const cycles = detectCircularDeps(edges);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });

  it("no cycles in acyclic graph", () => {
    const edges: IndexedEdge[] = [
      { from_key: "a", to_key: "b", type: "calls", file_path: "f.ts", line: 1 },
      { from_key: "b", to_key: "c", type: "calls", file_path: "f.ts", line: 2 },
    ];
    const cycles = detectCircularDeps(edges);
    expect(cycles).toHaveLength(0);
  });

  it("analyzes fan-in distribution", () => {
    const edges: IndexedEdge[] = Array.from({ length: 50 }, (_, i) => ({
      from_key: `caller${i}`,
      to_key: "hub",
      type: "calls" as const,
      file_path: "f.ts",
      line: i,
    }));
    const analysis = analyzeFanInDistribution(edges);
    expect(analysis.maxFanIn).toBe(50);
    expect(analysis.avgFanIn).toBe(50);
  });

  it("measures import depth", () => {
    const edges: IndexedEdge[] = [
      {
        from_key: "a",
        to_key: "b",
        type: "imports",
        file_path: "a.ts",
        line: 1,
      },
      {
        from_key: "b",
        to_key: "c",
        type: "imports",
        file_path: "b.ts",
        line: 1,
      },
      {
        from_key: "c",
        to_key: "d",
        type: "imports",
        file_path: "c.ts",
        line: 1,
      },
    ];
    const depth = measureImportDepth(edges);
    expect(depth).toBe(3);
  });

  it("computes test coverage proxy", () => {
    const entities = [
      makeEntity("fn", "src/auth.ts"),
      makeEntity("test", "src/__tests__/auth.test.ts"),
    ];
    const ratio = computeTestCoverageProxy(entities);
    expect(ratio).toBe(1.0);
  });

  it("computes composite health grade", () => {
    const entities = Array.from({ length: 20 }, (_, i) =>
      makeEntity(`fn${i}`, `src/f${i}.ts`)
    );
    const edges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "f.ts",
        line: 1,
      },
    ];
    const report = computeHealthGrade(entities, edges);
    expect(["A", "B", "C", "D", "F"]).toContain(report.grade);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.factors).toHaveLength(5);
  });

  it("circular deps penalize health grade", () => {
    const entities = [
      makeEntity("a", "a.ts"),
      makeEntity("b", "b.ts"),
      makeEntity("c", "c.ts"),
    ];
    const cycleEdges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 1,
      },
      {
        from_key: entities[1]!.key,
        to_key: entities[2]!.key,
        type: "calls",
        file_path: "b.ts",
        line: 1,
      },
      {
        from_key: entities[2]!.key,
        to_key: entities[0]!.key,
        type: "calls",
        file_path: "c.ts",
        line: 1,
      },
    ];
    const withCycles = computeHealthGrade(entities, cycleEdges);
    const noCycles = computeHealthGrade(entities, []);
    expect(withCycles.score).toBeLessThan(noCycles.score);
    expect(withCycles.circularDeps.length).toBeGreaterThan(0);
  });
});
