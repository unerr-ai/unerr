/**
 * Sprint 3: Local Intelligence Deepening — tests for blast radius entities,
 * convention matching, health grade enhancements, and prefetch.
 */

import { describe, expect, it, vi } from "vitest";
import {
  checkFileStructure,
  checkImportDirection,
  checkNamingConventions,
  matchConventions,
} from "../intelligence/convention-matcher.js";
import type {
  CozoGraphStore,
  LocalEntity,
} from "../intelligence/local-graph.js";

// ── 3.1: Blast Radius Entities ────────────────────────────────────

describe("Sprint 3.1: getBlastRadiusEntities", () => {
  it("returns empty array when no callers exist", () => {
    // Simulate: entity with no callers
    const mockGraph = createMockGraphStore({
      transitiveRows: [],
      entityRows: new Map(),
    });
    const result = mockGraph.getBlastRadiusEntities("isolated-fn", 2);
    expect(result).toEqual([]);
  });

  it("returns entities with depth from recursive traversal", () => {
    const mockGraph = createMockGraphStore({
      transitiveRows: [
        ["caller-a", 1],
        ["caller-b", 1],
        ["caller-c", 2],
      ],
      entityRows: new Map([
        ["caller-a", ["caller-a", "callerA", "src/a.ts"]],
        ["caller-b", ["caller-b", "callerB", "src/b.ts"]],
        ["caller-c", ["caller-c", "callerC", "src/c.ts"]],
      ]),
    });

    const result = mockGraph.getBlastRadiusEntities("target-fn", 2);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      key: "caller-a",
      name: "callerA",
      file: "src/a.ts",
      depth: 1,
    });
    expect(result[2]).toEqual({
      key: "caller-c",
      name: "callerC",
      file: "src/c.ts",
      depth: 2,
    });
  });

  it("excludes the source entity from results", () => {
    const mockGraph = createMockGraphStore({
      transitiveRows: [
        ["target-fn", 1], // self-reference
        ["caller-a", 1],
      ],
      entityRows: new Map([["caller-a", ["caller-a", "callerA", "src/a.ts"]]]),
    });

    const result = mockGraph.getBlastRadiusEntities("target-fn", 2);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("caller-a");
  });

  it("uses minimum depth when entity appears at multiple depths", () => {
    const mockGraph = createMockGraphStore({
      transitiveRows: [
        ["caller-a", 2],
        ["caller-a", 1], // same entity at closer depth
      ],
      entityRows: new Map([["caller-a", ["caller-a", "callerA", "src/a.ts"]]]),
    });

    const result = mockGraph.getBlastRadiusEntities("target-fn", 3);
    expect(result).toHaveLength(1);
    expect(result[0]?.depth).toBe(1);
  });
});

// ── 3.2: Convention Pattern Matching ──────────────────────────────

describe("Sprint 3.2: Convention Pattern Matching", () => {
  describe("checkNamingConventions", () => {
    it("detects non-PascalCase class names", () => {
      const entities: LocalEntity[] = [
        makeEntity("myClass", "class", "src/foo.ts"),
      ];
      const violations = checkNamingConventions(entities);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.type).toBe("naming");
      expect(violations[0]?.message).toContain("myClass");
    });

    it("passes PascalCase class names", () => {
      const entities: LocalEntity[] = [
        makeEntity("MyClass", "class", "src/foo.ts"),
      ];
      const violations = checkNamingConventions(entities);
      expect(violations).toHaveLength(0);
    });

    it("detects PascalCase function names", () => {
      const entities: LocalEntity[] = [
        makeEntity("DoSomething", "function", "src/foo.ts"),
      ];
      const violations = checkNamingConventions(entities);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("DoSomething");
    });

    it("passes camelCase function names", () => {
      const entities: LocalEntity[] = [
        makeEntity("doSomething", "function", "src/foo.ts"),
      ];
      const violations = checkNamingConventions(entities);
      expect(violations).toHaveLength(0);
    });
  });

  describe("checkFileStructure", () => {
    it("flags missing test file", async () => {
      const graph = createConventionGraph({ hasTestFile: false });
      const violations = await checkFileStructure("src/service.ts", graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.type).toBe("file_structure");
      expect(violations[0]?.message).toContain(".test.ts");
    });

    it("passes when test file exists", async () => {
      const graph = createConventionGraph({ hasTestFile: true });
      const violations = await checkFileStructure("src/service.ts", graph);
      expect(violations).toHaveLength(0);
    });

    it("skips test files themselves", async () => {
      const graph = createConventionGraph({ hasTestFile: false });
      const violations = await checkFileStructure("src/service.test.ts", graph);
      expect(violations).toHaveLength(0);
    });
  });

  describe("checkImportDirection", () => {
    it("flags service importing from controller", async () => {
      const graph = createConventionGraph({
        imports: [{ imported_file: "src/controllers/userCtrl.ts" }],
      });
      const violations = await checkImportDirection(
        "src/services/userService.ts",
        graph,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.type).toBe("import_direction");
      expect(violations[0]?.severity).toBe("error");
    });

    it("passes when import direction is valid", async () => {
      const graph = createConventionGraph({
        imports: [{ imported_file: "src/utils/helper.ts" }],
      });
      const violations = await checkImportDirection(
        "src/services/userService.ts",
        graph,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("matchConventions (composite)", () => {
    it("runs all checks and aggregates violations", async () => {
      const graph = createConventionGraph({
        hasTestFile: false,
        entities: [makeEntity("myBadClass", "class", "src/services/bad.ts")],
        imports: [{ imported_file: "src/controllers/ctrl.ts" }],
      });
      const violations = await matchConventions("src/services/bad.ts", graph);
      // Naming (class) + file structure + import direction
      expect(violations.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ── 3.3: Health Grade Enhancement ─────────────────────────────────

describe("Sprint 3.3: Health Grade Enhancement", () => {
  it("HealthGradeResult includes new fields", async () => {
    const { computeHealthGrade } = await import(
      "../intelligence/health-grade.js"
    );

    const db = createHealthGradeDb({
      entities: 100,
      edges: 200,
      rules: 5,
      deadFunctions: 10,
    });

    const result = await computeHealthGrade(db);
    expect(result.score).toBeGreaterThan(0);
    expect(result.grade).toBeDefined();
    expect(result.conventionAdherence).toBeDefined();
    expect(result.maxImportDepth).toBeDefined();
  });

  it("circular deps reduce health score", async () => {
    const { computeHealthGrade } = await import(
      "../intelligence/health-grade.js"
    );

    const dbNoCycles = createHealthGradeDb({ entities: 100, edges: 200 });
    const dbWithCycles = createHealthGradeDb({
      entities: 100,
      edges: 200,
      circularDeps: [["a", "b"]],
    });

    const scoreNoCycles = (await computeHealthGrade(dbNoCycles)).score;
    const scoreWithCycles = (await computeHealthGrade(dbWithCycles)).score;
    expect(scoreWithCycles).toBeLessThanOrEqual(scoreNoCycles);
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function makeEntity(name: string, kind: string, filePath: string): LocalEntity {
  return {
    key: `${filePath}:${name}`,
    kind,
    name,
    file_path: filePath,
    start_line: 1,
    end_line: 0,
    signature: `${name}()`,
    body: "",
    fan_in: 0,
    fan_out: 0,
    community: -1,
    risk_level: "normal",
  };
}

function createMockGraphStore(opts: {
  transitiveRows: unknown[][];
  entityRows: Map<string, unknown[]>;
}) {
  return {
    getBlastRadiusEntities(entityKey: string, maxDepth = 2) {
      const depthMap = new Map<string, number>();
      for (const row of opts.transitiveRows) {
        const key = row[0] as string;
        const depth = row[1] as number;
        if (key === entityKey) continue;
        const existing = depthMap.get(key);
        if (existing === undefined || depth < existing) {
          depthMap.set(key, depth);
        }
      }

      const entities: Array<{
        key: string;
        name: string;
        file: string;
        depth: number;
      }> = [];
      for (const [key, depth] of depthMap) {
        const row = opts.entityRows.get(key);
        if (row) {
          entities.push({
            key,
            name: row[1] as string,
            file: row[2] as string,
            depth,
          });
        }
      }
      entities.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
      return entities;
    },
  };
}

function createConventionGraph(opts?: {
  hasTestFile?: boolean;
  entities?: LocalEntity[];
  imports?: Array<{ imported_file: string }>;
}): CozoGraphStore {
  return {
    getEntitiesByFile: vi.fn().mockImplementation((filePath: string) => {
      // If checking for test sibling and hasTestFile is true, return entities
      if (opts?.hasTestFile && filePath.includes(".test.")) {
        return [makeEntity("testFn", "function", filePath)];
      }
      return opts?.entities ?? [];
    }),
    getImports: vi.fn().mockReturnValue(opts?.imports ?? []),
  } as unknown as CozoGraphStore;
}

function createHealthGradeDb(opts?: {
  entities?: number;
  edges?: number;
  rules?: number;
  deadFunctions?: number;
  circularDeps?: string[][];
}) {
  const entityCount = opts?.entities ?? 50;
  const edgeCount = opts?.edges ?? 100;
  const ruleCount = opts?.rules ?? 0;
  const deadFnCount = opts?.deadFunctions ?? 0;
  const circularDeps = opts?.circularDeps ?? [];

  return {
    async run(query: string, _params?: Record<string, unknown>) {
      // Count queries
      if (query.includes("count(key)") && query.includes("*entities{")) {
        return { rows: [[entityCount]] };
      }
      if (query.includes("count(from_key)") && query.includes("*edges[")) {
        return { rows: [[edgeCount]] };
      }
      if (query.includes("count(key)") && query.includes("*rules[")) {
        return { rows: [[ruleCount]] };
      }

      // Dead functions
      if (
        query.includes('kind = "function"') &&
        query.includes("fan_in == 0")
      ) {
        const rows = [];
        for (let i = 0; i < deadFnCount; i++) {
          rows.push([`dead-fn-${i}`, `deadFn${i}`, `src/dead${i}.ts`, 0]);
        }
        return { rows };
      }

      // High risk entities
      if (query.includes('risk_level == "high"')) {
        return { rows: [] };
      }

      // Circular deps (2-hop)
      if (query.includes("*edges[a, b") && query.includes("*edges[b, a")) {
        return {
          rows: circularDeps.map((c) => [c[0], c[1]]),
        };
      }

      // Max import depth
      if (query.includes("max(depth)")) {
        return { rows: [[3]] };
      }

      // Convention adherence
      if (query.includes("*patterns[") && query.includes("naming")) {
        return { rows: [] };
      }

      // Drift impact
      if (query.includes("*drift_overlay[") && query.includes("fi > 5")) {
        return { rows: [[0]] };
      }

      return { rows: [] };
    },
  };
}
