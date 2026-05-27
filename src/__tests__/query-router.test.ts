/**
 * Phase 10b TEST-07 + Sprint 3 TEST-05: Query router + drift overlay tests.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  CozoGraphStore,
  DriftEntity,
  DriftSummary,
} from "../intelligence/local-graph.js";
import {
  type ProxyMode,
  QueryRouter,
  orderContextFields,
} from "../intelligence/query-router.js";

/** Helper: find a signal by content substring in _context.signals */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSignal(result: any, contentSubstr: string) {
  const signals = result._context?.signals as
    | Array<{
        type: string;
        content: string;
        action?: string;
        composite_score: number;
      }>
    | undefined;
  if (!signals) return undefined;
  return signals.find((s) => s.content.includes(contentSubstr));
}

/** Helper: check if any signal contains the substring */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasSignalContaining(result: any, contentSubstr: string): boolean {
  return findSignal(result, contentSubstr) !== undefined;
}

function createMockLocalGraph(
  opts: {
    hasRules?: boolean;
    hasJustifications?: boolean;
    driftEntities?: DriftEntity[];
  } = {}
): CozoGraphStore {
  const {
    hasRules = true,
    hasJustifications = false,
    driftEntities = [],
  } = opts;
  const driftMap = new Map<string, DriftEntity>();
  for (const d of driftEntities) driftMap.set(d.key, d);

  // Build a mock db for direct drift_overlay queries
  const mockDb = {
    run: vi.fn(async (query: string, params?: Record<string, unknown>) => {
      if (query.includes("drift_overlay") && params?.key) {
        const d = driftMap.get(params.key as string);
        if (d) {
          return {
            rows: [
              [
                d.key,
                d.name,
                d.kind,
                d.signature,
                d.body,
                d.file_path,
                d.line_start,
                d.line_end,
                d.content_hash,
                d.drift_status,
                d.intent_id,
                d.modified_at,
                d.origin ?? "human",
                d.previous_body ?? "",
                d.previous_signature ?? "",
              ],
            ],
          };
        }
        return { rows: [] };
      }
      // Default: count query for drift summary
      if (query.includes("drift_overlay") && query.includes("count")) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };

  return {
    db: mockDb,
    getEntity: vi.fn().mockReturnValue({
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
    }),
    getCallersOf: vi.fn().mockReturnValue([]),
    getCalleesOf: vi.fn().mockReturnValue([]),
    getEntitiesByFile: vi.fn().mockReturnValue([]),
    searchEntities: vi.fn().mockReturnValue([]),
    getImports: vi.fn().mockReturnValue([]),
    healthCheck: vi.fn().mockReturnValue({ status: "up", latencyMs: 0 }),
    isLoaded: vi.fn().mockReturnValue(true),
    loadSnapshot: vi.fn(),
    hasRules: vi.fn().mockReturnValue(hasRules),
    getRules: vi.fn().mockReturnValue([
      {
        key: "r1",
        name: "Test",
        scope: "repo",
        severity: "warn",
        engine: "naming",
        query: "^_",
        message: "No underscore",
        file_glob: "",
        enabled: true,
        repo_id: "repo-1",
      },
    ]),
    getPatterns: vi.fn().mockReturnValue([
      {
        key: "p1",
        name: "Error handler",
        kind: "error-handling",
        frequency: 5,
        confidence: 0.8,
        exemplar_keys: [],
        promoted_rule_key: "",
      },
    ]),
    loadRules: vi.fn(),
    loadPatterns: vi.fn(),
    hasJustifications: vi.fn().mockReturnValue(hasJustifications),
    getBusinessContext: vi.fn().mockReturnValue(
      hasJustifications
        ? {
            purpose: "Handles payments",
            role: "logic",
            feature_area: "billing",
            confidence: 0.9,
            entity: null,
          }
        : null
    ),
    getConventions: vi.fn().mockReturnValue([
      {
        name: "Error handler",
        kind: "error-handling",
        frequency: 5,
        confidence: 0.8,
        adherence_rate: 0.1,
      },
    ]),
    loadJustifications: vi.fn(),
    getBlastRadius: vi.fn().mockReturnValue({
      direct_callers: 3,
      direct_callees: 2,
      transitive_count: 8,
      transitive_depth: 2,
      is_chokepoint: false,
      summary:
        "3 direct callers, 2 direct callees, 8 transitive dependents (depth 2)",
    }),
    getBlastRadiusEntities: vi.fn().mockReturnValue([]),
    getConventionsForEntity: vi.fn().mockReturnValue([
      {
        id: "pattern:p1",
        name: "Error handler",
        adherence_pct: 10,
        rule: "error-handling pattern (5 occurrences, 80% confidence)",
      },
    ]),
    getDriftEntitiesForFile: vi.fn().mockReturnValue([]),
    upsertDriftEntity: vi.fn(),
    removeDriftEntity: vi.fn(),
    clearDriftOverlay: vi.fn(),
    getDriftSummary: vi.fn().mockReturnValue({
      added: driftEntities.filter((d) => d.drift_status === "added").length,
      modified: driftEntities.filter((d) => d.drift_status === "modified")
        .length,
      deleted: driftEntities.filter((d) => d.drift_status === "deleted").length,
      dependency_changed: driftEntities.filter(
        (d) => d.drift_status === "dependency_changed"
      ).length,
      total: driftEntities.length,
    } as DriftSummary),
  } as unknown as CozoGraphStore;
}

// ── Routing Tests ──────────────────────────────────────────────

describe("QueryRouter", () => {
  describe("isKnownTool", () => {
    it("recognizes all local tools", () => {
      const router = new QueryRouter(createMockLocalGraph());
      expect(router.isKnownTool("get_function")).toBe(true);
      expect(router.isKnownTool("get_class")).toBe(true);
      expect(router.isKnownTool("get_file")).toBe(true);
      expect(router.isKnownTool("get_callers")).toBe(true);
      expect(router.isKnownTool("get_callees")).toBe(true);
      expect(router.isKnownTool("get_imports")).toBe(true);
      expect(router.isKnownTool("search_code")).toBe(true);
      // Disabled: get_rules, check_rules, get_business_context — not wired/no data
      // expect(router.isKnownTool("get_rules")).toBe(true);
      // expect(router.isKnownTool("check_rules")).toBe(true);
      // expect(router.isKnownTool("get_business_context")).toBe(true);
      expect(router.isKnownTool("get_conventions")).toBe(true);
      // Disabled: semantic_search, find_similar — embedding store never wired
      // expect(router.isKnownTool("semantic_search")).toBe(true);
      // expect(router.isKnownTool("find_similar")).toBe(true);
      expect(router.isKnownTool("get_project_stats")).toBe(true);
      expect(router.isKnownTool("fetch_url")).toBe(true);
    });

    it("returns false for unknown tools", () => {
      const router = new QueryRouter(createMockLocalGraph());
      expect(router.isKnownTool("unknown_tool")).toBe(false);
    });
  });

  describe("execute", () => {
    it("executes local tools with local source in meta", async () => {
      const localGraph = createMockLocalGraph();

      const router = new QueryRouter(localGraph);

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.source).toBe("local");
      expect(localGraph.getEntity).toHaveBeenCalledWith("fn1");
    });

    it("returns error when local fails (no cloud fallback)", async () => {
      const localGraph = createMockLocalGraph();
      (localGraph.getEntity as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("Not found");
        }
      );

      const router = new QueryRouter(localGraph);

      const result = await router.execute("get_function", { key: "missing" });
      expect(result._meta.source).toBe("local");
      expect(result.content).toHaveProperty("error");
    });

    // Disabled: get_rules, check_rules — no rules detected/stored yet, always returns empty.
    // it("executes get_rules locally", async () => { ... });
    // it("executes check_rules locally with evaluator", async () => { ... });
    // it("returns error for check_rules without evaluator", async () => { ... });

    it("returns empty rules when no local rules", async () => {
      const localGraph = createMockLocalGraph({ hasRules: false });

      const router = new QueryRouter(localGraph);

      const result = await router.execute("get_rules", {});
      expect(result._meta.source).toBe("local");
    });
  });

  // ── Sprint 3: Business Context / Conventions Tests ────────────

  // Disabled: get_business_context — not properly wired, produces no useful data.
  // describe("get_business_context", () => {
  //   it("resolves locally when justifications exist", async () => { ... });
  //   it("returns null content when no justifications", async () => { ... });
  // });

  describe("get_conventions", () => {
    it("resolves locally and returns adherence rates", async () => {
      const localGraph = createMockLocalGraph();

      const router = new QueryRouter(localGraph);

      const result = await router.execute("get_conventions", {});
      expect(result._meta.source).toBe("local");
      expect(localGraph.getConventions).toHaveBeenCalled();
      // Conventions are emitted as `_fmt:multi` (sections by kind) — the
      // format-encoder reuses the "columnar" meta flag for multi-section
      // responses since the legend covers both shapes.
      expect(result._meta.format).toBe("columnar");
      // Response is the encoded `_fmt:multi` string; assert structural markers.
      const text = result.content as string;
      expect(typeof text).toBe("string");
      expect(text.startsWith("_fmt:multi")).toBe(true);
      expect(text).toMatch(/@(naming|import_direction|structure)\[/);
      // get_conventions now ships only the per-kind arrays. The synthetic
      // `guidance` prose and `summary` count were dropped from the wire (the
      // agent can read adherence_rate off each convention), so no scalar
      // fields remain → the encoder emits no `@meta` line and no `summary=`.
      expect(text).not.toContain("@meta");
      expect(text).not.toContain("summary=");
    });
  });

  // ── Sprint 3: Drift Overlay Tests (P10-TEST-05) ───────────────

  describe("drift overlay merge", () => {
    it("base entity only (no overlay) — no _meta.drift", async () => {
      const localGraph = createMockLocalGraph();

      const router = new QueryRouter(localGraph);

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.source).toBe("local");
      expect(result._meta.drift).toBeUndefined();
    });

    it("modified entity — overlay body replaces base body, _meta.drift present", async () => {
      const driftEntities: DriftEntity[] = [
        {
          key: "fn1",
          name: "doStuff",
          kind: "function",
          signature: "()",
          body: "function doStuff() { return 'modified' }",
          file_path: "src/index.ts",
          line_start: 10,
          line_end: 12,
          content_hash: "abc123",
          drift_status: "modified",
          intent_id: "intent_001",
          modified_at: "2026-03-09T10:00:00Z",
          origin: "human",
          previous_body: "",
          previous_signature: "",
        },
      ];
      const localGraph = createMockLocalGraph({ driftEntities });

      const router = new QueryRouter(localGraph);
      router.setBranchContext({
        currentBranch: "feature/auth",
        baseBranch: "main",
        baseCommit: "abc",
        commitsAhead: 3,
        commitsBehind: 0,
        headSha: "def",
        computedAt: "2026-03-09",
      });

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.source).toBe("local");
      expect(result._meta.drift).toBeDefined();
      expect(result._meta.drift?.entityStatus).toBe("modified");
      expect(result._meta.drift?.branch).toBe("feature/auth");
      expect(result._meta.drift?.commitsAhead).toBe(3);
      expect(result._meta.drift?.lastModifiedBy).toBe("intent_001");

      // Body should be replaced with overlay body
      const content = result.content as { body: string };
      expect(content.body).toContain("modified");
    });

    it("added entity — included in results with drift status", async () => {
      const driftEntities: DriftEntity[] = [
        {
          key: "fn_new",
          name: "newFeature",
          kind: "function",
          signature: "(x: number)",
          body: "function newFeature(x: number) { return x }",
          file_path: "src/new.ts",
          line_start: 1,
          line_end: 3,
          content_hash: "xyz789",
          drift_status: "added",
          intent_id: "intent_002",
          modified_at: "2026-03-09T11:00:00Z",
          origin: "ai",
          previous_body: "",
          previous_signature: "",
        },
      ];
      const localGraph = createMockLocalGraph({ driftEntities });
      // Mock getEntity to return null for the new entity (not in base)
      (localGraph.getEntity as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const router = new QueryRouter(localGraph);
      router.setBranchContext({
        currentBranch: "feature/x",
        baseBranch: "main",
        baseCommit: null,
        commitsAhead: 1,
        commitsBehind: null,
        headSha: "abc",
        computedAt: "2026-03-09",
      });

      const result = await router.execute("get_function", { key: "fn_new" });
      expect(result._meta.source).toBe("local");
      expect(result._meta.drift).toBeDefined();
      expect(result._meta.drift?.entityStatus).toBe("added");

      const content = result.content as { name: string; kind: string };
      expect(content.name).toBe("newFeature");
      expect(content.kind).toBe("function");
    });

    it("deleted entity — excluded from results, drift annotated", async () => {
      const driftEntities: DriftEntity[] = [
        {
          key: "fn1",
          name: "doStuff",
          kind: "function",
          signature: "()",
          body: "",
          file_path: "src/index.ts",
          line_start: 10,
          line_end: 10,
          content_hash: "",
          drift_status: "deleted",
          intent_id: "intent_003",
          modified_at: "2026-03-09T12:00:00Z",
          origin: "human",
          previous_body: "",
          previous_signature: "",
        },
      ];
      const localGraph = createMockLocalGraph({ driftEntities });

      const router = new QueryRouter(localGraph);
      router.setBranchContext({
        currentBranch: "main",
        baseBranch: "main",
        baseCommit: null,
        commitsAhead: 0,
        commitsBehind: null,
        headSha: "abc",
        computedAt: "2026-03-09",
      });

      const result = await router.execute("get_function", { key: "fn1" });
      // Deleted entity returns null content
      expect(result.content).toBeNull();
    });

    it("local failure returns error with local source", async () => {
      const localGraph = createMockLocalGraph();
      (localGraph.getEntity as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("CozoDB corrupted");
        }
      );

      const router = new QueryRouter(localGraph);

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.source).toBe("local");
      expect(result.content).toHaveProperty("error");
    });

    it("no drift overlay — pure CozoDB results (no performance degradation)", async () => {
      const localGraph = createMockLocalGraph();

      const router = new QueryRouter(localGraph);

      const start = Date.now();
      await router.execute("get_function", { key: "fn1" });
      const elapsed = Date.now() - start;
      // Should be well under 100ms for a mock
      expect(elapsed).toBeLessThan(100);
    });
  });

  // ── Task 8.6: Mode-Aware Response Tests ──────────────────────────

  describe("mode-aware responses (8.6)", () => {
    it("local mode includes mode in _meta", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("local");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.mode).toBe("local");
      expect(result._meta.tools_degraded).toBeUndefined();
    });

    it("setup mode returns informational response (not an error)", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("setup", "Repository not configured");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.mode).toBe("setup");
      expect(result._meta.mode_reason).toBe("Repository not configured");
      expect(result._meta.tools_degraded).toBeDefined();
      expect(result._meta.tools_degraded?.length).toBeGreaterThan(0);

      const content = result.content as { message: string; available: boolean };
      expect(content.available).toBe(false);
      expect(content.message).toContain("unerr is not yet configured");
    });

    it("setup mode returns informational for all tools", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("setup");

      const result = await router.execute("semantic_search", { query: "auth" });
      expect(result._meta.mode).toBe("setup");
      const content = result.content as {
        message: string;
        tool: string;
        available: boolean;
      };
      expect(content.tool).toBe("semantic_search");
      expect(content.available).toBe(false);
    });

    it("local mode serves local tools normally", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("local", "Cloud unavailable");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.mode).toBe("local");
      expect(result._meta.source).toBe("local");
      expect(result._meta.mode_reason).toBe("Cloud unavailable");
      // Content should be the actual entity, not an error
      expect((result.content as { key: string }).key).toBe("fn1");
    });

    it("local mode has no degraded tools", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("local", "Local only");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.mode).toBe("local");
      expect(result._meta.tools_degraded).toBeUndefined();
    });

    it("parse mode degrades get_conventions", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("parse", "No repo configured");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.mode).toBe("parse");
      // check_rules and get_business_context removed — disabled tools
      expect(result._meta.tools_degraded).toContain("get_conventions");
    });

    it("parse mode serves local tools", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("parse");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.source).toBe("local");
      expect(result._meta.mode).toBe("parse");
    });

    it("local mode returns error on local failure (no cloud fallback)", async () => {
      const localGraph = createMockLocalGraph();
      (localGraph.getEntity as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("CozoDB error");
        }
      );

      const router = new QueryRouter(localGraph);
      router.setMode("local");

      const result = await router.execute("get_function", { key: "fn1" });
      expect(result._meta.mode).toBe("local");
      expect(result._meta.source).toBe("local");
      expect(result.content).toHaveProperty("error");
    });

    it("getMode returns current mode", () => {
      const router = new QueryRouter(createMockLocalGraph());
      expect(router.getMode()).toBe("local");
      router.setMode("parse");
      expect(router.getMode()).toBe("parse");
    });

    it("getDegradedTools lists all tools for setup mode", async () => {
      const router = new QueryRouter(createMockLocalGraph());
      router.setMode("setup");

      const result = await router.execute("get_function", { key: "fn1" });
      // All tools should be degraded in setup mode (19 = 18 base after disabling
      // get_rules, check_rules, get_business_context, semantic_search,
      // find_similar, unerr_revert_entity, 8 blueprint tools; +1 fetch_url;
      // +1 review_changes — Surface C local tool added to LOCAL_TOOLS)
      expect(result._meta.tools_degraded?.length).toBe(19);
    });
  });

  // ── Sprint 2: Response Enrichment Tests ──────────────────────────

  describe("Sprint 2: Response Enrichment", () => {
    // ── 2.1: Response Envelope ──────────────────────────────────────

    describe("2.1: Response envelope", () => {
      it("every response includes _meta with source and latency_ms", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._meta).toBeDefined();
        expect(result._meta.source).toBeDefined();
        expect(result._meta.latency_ms).toBeGreaterThanOrEqual(0);
      });

      it("_meta includes blast_radius for entity tools", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._meta.blast_radius).toBeDefined();
        expect(result._meta.blast_radius?.direct_callers).toBe(3);
        expect(result._meta.blast_radius?.direct_callees).toBe(2);
        expect(result._meta.blast_radius?.transitive_depth2).toBe(8);
        expect(result._meta.blast_radius?.is_chokepoint).toBe(false);
      });

      it("_meta includes conventions for entity tools", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._meta.conventions).toBeDefined();
        expect(result._meta.conventions?.length).toBeGreaterThan(0);
        expect(result._meta.conventions?.[0]?.name).toBe("Error handler");
        expect(result._meta.conventions?.[0]?.adherence_pct).toBe(10);
      });
    });

    // ── 2.2: Blast Radius Injection ────────────────────────────────

    describe("2.2: Blast radius injection", () => {
      it("injects blast_radius in _context for first entity query", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.signals).toBeDefined();
        expect(findSignal(result, "direct caller")).toBeDefined();
      });

      it("does not inject blast_radius for non-entity tools", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("search_code", {
          query: "something",
        });
        expect(result._meta.blast_radius).toBeUndefined();
      });

      it("marks chokepoints when detected", async () => {
        const localGraph = createMockLocalGraph();
        (localGraph.getBlastRadius as ReturnType<typeof vi.fn>).mockReturnValue(
          {
            direct_callers: 10,
            direct_callees: 8,
            transitive_count: 45,
            transitive_depth: 2,
            is_chokepoint: true,
            summary: "10 direct callers, 8 direct callees, CHOKEPOINT",
          }
        );
        // Also need entity with high fan_in/fan_out
        (localGraph.getEntity as ReturnType<typeof vi.fn>).mockReturnValue({
          key: "fn1",
          kind: "function",
          name: "doStuff",
          file_path: "src/index.ts",
          start_line: 10,
          signature: "()",
          body: "function doStuff() {}",
          fan_in: 10,
          fan_out: 8,
          risk_level: "high",
        });
        const router = new QueryRouter(localGraph);

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._meta.blast_radius?.is_chokepoint).toBe(true);
        expect(hasSignalContaining(result, "CHOKEPOINT")).toBe(true);
      });
    });

    // ── 2.3: Convention Context Injection ──────────────────────────

    describe("2.3: Convention context injection", () => {
      it("injects conventions in _context with adherence rates", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.signals).toBeDefined();
        const conventionSignal = findSignal(result, "Error handler");
        expect(conventionSignal).toBeDefined();
        expect(conventionSignal?.type).toBe("guidance");
      });

      it("skips convention injection for non-entity tools", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const result = await router.execute("get_rules", {});
        expect(hasSignalContaining(result, "Error handler")).toBe(false);
      });
    });

    // ── 2.4: Session Deduplication ─────────────────────────────────

    describe("2.4: Session deduplication", () => {
      it("first query includes blast radius, second omits it", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r1, "direct caller")).toBeDefined();
        expect(r1._meta.blast_radius).toBeDefined();

        const r2 = await router.execute("get_function", { key: "fn1" });
        expect(r2._meta.blast_radius).toBeUndefined();
      });

      it("different entities each get their own blast radius", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r1, "direct caller")).toBeDefined();

        const r2 = await router.execute("get_function", { key: "fn2" });
        expect(findSignal(r2, "direct caller")).toBeDefined();
      });

      it("conventions are deduped across entities", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r1, "Error handler")).toBeDefined();

        // Same conventions should be deduped on second entity
        const r2 = await router.execute("get_function", { key: "fn2" });
        expect(r2._meta.conventions).toBeUndefined();
      });
    });

    // ── 2.5: Proactive Drift Alerts ────────────────────────────────

    describe("2.5: Proactive drift alerts", () => {
      it("injects drift_alert when entity is modified", async () => {
        const driftEntities: DriftEntity[] = [
          {
            key: "fn1",
            name: "doStuff",
            kind: "function",
            signature: "()",
            body: "function doStuff() { return 'modified' }",
            file_path: "src/index.ts",
            line_start: 10,
            line_end: 12,
            content_hash: "abc123",
            drift_status: "modified",
            intent_id: "intent_001",
            modified_at: "2026-03-09T10:00:00Z",
            origin: "human",
            previous_body: "",
            previous_signature: "",
          },
        ];
        const localGraph = createMockLocalGraph({ driftEntities });
        const router = new QueryRouter(localGraph);
        router.setBranchContext({
          currentBranch: "feature/auth",
          baseBranch: "main",
          baseCommit: "abc",
          commitsAhead: 1,
          commitsBehind: 0,
          headSha: "def",
          computedAt: "2026-03-09",
        });

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.signals).toBeDefined();
        const driftSignal = findSignal(result, "modified");
        expect(driftSignal).toBeDefined();
        expect(driftSignal?.type).toBe("warning");
      });

      it("drift alert fires only once per entity per session", async () => {
        const driftEntities: DriftEntity[] = [
          {
            key: "fn1",
            name: "doStuff",
            kind: "function",
            signature: "()",
            body: "modified body",
            file_path: "src/index.ts",
            line_start: 10,
            line_end: 12,
            content_hash: "abc",
            drift_status: "modified",
            intent_id: "i1",
            modified_at: "2026-03-09T10:00:00Z",
            origin: "mixed",
            previous_body: "",
            previous_signature: "",
          },
        ];
        const localGraph = createMockLocalGraph({ driftEntities });
        const router = new QueryRouter(localGraph);
        router.setBranchContext({
          currentBranch: "main",
          baseBranch: "main",
          baseCommit: null,
          commitsAhead: 0,
          commitsBehind: null,
          headSha: "abc",
          computedAt: "2026-03-09",
        });

        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r1, "modified")).toBeDefined();

        const r2 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r2, "modified")).toBeUndefined();
      });

      it("no drift_alert when entity has no drift", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        const result = await router.execute("get_function", { key: "fn1" });
        // No drift entities, so no drift warning signal
        expect(findSignal(result, "WARNING")).toBeUndefined();
      });
    });

    // ── 2.6: Session Greeting ──────────────────────────────────────
    // DEPRECATED: `_context.session_greeting` was replaced by the structured
    // `session_brief` (see src/intelligence/session-brief-builder.ts and its
    // dedicated tests in session-brief-builder.test.ts). Keep these as `.skip`
    // so the history is visible without blocking CI.

    describe.skip("2.6: Session greeting (deprecated — see session-brief-builder.test.ts)", () => {
      it("first MCP response includes session_greeting", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setHealthInfo("B", { entities: 500, edges: 1200, rules: 10 });

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.session_greeting).toBeDefined();
        expect(result._context?.session_greeting).toContain("B");
      });

      it("greeting fires exactly once per session", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setHealthInfo("A", { entities: 100, edges: 300, rules: 5 });

        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(r1._context?.session_greeting).toBeDefined();

        const r2 = await router.execute("get_function", { key: "fn2" });
        expect(r2._context?.session_greeting).toBeUndefined();
      });

      it("greeting varies by health grade — A+ is healthy", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setHealthInfo("A+", { entities: 200, edges: 400, rules: 8 });

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.session_greeting).toContain("healthy");
      });

      it("greeting varies by health grade — C shows concern", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setHealthInfo("C", { entities: 800, edges: 200, rules: 3 });

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.session_greeting).toContain("C");
        expect(result._context?.session_greeting).toContain(
          "structural issues"
        );
      });

      it("greeting varies by health grade — D/F shows warning", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setHealthInfo("D", { entities: 1000, edges: 100, rules: 1 });

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.session_greeting).toContain("Warning");
      });

      it("PARSE mode gets lite greeting", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setMode("parse");

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.session_greeting).toContain("parse mode");
      });

      it("no health info still produces a default greeting", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.session_greeting).toContain("proxy ready");
      });

      it("greeting on non-entity tools too", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setHealthInfo("B", { entities: 500, edges: 1000, rules: 5 });

        const result = await router.execute("search_code", {
          query: "auth",
        });
        expect(result._context?.session_greeting).toBeDefined();
      });
    });

    // ── 2.7: Value Counter ─────────────────────────────────────────

    describe("2.7: Value counter", () => {
      it("injects value_counter every 3rd caught event after 10 tool calls", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const events = {
          conventionViolationsCaught: 0,
          chokepointWarningsIssued: 0,
          circularDepsDetected: 0,
          signaturePreservations: 0,
          deadCodeReferences: 0,
          aiEntitiesModified: 0,
          humanEntitiesModified: 0,
          mixedEntitiesModified: 0,
        };
        router.setSessionEvents(events);

        // Make 11 tool calls (need >10 for counter to fire)
        for (let i = 0; i < 11; i++) {
          await router.execute("search_code", { query: "x" });
        }

        // Set caught events to 3 (divisible by 3)
        events.conventionViolationsCaught = 3;

        const result = await router.execute("search_code", { query: "y" });
        expect(result._context?.value_counter).toBeDefined();
        expect(result._context?.value_counter).toContain("3 issues");
      });

      it("does not inject value_counter when <=10 tool calls", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const events = {
          conventionViolationsCaught: 3,
          chokepointWarningsIssued: 0,
          circularDepsDetected: 0,
          signaturePreservations: 0,
          deadCodeReferences: 0,
          aiEntitiesModified: 0,
          humanEntitiesModified: 0,
          mixedEntitiesModified: 0,
        };
        router.setSessionEvents(events);

        // Only 5 calls — not enough
        for (let i = 0; i < 5; i++) {
          await router.execute("search_code", { query: "x" });
        }

        const result = await router.execute("search_code", { query: "y" });
        expect(result._context?.value_counter).toBeUndefined();
      });

      it("does not inject when caught events not divisible by 3", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const events = {
          conventionViolationsCaught: 2,
          chokepointWarningsIssued: 0,
          circularDepsDetected: 0,
          signaturePreservations: 0,
          deadCodeReferences: 0,
          aiEntitiesModified: 0,
          humanEntitiesModified: 0,
          mixedEntitiesModified: 0,
        };
        router.setSessionEvents(events);

        for (let i = 0; i < 12; i++) {
          await router.execute("search_code", { query: "x" });
        }

        const result = await router.execute("search_code", { query: "y" });
        expect(result._context?.value_counter).toBeUndefined();
      });

      it("counter fires only once per threshold crossing", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        const events = {
          conventionViolationsCaught: 0,
          chokepointWarningsIssued: 0,
          circularDepsDetected: 0,
          signaturePreservations: 0,
          deadCodeReferences: 0,
          aiEntitiesModified: 0,
          humanEntitiesModified: 0,
          mixedEntitiesModified: 0,
        };
        router.setSessionEvents(events);

        // 11 calls
        for (let i = 0; i < 11; i++) {
          await router.execute("search_code", { query: "x" });
        }

        events.conventionViolationsCaught = 3;
        const r1 = await router.execute("search_code", { query: "a" });
        expect(r1._context?.value_counter).toBeDefined();

        // Same count — should not fire again
        const r2 = await router.execute("search_code", { query: "b" });
        expect(r2._context?.value_counter).toBeUndefined();

        // Advance to 6
        events.conventionViolationsCaught = 6;
        const r3 = await router.execute("search_code", { query: "c" });
        expect(r3._context?.value_counter).toBeDefined();
        expect(r3._context?.value_counter).toContain("6 issues");
      });
    });

    // ── Task 7.8: Post-compaction context recovery ─────────────────
    // DEPRECATED: `_context.reminder = "Previously queried: ..."` was removed
    // (query-router.ts:1618 comment: "redundant noise — showed up twice as
    // ur|ctx + ur|fct"). Re-query of seen entities is now signaled via
    // `_meta.context_complete = true` + the `ur|ctx already delivered` prefix.

    describe.skip("post-compaction reminder (deprecated — see _meta.context_complete)", () => {
      it("injects _context reminder signal on re-query of previously-seen entity", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        // First query — records history, no reminder
        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r1, "Previously queried")).toBeUndefined();

        // Second query — should inject reminder as a context signal
        const r2 = await router.execute("get_function", { key: "fn1" });
        const reminderSignal = findSignal(r2, "Previously queried");
        expect(reminderSignal).toBeDefined();
        expect(reminderSignal?.type).toBe("context");
      });

      it("reminder includes blast radius count from first query", async () => {
        const localGraph = createMockLocalGraph();
        (localGraph.getBlastRadius as ReturnType<typeof vi.fn>).mockReturnValue(
          {
            direct_callers: 7,
            direct_callees: 3,
            transitive_count: 15,
            is_chokepoint: false,
            summary: "7 callers, 15 transitive dependents",
          }
        );
        const router = new QueryRouter(localGraph);

        // First query — records blast radius
        await router.execute("get_function", { key: "fn1" });

        // Second query — reminder reflects blast radius from first query
        const r2 = await router.execute("get_function", { key: "fn1" });
        expect(hasSignalContaining(r2, "7 callers")).toBe(true);
      });

      it("different entities get independent reminders", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        // Query fn1 first
        await router.execute("get_function", { key: "fn1" });

        // Query fn2 first time — no reminder
        const r2 = await router.execute("get_function", { key: "fn2" });
        expect(findSignal(r2, "Previously queried")).toBeUndefined();

        // Re-query fn1 — should get reminder
        const r3 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r3, "Previously queried")).toBeDefined();
      });

      it("reminder is short (<50 tokens)", async () => {
        const router = new QueryRouter(createMockLocalGraph());

        await router.execute("get_function", { key: "fn1" });
        const r2 = await router.execute("get_function", { key: "fn1" });
        const reminderSignal = findSignal(r2, "Previously queried");
        const reminder = reminderSignal?.content ?? "";
        // Rough token estimate: words + punctuation < 50
        const wordCount = reminder.split(/\s+/).length;
        expect(wordCount).toBeLessThan(50);
      });
    });

    // ── Task 7.3: Push-based pending violations ───────────────────

    describe("pending violations injection", () => {
      it("injects pending_violations from store into _context", async () => {
        const { PendingViolationStore } = await import(
          "../tracking/pending-violations.js"
        );
        const store = new PendingViolationStore();
        const router = new QueryRouter(createMockLocalGraph());
        router.setPendingViolations(store);

        // Simulate file-watcher adding violations
        store.addViolations("src/a.ts", [
          {
            ruleKey: "rule-1",
            ruleName: "naming-convention",
            severity: "warning",
            message: "Function should use camelCase",
            filePath: "src/a.ts",
            line: 10,
          },
        ]);

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context?.signals).toBeDefined();
        const violationSignal = findSignal(
          result,
          "Function should use camelCase"
        );
        expect(violationSignal).toBeDefined();
        expect(violationSignal?.type).toBe("warning");
      });

      it("clears violations after draining", async () => {
        const { PendingViolationStore } = await import(
          "../tracking/pending-violations.js"
        );
        const store = new PendingViolationStore();
        const router = new QueryRouter(createMockLocalGraph());
        router.setPendingViolations(store);

        store.addViolations("src/a.ts", [
          {
            ruleKey: "rule-1",
            ruleName: "naming",
            severity: "warning",
            message: "bad name",
            filePath: "src/a.ts",
          },
        ]);

        // First call drains
        const r1 = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(r1, "bad name")).toBeDefined();

        // Second call — no violations pending
        const r2 = await router.execute("get_function", { key: "fn2" });
        expect(findSignal(r2, "Rule violation")).toBeUndefined();
      });

      it("does not inject when no violations pending", async () => {
        const { PendingViolationStore } = await import(
          "../tracking/pending-violations.js"
        );
        const store = new PendingViolationStore();
        const router = new QueryRouter(createMockLocalGraph());
        router.setPendingViolations(store);

        const result = await router.execute("get_function", { key: "fn1" });
        expect(findSignal(result, "Rule violation")).toBeUndefined();
      });
    });

    // ── Cross-cutting: mode degradation ────────────────────────────

    describe("enrichment graceful degradation", () => {
      it("setup mode still tracks tool calls but skips enrichment", async () => {
        const router = new QueryRouter(createMockLocalGraph());
        router.setMode("setup");

        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._context).toBeUndefined();
        expect(router.sessionContext.getToolCallCount()).toBe(1);
      });

      it("enrichment does not break when localGraph methods throw", async () => {
        const localGraph = createMockLocalGraph();
        (
          localGraph.getBlastRadius as ReturnType<typeof vi.fn>
        ).mockImplementation(() => {
          throw new Error("CozoDB error");
        });
        (
          localGraph.getConventionsForEntity as ReturnType<typeof vi.fn>
        ).mockImplementation(() => {
          throw new Error("Convention error");
        });
        const router = new QueryRouter(localGraph);

        // Should not throw — enrichment failures are caught
        const result = await router.execute("get_function", { key: "fn1" });
        expect(result._meta.source).toBe("local");
        expect(result.content).toBeDefined();
      });
    });
  });

  // ── Task 6.8: Context Placement Strategy ─────────────────────────

  describe("orderContextFields — Lost in the Middle priority", () => {
    it("orders critical fields before informational fields", () => {
      const input = {
        conventions: ["naming: camelCase (92%)"],
        blast_radius: "14 callers, 38 transitive dependents",
        value_counter: "unerr caught 3 issues",
        drift_alert: "WARNING: modified locally",
        session_greeting: "Welcome to unerr",
        reminder: "Previously queried: 5 callers, risk=high",
        related_issues: ["Chokepoint detected"],
        pending_violations: [
          { file: "a.ts", rule: "naming", message: "Bad name" },
        ],
      };

      const ordered = orderContextFields(input);
      const keys = Object.keys(ordered);

      // Critical fields come first
      expect(keys[0]).toBe("blast_radius");
      expect(keys[1]).toBe("pending_violations");
      expect(keys[2]).toBe("drift_alert");
      expect(keys[3]).toBe("reminder");

      // Informational fields come after
      expect(keys[4]).toBe("conventions");
      expect(keys[5]).toBe("related_issues");
      expect(keys[6]).toBe("session_greeting");
      expect(keys[7]).toBe("value_counter");
    });

    it("preserves field values during reordering", () => {
      const input = {
        conventions: ["use snake_case"],
        blast_radius: "3 callers",
        drift_alert: "modified 2 min ago",
      };

      const ordered = orderContextFields(input);
      expect(ordered.blast_radius).toBe("3 callers");
      expect(ordered.drift_alert).toBe("modified 2 min ago");
      expect(ordered.conventions).toEqual(["use snake_case"]);
    });

    it("omits undefined fields (sparse context)", () => {
      const ordered = orderContextFields({
        blast_radius: "5 callers",
        value_counter: "caught 2 issues",
      });

      const keys = Object.keys(ordered);
      expect(keys).toEqual(["blast_radius", "value_counter"]);
      expect(keys).toHaveLength(2);
    });

    it("handles empty context", () => {
      const ordered = orderContextFields({});
      expect(Object.keys(ordered)).toHaveLength(0);
    });
  });

  // L8.3: Deferred Embedding Status Tests — disabled (semantic_search/find_similar removed from LOCAL_TOOLS)
});
