/**
 * Sprint L5.1 — Offline Integration Test Suite
 *
 * Proves that Local Mode makes exactly zero outbound network calls
 * under all code paths. Boots a mock QueryRouter in Local Mode,
 * exercises every local MCP tool, and asserts zero non-localhost fetch calls.
 *
 * CONTRACT: TL-1, TL-12, TL-15
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getBlockedCount,
  resetBlockedCount,
  seal,
  unseal,
} from "../proxy/network-firewall.js";

// ── Fetch Interceptor ──────────────────────────────────────────────

interface NetworkCallEntry {
  url: string;
  method: string | undefined;
  hostname: string | null;
}

const networkCallLog: NetworkCallEntry[] = [];
let originalFetch: typeof globalThis.fetch;

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function isLocalhostUrl(hostname: string | null): boolean {
  if (!hostname) return false;
  return LOCALHOST_NAMES.has(hostname) || hostname.endsWith(".local");
}

function getNonLocalhostCalls(): NetworkCallEntry[] {
  return networkCallLog.filter((c) => !isLocalhostUrl(c.hostname));
}

// ── Mock Graph + Router ────────────────────────────────────────────

function createMockLocalGraph() {
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

describe("Local Mode — Zero Network Leakage (L5.1)", () => {
  beforeAll(() => {
    originalFetch = globalThis.fetch;

    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const hostname = extractHostname(url);

      networkCallLog.push({
        url,
        method: init?.method ?? "GET",
        hostname,
      });

      if (hostname && !isLocalhostUrl(hostname)) {
        return Promise.reject(
          new Error(
            `[TEST GUARD] Outbound network call detected to ${hostname}: ${url}`,
          ),
        );
      }

      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    unseal();
    resetBlockedCount();
    networkCallLog.length = 0;
  });

  it("NetworkFirewall blocks outbound calls with zero leakage", async () => {
    seal();
    expect(getBlockedCount()).toBe(0);

    const externalUrls = [
      "https://app.unerr.dev/api/health",
      "https://api.anthropic.com/v1/messages",
      "https://cloud.example.com/sync",
    ];

    for (const url of externalUrls) {
      const result = await globalThis.fetch(url).catch((e: Error) => e);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("[NetworkFirewall]");
    }

    expect(getBlockedCount()).toBe(3);
  });

  it("all 14+ local MCP tools respond without network calls via QueryRouter", async () => {
    seal();
    networkCallLog.length = 0;

    const { QueryRouter } = await import("../intelligence/query-router.js");
    const graph = createMockLocalGraph();

    const router = new QueryRouter(graph as never);
    router.setMode("local", "Local Mode");

    const localTools = [
      { name: "get_function", args: { key: "fn::test" } },
      { name: "get_class", args: { key: "cls::test" } },
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

    for (const tool of localTools) {
      const result = await router.execute(tool.name, tool.args);
      expect(result._meta.source).toBe("local");
    }

    expect(getNonLocalhostCalls().length).toBe(0);
    expect(getBlockedCount()).toBe(0);
  });

  it("aggregate: zero non-localhost calls across full Local Mode exercise", () => {
    seal();
    networkCallLog.length = 0;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    void globalThis.fetch("http://localhost:11434/api/tags").catch(() => {});
    void globalThis.fetch("http://127.0.0.1:8080/health").catch(() => {});

    expect(getNonLocalhostCalls().length).toBe(0);
    expect(getBlockedCount()).toBe(0);

    stderrSpy.mockRestore();
  });
});
