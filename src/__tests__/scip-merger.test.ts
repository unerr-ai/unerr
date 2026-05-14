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
      entities,
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
