/**
 * Phase 10b TEST-02/03/04: Rule evaluator tests.
 *
 * Tests naming rule evaluation (regex against entity names).
 * Structural tests are integration-level (require tree-sitter WASM).
 */

import { describe, expect, it, vi } from "vitest";

// Mock web-tree-sitter to avoid resolution error in test environment
vi.mock("web-tree-sitter", () => ({
  default: {
    init: vi.fn(),
    Language: { load: vi.fn() },
  },
}));

import type {
  CompactRule,
  CozoGraphStore,
} from "../intelligence/local-graph.js";
import { evaluateRules } from "../intelligence/rule-evaluator.js";

function createMockLocalGraph(
  entities: Array<{
    key: string;
    kind: string;
    name: string;
    file_path: string;
    start_line: number;
    signature: string;
    body: string;
  }> = []
): CozoGraphStore {
  return {
    getEntitiesByFile: vi.fn().mockReturnValue(entities),
    getEntity: vi.fn(),
    getCallersOf: vi.fn().mockReturnValue([]),
    getCalleesOf: vi.fn().mockReturnValue([]),
    searchEntities: vi.fn().mockReturnValue([]),
    getImports: vi.fn().mockReturnValue([]),
    healthCheck: vi.fn().mockReturnValue({ status: "up", latencyMs: 0 }),
    isLoaded: vi.fn().mockReturnValue(true),
    loadSnapshot: vi.fn(),
    loadRules: vi.fn(),
    loadPatterns: vi.fn(),
    hasRules: vi.fn().mockReturnValue(true),
    getRules: vi.fn().mockReturnValue([]),
    getPatterns: vi.fn().mockReturnValue([]),
    loadRuleExceptions: vi.fn(),
    getRuleExceptions: vi.fn().mockReturnValue([]),
    getExpiringExceptions: vi.fn().mockReturnValue([]),
  } as unknown as CozoGraphStore;
}

describe("evaluateRules", () => {
  describe("naming engine", () => {
    it("detects naming violations via regex", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-1",
          name: "PascalCase classes",
          scope: "repo",
          severity: "error",
          engine: "naming",
          query: "^[a-z]",
          message: "Classes must start with uppercase",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
      ];

      const entities = [
        {
          key: "cls1",
          kind: "class",
          name: "myClass",
          file_path: "src/foo.ts",
          start_line: 5,
          signature: "class myClass",
          body: "",
        },
        {
          key: "cls2",
          kind: "class",
          name: "MyClass",
          file_path: "src/foo.ts",
          start_line: 20,
          signature: "class MyClass",
          body: "",
        },
      ];

      const localGraph = createMockLocalGraph(entities);
      const result = await evaluateRules(rules, "src/foo.ts", "", localGraph);

      expect(result.violations.length).toBe(1);
      expect(result.violations[0]?.matchedCode).toBe("myClass");
      expect(result.violations[0]?.severity).toBe("error");
      expect(result._meta.engines.naming).toBe(1);
    });

    it("returns no violations when no entities match", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-1",
          name: "No test_ prefix",
          scope: "repo",
          severity: "warn",
          engine: "naming",
          query: "^test_",
          message: "Avoid test_ prefix",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
      ];

      const entities = [
        {
          key: "fn1",
          kind: "function",
          name: "doStuff",
          file_path: "src/foo.ts",
          start_line: 1,
          signature: "",
          body: "",
        },
      ];

      const localGraph = createMockLocalGraph(entities);
      const result = await evaluateRules(rules, "src/foo.ts", "", localGraph);
      expect(result.violations.length).toBe(0);
    });
  });

  describe("engine partitioning", () => {
    it("skips semgrep and llm rules", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-semgrep",
          name: "Semgrep rule",
          scope: "repo",
          severity: "warn",
          engine: "semgrep",
          query: "pattern-not: $X",
          message: "Semgrep",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
        {
          key: "rule-llm",
          name: "LLM rule",
          scope: "repo",
          severity: "info",
          engine: "llm",
          query: "review for security",
          message: "LLM review",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
      ];

      const localGraph = createMockLocalGraph();
      const result = await evaluateRules(
        rules,
        "src/foo.ts",
        "const x = 1",
        localGraph
      );

      expect(result.violations.length).toBe(0);
      expect(result._meta.skippedRules).toBe(2);
      expect(result._meta.evaluatedRules).toBe(0);
    });

    it("skips disabled rules", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-disabled",
          name: "Disabled rule",
          scope: "repo",
          severity: "warn",
          engine: "naming",
          query: ".*",
          message: "Match all",
          file_glob: "",
          enabled: false,
          repo_id: "repo-1",
        },
      ];

      const localGraph = createMockLocalGraph([
        {
          key: "fn1",
          kind: "function",
          name: "anything",
          file_path: "src/foo.ts",
          start_line: 1,
          signature: "",
          body: "",
        },
      ]);
      const result = await evaluateRules(rules, "src/foo.ts", "", localGraph);

      expect(result.violations.length).toBe(0);
      expect(result._meta.skippedRules).toBe(1);
    });
  });

  describe("structural engine (graceful degradation)", () => {
    it("returns empty violations when tree-sitter is not available", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-struct",
          name: "Structural rule",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "call_expression",
          message: "Found call",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
      ];

      const localGraph = createMockLocalGraph();
      const result = await evaluateRules(
        rules,
        "src/foo.ts",
        "console.log('hello')",
        localGraph
      );

      // Without tree-sitter WASM files installed, should gracefully return 0 violations
      expect(result._meta.engines.structural).toBe(1);
      expect(result._meta.source).toBe("local");
    });

    it("handles unsupported file extensions gracefully", async () => {
      const rules: CompactRule[] = [
        {
          key: "rule-struct",
          name: "Structural rule",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "call_expression",
          message: "Found call",
          file_glob: "",
          enabled: true,
          repo_id: "repo-1",
        },
      ];

      const localGraph = createMockLocalGraph();
      const result = await evaluateRules(
        rules,
        "src/foo.rb",
        "puts 'hello'",
        localGraph
      );

      expect(result.violations.length).toBe(0);
    });
  });

  describe("meta information", () => {
    it("reports correct engine counts", async () => {
      const rules: CompactRule[] = [
        {
          key: "r1",
          name: "R1",
          scope: "repo",
          severity: "warn",
          engine: "naming",
          query: "^_",
          message: "",
          file_glob: "",
          enabled: true,
          repo_id: "r",
        },
        {
          key: "r2",
          name: "R2",
          scope: "repo",
          severity: "warn",
          engine: "structural",
          query: "fn_def",
          message: "",
          file_glob: "",
          enabled: true,
          repo_id: "r",
        },
        {
          key: "r3",
          name: "R3",
          scope: "repo",
          severity: "warn",
          engine: "semgrep",
          query: "p",
          message: "",
          file_glob: "",
          enabled: true,
          repo_id: "r",
        },
        {
          key: "r4",
          name: "R4",
          scope: "repo",
          severity: "warn",
          engine: "naming",
          query: "^x",
          message: "",
          file_glob: "",
          enabled: false,
          repo_id: "r",
        },
      ];

      const localGraph = createMockLocalGraph();
      const result = await evaluateRules(rules, "src/foo.ts", "", localGraph);

      expect(result._meta.engines.naming).toBe(1);
      expect(result._meta.engines.structural).toBe(1);
      expect(result._meta.engines.skipped).toBe(2); // semgrep + disabled
      expect(result._meta.evaluatedRules).toBe(2);
      expect(result._meta.skippedRules).toBe(2);
    });
  });
});
