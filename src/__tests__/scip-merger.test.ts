import { describe, expect, it } from "vitest";
import type { IndexedEdge } from "../intelligence/indexer/plugin-interface.js";
import type { ScipDecodeResult } from "../intelligence/indexer/scip/decoder.js";
import {
  applyScipFallback,
  classifyScipError,
} from "../intelligence/indexer/scip/fallback.js";
import {
  type EnrichedEdge,
  mergeScipResults,
} from "../intelligence/indexer/scip/merger.js";

describe("SCIP Merger (L2.4)", () => {
  it("upgrades edges when SCIP evidence exists", () => {
    const edges: IndexedEdge[] = [
      {
        from_key: "a",
        to_key: "b",
        type: "calls",
        file_path: "src/main.ts",
        line: 10,
      },
      {
        from_key: "c",
        to_key: "d",
        type: "calls",
        file_path: "src/utils.ts",
        line: 20,
      },
    ];

    const scipResult: ScipDecodeResult = {
      documents: [
        {
          relativePath: "src/main.ts",
          symbols: [
            {
              symbol: "scip-typescript npm test 0.1.0 src/`main.ts`/b.",
              filePath: "src/main.ts",
              line: 10,
              isDefinition: true,
            },
          ],
        },
      ],
      symbolCount: 1,
      definitionCount: 1,
      referenceCount: 0,
      durationMs: 100,
    };

    // Provide entity info so merger can match by (name, file_path)
    const entities = [
      { key: "b", name: "b", file_path: "src/main.ts" },
      { key: "d", name: "d", file_path: "src/utils.ts" },
    ];

    const { edges: enriched, result } = mergeScipResults(
      edges,
      scipResult,
      entities
    );

    expect(enriched).toHaveLength(2);
    expect(result.edgesUpgraded).toBeGreaterThanOrEqual(1);

    const upgraded = enriched.find((e) => e.scipVerified);
    if (upgraded) {
      expect(upgraded.confidence).toBe("compiler-verified");
    }
  });

  it("preserves structural confidence when no SCIP evidence", () => {
    const edges: IndexedEdge[] = [
      {
        from_key: "x",
        to_key: "y",
        type: "contains",
        file_path: "src/a.ts",
        line: 5,
      },
    ];

    const scipResult: ScipDecodeResult = {
      documents: [],
      symbolCount: 0,
      definitionCount: 0,
      referenceCount: 0,
      durationMs: 0,
    };

    const { edges: enriched } = mergeScipResults(edges, scipResult);
    expect(enriched[0]?.confidence).toBe("structural");
    expect(enriched[0]?.scipVerified).toBe(false);
  });

  it("handles empty edge list", () => {
    const { edges, result } = mergeScipResults([], {
      documents: [],
      symbolCount: 0,
      definitionCount: 0,
      referenceCount: 0,
      durationMs: 0,
    });
    expect(edges).toHaveLength(0);
    expect(result.edgesUpgraded).toBe(0);
  });

  it("materializes a call edge from a SCIP reference tree-sitter missed", () => {
    // Python case: tree-sitter produced NO call edges, but scip decoded the
    // cross-file call `inc() -> add()` as a reference occurrence. The merger
    // must recover the edge via symbol resolution + enclosing-entity containment.
    const scipResult: ScipDecodeResult = {
      documents: [
        {
          relativePath: "mod_a.py",
          symbols: [
            {
              symbol: "scip-python python . 0 mod_a/add().",
              filePath: "mod_a.py",
              line: 0, // def add (0-based)
              isDefinition: true,
            },
          ],
        },
        {
          relativePath: "mod_b.py",
          symbols: [
            {
              symbol: "scip-python python . 0 mod_b/inc().",
              filePath: "mod_b.py",
              line: 2, // def inc (0-based)
              isDefinition: true,
            },
            {
              symbol: "scip-python python . 0 mod_a/add().",
              filePath: "mod_b.py",
              line: 3, // call add(n,1) inside inc's body (0-based) → 1-based 4
              isDefinition: false,
            },
          ],
        },
      ],
      symbolCount: 3,
      definitionCount: 2,
      referenceCount: 1,
      durationMs: 0,
    };

    const entities = [
      {
        key: "add",
        name: "add",
        file_path: "mod_a.py",
        start_line: 1,
        end_line: 2,
      },
      {
        key: "inc",
        name: "inc",
        file_path: "mod_b.py",
        start_line: 3,
        end_line: 4,
      },
    ];

    // No tree-sitter edges at all (the Python case).
    const { newEdges, result } = mergeScipResults([], scipResult, entities);

    expect(result.newEdgesFromScip).toBe(1);
    expect(newEdges).toHaveLength(1);
    expect(newEdges[0]).toMatchObject({
      from_key: "inc",
      to_key: "add",
      type: "calls",
      confidence: "compiler-verified",
      scipVerified: true,
    });
  });

  it("does not duplicate an edge tree-sitter already produced", () => {
    const existing: IndexedEdge[] = [
      {
        from_key: "inc",
        to_key: "add",
        type: "calls",
        file_path: "mod_b.py",
        line: 4,
      },
    ];
    const scipResult: ScipDecodeResult = {
      documents: [
        {
          relativePath: "mod_a.py",
          symbols: [
            {
              symbol: "scip-python python . 0 mod_a/add().",
              filePath: "mod_a.py",
              line: 0,
              isDefinition: true,
            },
          ],
        },
        {
          relativePath: "mod_b.py",
          symbols: [
            {
              symbol: "scip-python python . 0 mod_a/add().",
              filePath: "mod_b.py",
              line: 3,
              isDefinition: false,
            },
          ],
        },
      ],
      symbolCount: 2,
      definitionCount: 1,
      referenceCount: 1,
      durationMs: 0,
    };
    const entities = [
      {
        key: "add",
        name: "add",
        file_path: "mod_a.py",
        start_line: 1,
        end_line: 2,
      },
      {
        key: "inc",
        name: "inc",
        file_path: "mod_b.py",
        start_line: 3,
        end_line: 4,
      },
    ];
    const { newEdges } = mergeScipResults(existing, scipResult, entities);
    expect(newEdges).toHaveLength(0);
  });

  it("stays upgrade-only when entities lack line ranges", () => {
    const scipResult: ScipDecodeResult = {
      documents: [
        {
          relativePath: "mod_a.py",
          symbols: [
            {
              symbol: "scip-python python . 0 mod_a/add().",
              filePath: "mod_a.py",
              line: 0,
              isDefinition: true,
            },
          ],
        },
        {
          relativePath: "mod_b.py",
          symbols: [
            {
              symbol: "scip-python python . 0 mod_a/add().",
              filePath: "mod_b.py",
              line: 3,
              isDefinition: false,
            },
          ],
        },
      ],
      symbolCount: 2,
      definitionCount: 1,
      referenceCount: 1,
      durationMs: 0,
    };
    // Entities WITHOUT start_line/end_line → containment impossible → no new edges.
    const entities = [
      { key: "add", name: "add", file_path: "mod_a.py" },
      { key: "inc", name: "inc", file_path: "mod_b.py" },
    ];
    const { newEdges, result } = mergeScipResults([], scipResult, entities);
    expect(result.newEdgesFromScip).toBe(0);
    expect(newEdges).toHaveLength(0);
  });
});

describe("SCIP Fallback (L2.9)", () => {
  it("applies structural confidence on fallback", () => {
    const edges: IndexedEdge[] = [
      { from_key: "a", to_key: "b", type: "calls", file_path: "f.ts", line: 1 },
    ];

    const result = applyScipFallback(edges, "binary not found");
    expect(result.level).toBe("unavailable");
    expect(result.edges[0]?.confidence).toBe("structural");
    expect(result.edges[0]?.scipVerified).toBe(false);
  });

  it("classifies error types correctly", () => {
    expect(classifyScipError("ENOENT: not found")).toBe("unavailable");
    expect(classifyScipError("timeout exceeded")).toBe("partial");
    expect(classifyScipError("protobuf decode failed")).toBe("partial");
    expect(classifyScipError("unknown error")).toBe("unavailable");
  });
});
