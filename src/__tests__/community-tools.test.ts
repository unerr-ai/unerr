/**
 * Leapfrog Sprint A.4 + A.5 TEST: Community MCP tools.
 *
 * Tests the community query methods on CozoGraphStore and the QueryRouter's
 * handling of get_cross_boundary_links and get_critical_nodes tools.
 * Uses mock graph store (consistent with query-router.test.ts pattern).
 */

import { describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";

interface MockGraphOpts {
  communities?: Array<{
    id: number;
    label: string;
    size: number;
    cohesion: number;
  }>;
  criticalNodes?: Array<{
    key: string;
    name: string;
    file_path: string;
    fan_in: number;
    fan_out: number;
    degree: number;
    community: number;
    community_label: string;
    risk_level: string;
  }>;
  crossBoundaryLinks?: Array<{
    from_name: string;
    from_file: string;
    from_community: number;
    from_community_label: string;
    to_name: string;
    to_file: string;
    to_community: number;
    to_community_label: string;
    edge_type: string;
    surprise_score: number;
  }>;
  communityForEntity?: {
    id: number;
    label: string;
    size: number;
    cohesion: number;
  } | null;
  crossCommunityEdges?: Array<{
    entity_name: string;
    entity_key: string;
    entity_community_id: number;
    entity_community_label: string;
    relation: string;
  }>;
  entityOverride?: Record<string, unknown> | null;
}

function createMockGraphStore(opts?: MockGraphOpts) {
  const defaultEntity = {
    key: "fn1",
    kind: "function",
    name: "doStuff",
    file_path: "src/index.ts",
    start_line: 10,
    signature: "()",
    body: "function doStuff() {}",
    fan_in: 0,
    fan_out: 0,
    risk_level: "normal",
    community: -1,
  };

  return {
    db: { run: vi.fn().mockReturnValue({ rows: [] }) },
    hasRules: vi.fn().mockReturnValue(false),
    hasJustifications: vi.fn().mockReturnValue(false),
    getPatterns: vi.fn().mockReturnValue([]),
    getEntity: vi
      .fn()
      .mockReturnValue(
        opts?.entityOverride !== undefined ? opts.entityOverride : defaultEntity
      ),
    getCallersOf: vi.fn().mockReturnValue([]),
    getCalleesOf: vi.fn().mockReturnValue([]),
    getEntitiesByFile: vi.fn().mockReturnValue([]),
    searchEntities: vi.fn().mockReturnValue([]),
    getImports: vi.fn().mockReturnValue([]),
    getRules: vi.fn().mockReturnValue([]),
    getBlastRadius: vi.fn().mockReturnValue({
      direct_callers: 0,
      direct_callees: 0,
      transitive_count: 0,
      transitive_depth: 2,
      is_chokepoint: false,
      summary: "No dependencies",
    }),
    getBlastRadiusEntities: vi.fn().mockReturnValue([]),
    getConventionsForEntity: vi.fn().mockReturnValue([]),
    getDriftEntitiesForFile: vi.fn().mockReturnValue([]),
    getDriftSummary: vi.fn().mockReturnValue({
      total: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      dependency_changed: 0,
    }),
    upsertDriftEntity: vi.fn(),
    removeDriftEntity: vi.fn(),
    clearDriftOverlay: vi.fn(),
    getCrossBoundaryLinks: vi
      .fn()
      .mockReturnValue(opts?.crossBoundaryLinks ?? []),
    getCriticalNodes: vi.fn().mockReturnValue(opts?.criticalNodes ?? []),
    getAllCommunities: vi.fn().mockReturnValue(opts?.communities ?? []),
    getCommunityForEntity: vi
      .fn()
      .mockReturnValue(opts?.communityForEntity ?? null),
    getCrossCommunityEdges: vi
      .fn()
      .mockReturnValue(opts?.crossCommunityEdges ?? []),
    hasDeepDiveProject: vi.fn().mockReturnValue(false),
  } as unknown as CozoGraphStore;
}

// ── A.4: Cross Boundary Links Tool ─────────────────────────────

describe("get_cross_boundary_links (A.4)", () => {
  it("routes to local and returns cross-community edges", async () => {
    const connections = [
      {
        from_name: "refresh",
        from_file: "src/auth/refresh.ts",
        from_community: 0,
        from_community_label: "auth",
        to_name: "charge",
        to_file: "src/payment/charge.ts",
        to_community: 1,
        to_community_label: "payment",
        edge_type: "calls",
        surprise_score: 0.85,
      },
      {
        from_name: "validate",
        from_file: "src/payment/validate.ts",
        from_community: 1,
        from_community_label: "payment",
        to_name: "log",
        to_file: "src/utils/logger.ts",
        to_community: 2,
        to_community_label: "utils",
        edge_type: "calls",
        surprise_score: 0.72,
      },
    ];
    const graph = createMockGraphStore({ crossBoundaryLinks: connections });
    const router = new QueryRouter(graph);

    const result = await router.execute("get_cross_boundary_links", {
      top_n: 10,
    });

    expect(result._meta.source).toBe("local");
    expect(result._meta.latency_ms).toBeLessThan(50);
    expect(result._meta.format).toBe("columnar");
    expect(typeof result.content).toBe("string");
    const col = result.content as string;
    expect(col).toContain("_fmt:columnar");
    expect(col).toContain("refresh");
    expect(col).toContain("charge");
  });

  it("passes community_id filter to graph store", async () => {
    const graph = createMockGraphStore();
    const router = new QueryRouter(graph);

    await router.execute("get_cross_boundary_links", {
      community_id: 3,
      top_n: 5,
    });

    expect(graph.getCrossBoundaryLinks).toHaveBeenCalledWith(3, 5);
  });

  it("defaults top_n to 20", async () => {
    const graph = createMockGraphStore();
    const router = new QueryRouter(graph);

    await router.execute("get_cross_boundary_links", {});

    expect(graph.getCrossBoundaryLinks).toHaveBeenCalledWith(undefined, 20);
  });

  it("is registered as a local route", () => {
    const graph = createMockGraphStore();
    const router = new QueryRouter(graph);
    expect(router.isKnownTool("get_cross_boundary_links")).toBe(true);
  });
});

// ── A.5: Critical Nodes Tool ──────────────────────────────────────────

describe("get_critical_nodes (A.5)", () => {
  it("routes to local and returns highest-degree entities", async () => {
    const criticalNodes = [
      {
        key: "pay_charge",
        name: "charge",
        file_path: "src/payment/charge.ts",
        fan_in: 8,
        fan_out: 5,
        degree: 13,
        community: 1,
        community_label: "payment",
        risk_level: "high",
      },
      {
        key: "auth_login",
        name: "login",
        file_path: "src/auth/login.ts",
        fan_in: 6,
        fan_out: 3,
        degree: 9,
        community: 0,
        community_label: "auth",
        risk_level: "medium",
      },
    ];
    const graph = createMockGraphStore({ criticalNodes });
    const router = new QueryRouter(graph);

    const result = await router.execute("get_critical_nodes", { top_n: 5 });

    expect(result._meta.source).toBe("local");
    expect(result._meta.format).toBe("columnar");
    expect(typeof result.content).toBe("string");
    const col = result.content as string;
    expect(col).toContain("pay_charge");
    expect(col).toContain("auth_login");
    expect(col).toContain("_fmt:columnar");
  });

  it("passes community_id filter to graph store", async () => {
    const graph = createMockGraphStore();
    const router = new QueryRouter(graph);

    await router.execute("get_critical_nodes", { top_n: 3, community_id: 2 });

    expect(graph.getCriticalNodes).toHaveBeenCalledWith(3, 2);
  });

  it("defaults top_n to 10", async () => {
    const graph = createMockGraphStore();
    const router = new QueryRouter(graph);

    await router.execute("get_critical_nodes", {});

    expect(graph.getCriticalNodes).toHaveBeenCalledWith(10, undefined);
  });

  it("is registered as a local route", () => {
    const graph = createMockGraphStore();
    const router = new QueryRouter(graph);
    expect(router.isKnownTool("get_critical_nodes")).toBe(true);
  });
});
