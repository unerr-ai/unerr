/**
 * Sprint L5.2 — Network Boundary Contract Tests
 *
 * Static contract tests verifying that every cloud-dependent service
 * is structurally disabled (null / NullProxy) in Local Mode. These
 * tests catch regressions at the contract level — even if a future
 * code change introduces a network call, these tests will catch it.
 *
 * A security-conscious user reading these tests should be convinced
 * that their data never leaves their machine in Local Mode.
 *
 * CONTRACT: TL-1, TL-3, TL-15
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBlockedCount,
  resetBlockedCount,
  seal,
  unseal,
} from "../proxy/network-firewall.js";

// ── Shared Mock Graph ──────────────────────────────────────────────

function createMockGraph() {
  const mockEntity = {
    key: "fn::test",
    kind: "function",
    name: "testFn",
    file_path: "src/test.ts",
    start_line: 1,
    end_line: 10,
    signature: "(): void",
    body: "function testFn() {}",
    fan_in: 2,
    fan_out: 1,
    risk_level: "normal",
  };

  const mockDb = {
    run: vi.fn((_query: string) => ({
      rows: [],
    })),
  };

  return {
    db: mockDb,
    getEntity: vi.fn().mockReturnValue(mockEntity),
    getCallersOf: vi.fn().mockReturnValue([]),
    getCalleesOf: vi.fn().mockReturnValue([]),
    getEntitiesByFile: vi.fn().mockReturnValue([mockEntity]),
    searchEntities: vi.fn().mockReturnValue([mockEntity]),
    getImports: vi.fn().mockReturnValue([]),
    hasRules: vi.fn().mockReturnValue(true),
    getRules: vi.fn().mockReturnValue([]),
    getPatterns: vi
      .fn()
      .mockReturnValue([
        { name: "test-pattern", type: "naming", adherence: 0.9 },
      ]),
    hasJustifications: vi.fn().mockReturnValue(true),
    getBusinessContext: vi.fn().mockReturnValue(null),
    getConventions: vi.fn().mockReturnValue([]),
    getCrossBoundaryLinks: vi.fn().mockReturnValue([]),
    getCriticalNodes: vi.fn().mockReturnValue([]),
    getDriftEntitiesForFile: vi.fn().mockReturnValue([]),
    upsertDriftEntity: vi.fn(),
    removeDriftEntity: vi.fn(),
    clearDriftOverlay: vi.fn(),
    getDriftSummary: vi
      .fn()
      .mockReturnValue({ added: 0, modified: 0, deleted: 0, total: 0 }),
    healthCheck: vi.fn().mockReturnValue({ status: "ok", latencyMs: 1 }),
    isLoaded: vi.fn().mockReturnValue(true),
    loadSnapshot: vi.fn(),
    loadRules: vi.fn(),
    loadPatterns: vi.fn(),
    loadJustifications: vi.fn(),
    applyDelta: vi.fn().mockReturnValue({
      applied: 0,
      deleted: 0,
      edges: 0,
      justifications: 0,
      overlayExpired: 0,
    }),
    getLocalProjectStats: vi.fn().mockReturnValue({
      fileCount: 100,
      entityCount: 500,
      edgeCount: 1200,
      communityCount: 10,
      ruleCount: 5,
    }),
    getDeepDiveProjectState: vi.fn().mockReturnValue("none"),
    persistCorrections: vi.fn(),
    getRuleHealthSummary: vi.fn().mockReturnValue(null),
    getRuleExceptions: vi.fn().mockReturnValue([]),
  };
}

// ── Test Suite ─────────────────────────────────────────────────────

describe("Network Boundary Contracts (L5.2)", () => {
  afterEach(() => {
    unseal();
    resetBlockedCount();
  });

  it("local-routed tools resolve without network calls", async () => {
    seal();

    const { QueryRouter } = await import("../intelligence/query-router.js");
    const graph = createMockGraph();

    const router = new QueryRouter(graph as never);
    router.setMode("local", "Local Mode");

    await router.execute("get_function", { key: "fn::test" });
    await router.execute("search_code", { query: "test" });
    await router.execute("get_callers", { key: "fn::test" });
    await router.execute("get_conventions", {});

    expect(getBlockedCount()).toBe(0);
  });

  it("Local Mode QueryRouter handles errors locally (TL-15)", async () => {
    seal();

    const { QueryRouter } = await import("../intelligence/query-router.js");
    const graph = createMockGraph();
    graph.getEntity = vi.fn().mockImplementation(() => {
      throw new Error("Simulated local failure");
    });

    const router = new QueryRouter(graph as never);
    router.setMode("local", "Local Mode");

    const result = await router.execute("get_function", { key: "nonexistent" });

    expect(result._meta.source).toBe("local");
    expect(result.content).toHaveProperty("error");
    expect(getBlockedCount()).toBe(0);
  });

  it("NetworkFirewall rejects app.unerr.dev when sealed", async () => {
    seal();

    const result = await globalThis
      .fetch("https://app.unerr.dev/api/repos/test/profile")
      .catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("[NetworkFirewall]");
    expect(getBlockedCount()).toBe(1);
  });

  it("NetworkFirewall rejects api.anthropic.com when sealed (no allowlist)", async () => {
    seal();

    const result = await globalThis
      .fetch("https://api.anthropic.com/v1/messages")
      .catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("[NetworkFirewall]");
    expect(getBlockedCount()).toBe(1);
  });

  it("NetworkFirewall allows localhost (Ollama, LM Studio) when sealed", async () => {
    seal();

    const localhostUrls = [
      "http://localhost:11434/api/tags",
      "http://127.0.0.1:1234/v1/models",
      "http://localhost:8080/health",
    ];

    for (const url of localhostUrls) {
      const result = await globalThis.fetch(url).catch((e: Error) => e);
      if (result instanceof Error) {
        expect(result.message).not.toContain("[NetworkFirewall]");
      }
    }

    expect(getBlockedCount()).toBe(0);
  });

  it("local-routed tools resolve from CozoDB with zero network calls", async () => {
    seal();

    const { QueryRouter } = await import("../intelligence/query-router.js");
    const graph = createMockGraph();
    const router = new QueryRouter(graph as never);
    router.setMode("local", "Local Mode");

    const localOnlyTools = [
      { name: "get_function", args: { key: "fn::test" } },
      { name: "get_class", args: { key: "fn::test" } },
      { name: "get_file", args: { key: "src/test.ts" } },
      { name: "get_callers", args: { key: "fn::test" } },
      { name: "get_callees", args: { key: "fn::test" } },
      { name: "get_imports", args: { file_path: "src/test.ts" } },
      { name: "search_code", args: { query: "test" } },
      { name: "get_rules", args: {} },
      { name: "get_business_context", args: { key: "fn::test" } },
      { name: "get_conventions", args: {} },
      { name: "get_cross_boundary_links", args: {} },
      { name: "get_critical_nodes", args: {} },
    ];

    for (const tool of localOnlyTools) {
      const result = await router.execute(tool.name, tool.args);
      expect(result._meta.source).toBe("local");
    }

    expect(getBlockedCount()).toBe(0);
  });

  it("get_project_stats returns from local CozoDB (not cloud API)", async () => {
    seal();

    const { QueryRouter } = await import("../intelligence/query-router.js");
    const graph = createMockGraph();
    const router = new QueryRouter(graph as never);
    router.setMode("local", "Local Mode");

    const result = await router.execute("get_project_stats", {});
    expect(result._meta.source).toBe("local");
    expect(getBlockedCount()).toBe(0);
  });
});
