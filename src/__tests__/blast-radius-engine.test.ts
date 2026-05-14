/**
 * Sprint N.7-N.8: Blast radius accuracy + performance tests.
 */

import { describe, expect, it } from "vitest";
import {
  buildReverseAdjacency,
  computeBlastRadius,
  computeFileBlastRadius,
} from "../intelligence/blast-radius.js";
import { entityKey } from "../intelligence/indexer/entity-key.js";
import type {
  IndexedEdge,
  IndexedEntity,
} from "../intelligence/indexer/plugin-interface.js";

function makeEntity(
  name: string,
  filePath: string,
): IndexedEntity & { community: number; risk_level: string } {
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
    community: 0,
    risk_level: "normal",
  };
}

describe("Blast Radius Engine (N.1-N.5)", () => {
  it("returns all direct callers at hop=1", () => {
    const target = makeEntity("target", "src/core.ts");
    const callers = Array.from({ length: 10 }, (_, i) =>
      makeEntity(`caller${i}`, `src/caller${i}.ts`),
    );

    const entities = new Map<string, IndexedEntity & { community: number }>([
      [target.key, target],
      ...callers.map((c) => [c.key, c] as const),
    ]);

    const edges: IndexedEdge[] = callers.map((c) => ({
      from_key: c.key,
      to_key: target.key,
      type: "calls" as const,
      file_path: c.file_path,
      line: 1,
    }));

    const adj = buildReverseAdjacency(edges);
    const result = computeBlastRadius(target.key, entities, adj);

    expect(result.totalAffected).toBe(10);
    expect(result.hops.get(1)?.length).toBe(10);
  });

  it("traverses 3 hops transitively", () => {
    const a = makeEntity("a", "src/a.ts");
    const b = makeEntity("b", "src/b.ts");
    const c = makeEntity("c", "src/c.ts");
    const d = makeEntity("d", "src/d.ts");

    const entities = new Map([
      [a.key, a],
      [b.key, b],
      [c.key, c],
      [d.key, d],
    ]);

    const edges: IndexedEdge[] = [
      {
        from_key: b.key,
        to_key: a.key,
        type: "calls",
        file_path: "b.ts",
        line: 1,
      },
      {
        from_key: c.key,
        to_key: b.key,
        type: "calls",
        file_path: "c.ts",
        line: 1,
      },
      {
        from_key: d.key,
        to_key: c.key,
        type: "calls",
        file_path: "d.ts",
        line: 1,
      },
    ];

    const adj = buildReverseAdjacency(edges);
    const result = computeBlastRadius(a.key, entities, adj, { maxHops: 3 });

    expect(result.hops.get(1)?.length).toBe(1);
    expect(result.hops.get(2)?.length).toBe(1);
    expect(result.hops.get(3)?.length).toBe(1);
    expect(result.totalAffected).toBe(3);
  });

  it("generates suggestions for critical entities", () => {
    const target = makeEntity("hub", "src/hub.ts");
    const critical = {
      ...makeEntity("crit", "src/crit.ts"),
      risk_level: "critical",
    };

    const entities = new Map([
      [target.key, target],
      [critical.key, critical],
    ]);

    const edges: IndexedEdge[] = [
      {
        from_key: critical.key,
        to_key: target.key,
        type: "calls",
        file_path: "crit.ts",
        line: 1,
      },
    ];

    const adj = buildReverseAdjacency(edges);
    const result = computeBlastRadius(target.key, entities, adj);

    expect(result.riskSummary.critical).toBe(1);
    expect(
      result.suggestions.some(
        (s) => s.includes("overload") || s.includes("adapter"),
      ),
    ).toBe(true);
  });

  it("file-level blast radius returns entities in other files", () => {
    const internal1 = makeEntity("fn1", "src/target.ts");
    const internal2 = makeEntity("fn2", "src/target.ts");
    const external = makeEntity("caller", "src/other.ts");

    const entities = new Map([
      [internal1.key, internal1],
      [internal2.key, internal2],
      [external.key, external],
    ]);

    const edges: IndexedEdge[] = [
      {
        from_key: external.key,
        to_key: internal1.key,
        type: "calls",
        file_path: "other.ts",
        line: 1,
      },
    ];

    const adj = buildReverseAdjacency(edges);
    const result = computeFileBlastRadius("src/target.ts", entities, adj);

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles).toContain("src/other.ts");
    expect(result.affectedFiles).not.toContain("src/target.ts");
  });

  it("handles entity with no callers", () => {
    const target = makeEntity("isolated", "src/isolated.ts");
    const entities = new Map([[target.key, target]]);
    const adj = buildReverseAdjacency([]);

    const result = computeBlastRadius(target.key, entities, adj);
    expect(result.totalAffected).toBe(0);
    expect(result.hops.size).toBe(0);
  });

  it("respects maxResults limit", () => {
    const target = makeEntity("popular", "src/pop.ts");
    const callers = Array.from({ length: 600 }, (_, i) =>
      makeEntity(`c${i}`, `src/c${i}.ts`),
    );

    const entities = new Map([
      [target.key, target],
      ...callers.map((c) => [c.key, c] as const),
    ]);

    const edges: IndexedEdge[] = callers.map((c) => ({
      from_key: c.key,
      to_key: target.key,
      type: "calls" as const,
      file_path: c.file_path,
      line: 1,
    }));

    const adj = buildReverseAdjacency(edges);
    const result = computeBlastRadius(target.key, entities, adj, {
      maxResults: 100,
    });

    expect(result.totalAffected).toBeLessThanOrEqual(100);
  });

  it("completes in <5ms for large graphs", () => {
    const target = makeEntity("center", "src/center.ts");
    const allEntities = [target];
    const allEdges: IndexedEdge[] = [];

    for (let i = 0; i < 200; i++) {
      const hop1 = makeEntity(`h1_${i}`, `src/h1_${i}.ts`);
      allEntities.push(hop1);
      allEdges.push({
        from_key: hop1.key,
        to_key: target.key,
        type: "calls",
        file_path: hop1.file_path,
        line: 1,
      });

      for (let j = 0; j < 5; j++) {
        const hop2 = makeEntity(`h2_${i}_${j}`, `src/h2_${i}_${j}.ts`);
        allEntities.push(hop2);
        allEdges.push({
          from_key: hop2.key,
          to_key: hop1.key,
          type: "calls",
          file_path: hop2.file_path,
          line: 1,
        });
      }
    }

    const entities = new Map(allEntities.map((e) => [e.key, e]));
    const adj = buildReverseAdjacency(allEdges);

    const start = performance.now();
    const result = computeBlastRadius(target.key, entities, adj, {
      maxHops: 3,
    });
    const elapsed = performance.now() - start;

    expect(result.totalAffected).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(5);
  });
});
