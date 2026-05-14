/**
 * Sprint P: Intelligence integration + performance tests.
 *
 * Tests the full pipeline: confidence propagation, response enrichment,
 * computation scheduling, and performance benchmarks.
 */

import { describe, expect, it } from "vitest";
import {
  buildReverseAdjacency,
  computeBlastRadius,
} from "../intelligence/blast-radius.js";
import {
  clearPending,
  getPendingCount,
  scheduleComputation,
} from "../intelligence/computation-scheduler.js";
import {
  confidenceToScore,
  propagateConfidence,
} from "../intelligence/confidence-propagation.js";
import { entityKey } from "../intelligence/indexer/entity-key.js";
import type {
  IndexedEdge,
  IndexedEntity,
} from "../intelligence/indexer/plugin-interface.js";
import { enrichResponse } from "../proxy/response-enrichment.js";

describe("Confidence Propagation (P.10)", () => {
  it("MIN across path: one heuristic → whole path is heuristic", () => {
    const result = propagateConfidence([
      "compiler-verified",
      "structural",
      "heuristic",
      "structural",
    ]);
    expect(result.level).toBe("heuristic");
    expect(result.edgeSources.heuristic).toBe(1);
    expect(result.edgeSources.structural).toBe(2);
    expect(result.pathLength).toBe(4);
  });

  it("all compiler-verified → compiler-verified result", () => {
    const result = propagateConfidence([
      "compiler-verified",
      "compiler-verified",
    ]);
    expect(result.level).toBe("compiler-verified");
  });

  it("empty path → structural default", () => {
    const result = propagateConfidence([]);
    expect(result.level).toBe("structural");
    expect(result.pathLength).toBe(0);
  });

  it("confidenceToScore maps correctly", () => {
    expect(confidenceToScore("compiler-verified")).toBe(1.0);
    expect(confidenceToScore("structural")).toBe(0.85);
    expect(confidenceToScore("heuristic")).toBe(0.5);
  });
});

describe("Response Enrichment (P.9)", () => {
  it("enriches response with _meta block", () => {
    const result = enrichResponse(
      { entities: ["a", "b"] },
      {
        confidence: "structural",
        riskLevel: "high",
        resolutionMs: 2.3,
        edgeSources: { structural: 5 },
      },
    );

    expect(result._meta.confidence).toBe("structural");
    expect(result._meta.confidence_score).toBe(0.85);
    expect(result._meta.risk_level).toBe("high");
    expect(result._meta.resolution_ms).toBe(2.3);
    expect(result._meta.edge_sources.structural).toBe(5);
  });

  it("includes _context when provided", () => {
    const result = enrichResponse(
      {},
      {
        confidence: "structural",
        riskLevel: "normal",
        resolutionMs: 1,
        edgeSources: {},
      },
      { "dev.unerr/conventions": [{ name: "test" }] },
    );
    expect(result._context?.["dev.unerr/conventions"]).toBeDefined();
  });

  it("omits _context when empty", () => {
    const result = enrichResponse(
      {},
      {
        confidence: "structural",
        riskLevel: "normal",
        resolutionMs: 1,
        edgeSources: {},
      },
    );
    expect(result._context).toBeUndefined();
  });
});

describe("Computation Scheduler (P.11)", () => {
  it("executes critical computations immediately", async () => {
    let executed = false;
    const ran = await scheduleComputation(
      "test-critical",
      "critical",
      async () => {
        executed = true;
      },
    );
    expect(ran).toBe(true);
    expect(executed).toBe(true);
  });

  it("executes normal computations when resources available", async () => {
    let executed = false;
    const ran = await scheduleComputation("test-normal", "normal", async () => {
      executed = true;
    });
    expect(ran).toBe(true);
    expect(executed).toBe(true);
  });

  it("getPendingCount reflects queue", () => {
    clearPending();
    expect(getPendingCount()).toBe(0);
  });
});

describe("Performance: Blast Radius <5ms (P.12)", () => {
  it("200-entity graph blast radius completes in <5ms", () => {
    const target = {
      key: entityKey("center.ts", "function", "center", ""),
      kind: "function" as const,
      name: "center",
      file_path: "center.ts",
      start_line: 1,
      end_line: 5,
      signature: "center()",
      body_hash: "h",
      exported: true,
      parent_key: null,
      language: "typescript",
      is_async: false,
      parameter_count: 0,
      doc: null,
      community: 0,
      risk_level: "high",
    };

    const allEntities = [target];
    const allEdges: IndexedEdge[] = [];

    for (let i = 0; i < 200; i++) {
      const caller = {
        ...target,
        key: entityKey(`f${i}.ts`, "function", `fn${i}`, ""),
        name: `fn${i}`,
        file_path: `f${i}.ts`,
      };
      allEntities.push(caller);
      allEdges.push({
        from_key: caller.key,
        to_key: target.key,
        type: "calls",
        file_path: caller.file_path,
        line: 1,
      });
    }

    const entities = new Map(allEntities.map((e) => [e.key, e]));
    const adj = buildReverseAdjacency(allEdges);

    const start = performance.now();
    const result = computeBlastRadius(target.key, entities, adj, {
      maxHops: 2,
    });
    const elapsed = performance.now() - start;

    expect(result.totalAffected).toBe(200);
    expect(elapsed).toBeLessThan(5);
  });
});

describe("End-to-End Pipeline (P.13)", () => {
  it("index → query → enriched response with confidence", () => {
    const entities = new Map([
      [
        "target",
        {
          key: "target",
          kind: "function" as const,
          name: "processOrder",
          file_path: "src/orders.ts",
          start_line: 1,
          end_line: 10,
          signature: "processOrder()",
          body_hash: "h",
          exported: true,
          parent_key: null,
          language: "typescript",
          is_async: true,
          parameter_count: 1,
          doc: null,
          community: 0,
          risk_level: "high",
        },
      ],
      [
        "caller",
        {
          key: "caller",
          kind: "function" as const,
          name: "checkout",
          file_path: "src/checkout.ts",
          start_line: 1,
          end_line: 5,
          signature: "checkout()",
          body_hash: "h2",
          exported: true,
          parent_key: null,
          language: "typescript",
          is_async: true,
          parameter_count: 0,
          doc: null,
          community: 1,
          risk_level: "normal",
        },
      ],
    ]);

    const edges: IndexedEdge[] = [
      {
        from_key: "caller",
        to_key: "target",
        type: "calls",
        file_path: "src/checkout.ts",
        line: 3,
      },
    ];

    const adj = buildReverseAdjacency(edges);
    const blastResult = computeBlastRadius("target", entities, adj);

    const confidence = propagateConfidence(["structural"]);
    const enriched = enrichResponse(blastResult, {
      confidence: confidence.level,
      riskLevel: "high",
      resolutionMs: blastResult.resolvedInMs,
      edgeSources: confidence.edgeSources,
    });

    expect(enriched._meta.confidence).toBe("structural");
    expect(enriched._meta.risk_level).toBe("high");
    expect(enriched._meta.resolution_ms).toBeGreaterThanOrEqual(0);
    expect((enriched.content as { totalAffected: number }).totalAffected).toBe(
      1,
    );
  });
});
