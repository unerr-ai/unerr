/**
 * Phase 10b TEST-01: CozoDB rules/patterns integration tests.
 */

import {
  type MockInstance,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import type {
  CompactPattern,
  CompactRule,
  SnapshotEnvelope,
} from "../intelligence/local-graph.js";

function createInMemoryDb(): CozoDb {
  // Minimal CozoDB mock using in-memory maps
  const relations = new Map<string, Map<string, unknown[]>>();

  return {
    async run(query: string, params?: Record<string, unknown>) {
      // Handle :create statements
      if (query.includes(":create ")) {
        const match = query.match(/:create\s+(\w+)/);
        if (match) {
          relations.set(match[1]!, new Map());
        }
        return Promise.resolve({ rows: [] });
      }

      // Handle :put statements
      if (query.includes(":put ")) {
        const match = query.match(/:put\s+(\w+)/);
        if (match) {
          const relation = relations.get(match[1]!);
          if (relation && params) {
            const key =
              (params.key as string) ??
              (params.token as string) ??
              (params.fp as string) ??
              `${params.from}-${params.to}-${params.type}`;
            relation.set(key, Object.values(params));
          }
        }
        return Promise.resolve({ rows: [] });
      }

      // Handle queries for rules
      if (query.includes("*rules[") && query.includes("enabled = true")) {
        const rulesRelation = relations.get("rules");
        if (!rulesRelation) return Promise.resolve({ rows: [] });
        return Promise.resolve({
          rows: Array.from(rulesRelation.values()).filter((row) => {
            // Check enabled field (index 8)
            return row[8] === true;
          }),
        });
      }

      if (query.includes("*rules[") && query.includes(":limit 1")) {
        const rulesRelation = relations.get("rules");
        if (!rulesRelation || rulesRelation.size === 0)
          return Promise.resolve({ rows: [] });
        return Promise.resolve({
          rows: [Array.from(rulesRelation.values())[0]!],
        });
      }

      // Handle queries for patterns
      if (query.includes("*patterns[")) {
        const patternsRelation = relations.get("patterns");
        if (!patternsRelation) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: Array.from(patternsRelation.values()) });
      }

      // Handle entity queries
      if (query.includes("*entities{") && params?.key) {
        const entitiesRelation = relations.get("entities");
        if (!entitiesRelation) return Promise.resolve({ rows: [] });
        const entry = entitiesRelation.get(params.key as string);
        return Promise.resolve({ rows: entry ? [entry] : [] });
      }

      // Handle file_index queries
      if (query.includes("*file_index[") && params?.fp) {
        const fileIndexRelation = relations.get("file_index");
        if (!fileIndexRelation) return Promise.resolve({ rows: [] });
        const matching: unknown[][] = [];
        for (const [, value] of fileIndexRelation) {
          if ((value as unknown[])[0] === params.fp) {
            // Return entity data
            const entityKey = (value as unknown[])[1] as string;
            const entitiesRelation = relations.get("entities");
            if (entitiesRelation) {
              const entity = entitiesRelation.get(entityKey);
              if (entity) matching.push(entity as unknown[]);
            }
          }
        }
        return Promise.resolve({ rows: matching });
      }

      // Handle :rm statements (no-op in mock)
      if (query.includes(":rm ")) {
        return Promise.resolve({ rows: [] });
      }

      // Handle drift_overlay full scan (getAllDriftEntities)
      if (query.includes("*drift_overlay[")) {
        const driftRelation = relations.get("drift_overlay");
        if (!driftRelation) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: Array.from(driftRelation.values()) });
      }

      // Handle entity lookup by key (getEntity inside applyDelta overlay expiry)
      if (
        query.includes("*entities{") &&
        query.includes("key = $key") &&
        params?.key
      ) {
        const entitiesRelation = relations.get("entities");
        if (!entitiesRelation) return Promise.resolve({ rows: [] });
        const entry = entitiesRelation.get(params.key as string);
        return Promise.resolve({ rows: entry ? [entry] : [] });
      }

      // Default: return empty
      return Promise.resolve({ rows: [] });
    },
  };
}

describe("CozoGraphStore — Rules & Patterns (Phase 10b)", () => {
  let db: CozoDb;
  let store: CozoGraphStore;

  beforeEach(async () => {
    db = createInMemoryDb();
    store = await CozoGraphStore.create(db);
  });

  describe("hasRules", () => {
    it("returns false when no rules loaded", async () => {
      expect(await store.hasRules()).toBe(false);
    });

    it("returns true after loading rules", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-1",
          name: "No console.log",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "call_expression",
          message: "Avoid console.log in production",
          file_glob: "**/*.ts",
          enabled: true,
          repo_id: "repo-1",
        },
      ];
      await store.loadRules(rules);
      expect(await store.hasRules()).toBe(true);
    });
  });

  describe("loadRules + getRules", () => {
    it("loads and retrieves rules", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-1",
          name: "No console.log",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "call_expression",
          message: "Avoid console.log",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
        {
          key: "rule-2",
          name: "PascalCase classes",
          scope: "org",
          severity: "error",
          engine: "naming",
          query: "^[a-z]",
          message: "Classes must be PascalCase",
          file_glob: "**/*.ts",
          enabled: true,
          repo_id: "repo-1",
        },
      ];
      await store.loadRules(rules);
      const result = await store.getRules();
      expect(result.length).toBe(2);
    });

    it("filters by file glob", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-ts",
          name: "TS only",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "call_expression",
          message: "TS rule",
          file_glob: "**/*.ts",
          enabled: true,
          repo_id: "repo-1",
        },
        {
          key: "rule-py",
          name: "Python only",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "function_definition",
          message: "Python rule",
          file_glob: "**/*.py",
          enabled: true,
          repo_id: "repo-1",
        },
      ];
      await store.loadRules(rules);
      const tsRules = await store.getRules("src/index.ts");
      expect(tsRules.length).toBe(1);
      expect(tsRules[0]?.key).toBe("rule-ts");
    });

    it("excludes disabled rules", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-disabled",
          name: "Disabled",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "call_expression",
          message: "Disabled",
          file_glob: "",
          enabled: false,
          repo_id: "repo-1",
        },
      ];
      await store.loadRules(rules);
      const result = await store.getRules();
      expect(result.length).toBe(0);
    });
  });

  describe("loadPatterns + getPatterns", () => {
    it("loads and retrieves patterns", async () => {
      const patterns: CompactPattern[] = [
        {
          key: "pattern-1",
          name: "Error Boundary",
          kind: "structural",
          frequency: 15,
          confidence: 0.85,
          exemplar_keys: ["file1:10", "file2:20"],
          promoted_rule_key: "",
        },
      ];
      await store.loadPatterns(patterns);
      const result = await store.getPatterns();
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Error Boundary");
      expect(result[0]?.exemplar_keys).toEqual(["file1:10", "file2:20"]);
    });
  });

  describe("loadSnapshot with v2 envelope", () => {
    it("loads rules and patterns from v2 envelope", async () => {
      const envelope: SnapshotEnvelope = {
        version: 2,
        repoId: "repo-1",
        orgId: "org-1",
        entities: [
          {
            key: "fn1",
            kind: "function",
            name: "doStuff",
            file_path: "src/index.ts",
            start_line: 10,
            end_line: 0,
            signature: "doStuff()",
            body: "return 42",
          },
        ],
        edges: [{ from_key: "fn1", to_key: "fn2", type: "calls" }],
        rules: [
          {
            key: "rule-1",
            name: "Test Rule",
            scope: "repo",
            severity: "warn",
            engine: "structural",
            query: "call_expression",
            message: "Test message",
            file_glob: "",
            enabled: true,
            repo_id: "repo-1",
          },
        ],
        patterns: [
          {
            key: "pattern-1",
            name: "Test Pattern",
            kind: "structural",
            frequency: 5,
            confidence: 0.9,
            exemplar_keys: ["ex1"],
            promoted_rule_key: "",
          },
        ],
        generatedAt: new Date().toISOString(),
      };
      await store.loadSnapshot(envelope);
      expect(await store.hasRules()).toBe(true);
      expect((await store.getRules()).length).toBe(1);
      expect((await store.getPatterns()).length).toBe(1);
    });

    it("loads v1 envelope without rules/patterns", async () => {
      const envelope: SnapshotEnvelope = {
        version: 1,
        repoId: "repo-1",
        orgId: "org-1",
        entities: [],
        edges: [],
        generatedAt: new Date().toISOString(),
      };
      await store.loadSnapshot(envelope);
      expect(await store.hasRules()).toBe(false);
      expect((await store.getPatterns()).length).toBe(0);
    });
  });

  // ── Task 6.9: Overlay Expiry After Delta ─────────────────────────

  describe("applyDelta — overlay expiry (Task 6.9)", () => {
    const emptyDelta = {
      entities: { added: [], updated: [], deletedKeys: [] },
      edges: { added: [], removed: [] },
      justifications: { updated: [] },
    };

    it("prunes overlay entry when base matches after delta", async () => {
      // Spy on the store methods to control overlay/entity data
      const driftEntities = [
        {
          key: "fn-1",
          name: "doStuff",
          kind: "function",
          signature: "doStuff(): void",
          body: "function doStuff() { return 1; }",
          file_path: "src/a.ts",
          line_start: 1,
          line_end: 5,
          content_hash: "abc",
          drift_status: "modified" as const,
          intent_id: "",
          modified_at: new Date().toISOString(),
          origin: "human" as const,
          previous_body: "",
          previous_signature: "",
        },
      ];
      vi.spyOn(store, "getAllDriftEntities").mockResolvedValue(driftEntities);
      vi.spyOn(store, "getEntity").mockResolvedValue({
        key: "fn-1",
        kind: "function",
        name: "doStuff",
        file_path: "src/a.ts",
        start_line: 1,
        end_line: 0,
        signature: "doStuff(): void",
        body: "function doStuff() { return 1; }",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
        community: -1,
      });
      const removeSpy = vi
        .spyOn(store, "removeDriftEntity")
        .mockResolvedValue(undefined);

      const result = await store.applyDelta(emptyDelta);

      expect(result.overlayExpired).toBe(1);
      expect(removeSpy).toHaveBeenCalledWith("fn-1");

      vi.restoreAllMocks();
    });

    it("does not prune overlay when base body differs", async () => {
      vi.spyOn(store, "getAllDriftEntities").mockResolvedValue([
        {
          key: "fn-2",
          name: "calc",
          kind: "function",
          signature: "calc(): number",
          body: "function calc() { return 2; }",
          file_path: "src/b.ts",
          line_start: 1,
          line_end: 3,
          content_hash: "xyz",
          drift_status: "modified" as const,
          intent_id: "",
          modified_at: new Date().toISOString(),
          origin: "ai" as const,
          previous_body: "",
          previous_signature: "",
        },
      ]);
      vi.spyOn(store, "getEntity").mockResolvedValue({
        key: "fn-2",
        kind: "function",
        name: "calc",
        file_path: "src/b.ts",
        start_line: 1,
        end_line: 0,
        signature: "calc(): number",
        body: "function calc() { return 999; }",
        fan_in: 0,
        fan_out: 0,
        risk_level: "normal",
        community: -1,
      });
      const removeSpy = vi
        .spyOn(store, "removeDriftEntity")
        .mockResolvedValue(undefined);

      const result = await store.applyDelta(emptyDelta);

      expect(result.overlayExpired).toBe(0);
      expect(removeSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("skips non-modified overlay entries (added/deleted)", async () => {
      vi.spyOn(store, "getAllDriftEntities").mockResolvedValue([
        {
          key: "fn-3",
          name: "newFn",
          kind: "function",
          signature: "newFn(): void",
          body: "function newFn() {}",
          file_path: "src/c.ts",
          line_start: 1,
          line_end: 1,
          content_hash: "h",
          drift_status: "added" as const,
          intent_id: "",
          modified_at: new Date().toISOString(),
          origin: "human" as const,
          previous_body: "",
          previous_signature: "",
        },
        {
          key: "fn-4",
          name: "oldFn",
          kind: "function",
          signature: "oldFn(): void",
          body: "function oldFn() {}",
          file_path: "src/d.ts",
          line_start: 1,
          line_end: 1,
          content_hash: "h2",
          drift_status: "deleted" as const,
          intent_id: "",
          modified_at: new Date().toISOString(),
          origin: "human" as const,
          previous_body: "",
          previous_signature: "",
        },
      ]);
      const removeSpy = vi
        .spyOn(store, "removeDriftEntity")
        .mockResolvedValue(undefined);

      const result = await store.applyDelta(emptyDelta);

      expect(result.overlayExpired).toBe(0);
      expect(removeSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("prunes selectively — only matching entries expire", async () => {
      vi.spyOn(store, "getAllDriftEntities").mockResolvedValue([
        {
          key: "fn-a",
          name: "alpha",
          kind: "function",
          signature: "alpha(): void",
          body: "SAME_BODY",
          file_path: "src/a.ts",
          line_start: 1,
          line_end: 1,
          content_hash: "h",
          drift_status: "modified" as const,
          intent_id: "",
          modified_at: new Date().toISOString(),
          origin: "human" as const,
          previous_body: "",
          previous_signature: "",
        },
        {
          key: "fn-b",
          name: "beta",
          kind: "function",
          signature: "beta(): void",
          body: "DIFFERENT_LOCAL",
          file_path: "src/b.ts",
          line_start: 1,
          line_end: 1,
          content_hash: "h2",
          drift_status: "modified" as const,
          intent_id: "",
          modified_at: new Date().toISOString(),
          origin: "ai" as const,
          previous_body: "",
          previous_signature: "",
        },
      ]);
      vi.spyOn(store, "getEntity").mockImplementation(async (key: string) => {
        if (key === "fn-a") {
          return {
            key: "fn-a",
            kind: "function",
            name: "alpha",
            file_path: "src/a.ts",
            start_line: 1,
            end_line: 0,
            signature: "alpha(): void",
            body: "SAME_BODY",
            fan_in: 0,
            fan_out: 0,
            risk_level: "normal",
            community: -1,
          };
        }
        if (key === "fn-b") {
          return {
            key: "fn-b",
            kind: "function",
            name: "beta",
            file_path: "src/b.ts",
            start_line: 1,
            end_line: 0,
            signature: "beta(): void",
            body: "DIFFERENT_BASE",
            fan_in: 0,
            fan_out: 0,
            risk_level: "normal",
            community: -1,
          };
        }
        return null;
      });
      const removeSpy = vi
        .spyOn(store, "removeDriftEntity")
        .mockResolvedValue(undefined);

      const result = await store.applyDelta(emptyDelta);

      expect(result.overlayExpired).toBe(1);
      expect(removeSpy).toHaveBeenCalledWith("fn-a");
      expect(removeSpy).not.toHaveBeenCalledWith("fn-b");

      vi.restoreAllMocks();
    });

    it("returns overlayExpired: 0 when no overlay entries exist", async () => {
      vi.spyOn(store, "getAllDriftEntities").mockResolvedValue([]);

      const result = await store.applyDelta(emptyDelta);

      expect(result.overlayExpired).toBe(0);

      vi.restoreAllMocks();
    });
  });
});
