/**
 * Phase 10b TEST-06: v2 snapshot envelope tests.
 */

import { describe, expect, it } from "vitest";
import type {
  CompactPattern,
  CompactRule,
  SnapshotEnvelope,
} from "../intelligence/local-graph.js";

describe("SnapshotEnvelope v2", () => {
  it("supports version 2 with rules and patterns", () => {
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
        },
      ],
      edges: [{ from_key: "fn1", to_key: "fn2", type: "calls" }],
      rules: [
        {
          key: "rule-1",
          name: "No eval",
          scope: "repo",
          severity: "error",
          engine: "structural",
          query: "call_expression",
          message: "Do not use eval()",
          file_glob: "**/*.ts",
          enabled: true,
          repo_id: "repo-1",
        },
      ],
      patterns: [
        {
          key: "pat-1",
          name: "Error boundary",
          kind: "structural",
          frequency: 12,
          confidence: 0.85,
          exemplar_keys: ["src/App.tsx:5", "src/Layout.tsx:10"],
          promoted_rule_key: "",
        },
      ],
      generatedAt: new Date().toISOString(),
    };

    expect(envelope.version).toBe(2);
    expect(envelope.rules?.length).toBe(1);
    expect(envelope.patterns?.length).toBe(1);
    expect(envelope.rules?.[0]?.engine).toBe("structural");
    expect(envelope.patterns?.[0]?.exemplar_keys).toHaveLength(2);
  });

  it("v1 envelope has no rules/patterns", () => {
    const envelope: SnapshotEnvelope = {
      version: 1,
      repoId: "repo-1",
      orgId: "org-1",
      entities: [],
      edges: [],
      generatedAt: new Date().toISOString(),
    };

    expect(envelope.version).toBe(1);
    expect(envelope.rules).toBeUndefined();
    expect(envelope.patterns).toBeUndefined();
  });

  it("v2 envelope with empty rules/patterns is valid", () => {
    const envelope: SnapshotEnvelope = {
      version: 2,
      repoId: "repo-1",
      orgId: "org-1",
      entities: [],
      edges: [],
      rules: [],
      patterns: [],
      generatedAt: new Date().toISOString(),
    };

    expect(envelope.version).toBe(2);
    expect(envelope.rules).toHaveLength(0);
    expect(envelope.patterns).toHaveLength(0);
  });

  it("CompactRule has all required fields", () => {
    const rule: CompactRule = {
      key: "rule-1",
      name: "Test",
      scope: "workspace",
      severity: "info",
      engine: "naming",
      query: "^[A-Z]",
      message: "Must be PascalCase",
      file_glob: "src/**/*.ts",
      enabled: true,
      repo_id: "repo-1",
    };

    expect(rule.key).toBe("rule-1");
    expect(rule.scope).toBe("workspace");
    expect(rule.engine).toBe("naming");
  });

  it("CompactPattern has all required fields", () => {
    const pattern: CompactPattern = {
      key: "pat-1",
      name: "Singleton pattern",
      kind: "structural",
      frequency: 8,
      confidence: 0.92,
      exemplar_keys: ["a:1", "b:2", "c:3"],
      promoted_rule_key: "rule-singleton",
    };

    expect(pattern.key).toBe("pat-1");
    expect(pattern.confidence).toBeGreaterThan(0.9);
    expect(pattern.exemplar_keys).toHaveLength(3);
    expect(pattern.promoted_rule_key).toBe("rule-singleton");
  });
});
