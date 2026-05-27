import { describe, expect, it } from "vitest";
import type { LocalEntity } from "../intelligence/local-graph.js";
import { ArchitectureBoundaryChecker } from "../review/checkers/architecture-boundary.js";
import { ConventionRuleChecker } from "../review/checkers/convention-rule.js";
import { IncompleteRefactorChecker } from "../review/checkers/incomplete-refactor.js";
import { MemoryDriftChecker } from "../review/checkers/memory-drift.js";
import { UntestedExportChecker } from "../review/checkers/untested-export.js";
import {
  type ChangeEntity,
  type ChangeFile,
  DEFAULT_REVIEW_CONFIG,
  type ReviewContext,
  type ReviewGraph,
  type ReviewNote,
  type ReviewNotes,
  type ReviewRuleViolation,
  type ReviewRules,
} from "../review/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function entity(
  over: Partial<LocalEntity> & { name: string; key: string }
): LocalEntity {
  return {
    kind: "function",
    file_path: "src/target.ts",
    start_line: 10,
    end_line: 20,
    signature: "",
    body: "",
    fan_in: 0,
    fan_out: 0,
    risk_level: "low",
    community: 0,
    ...over,
  };
}

function caller(name: string, file = `src/${name}.ts`): LocalEntity {
  return entity({ key: `k_${name}`, name, file_path: file, start_line: 5 });
}

interface GraphParts {
  byFile?: Record<string, LocalEntity[]>;
  callersByKey?: Record<string, LocalEntity[]>;
}

function fakeGraph(parts: GraphParts): ReviewGraph {
  return {
    getEntitiesByFile: async (fp) => parts.byFile?.[fp] ?? [],
    getCallersOf: async (key) => parts.callersByKey?.[key] ?? [],
  };
}

function changeEntity(
  over: Partial<ChangeEntity> & { name: string; entityKey: string }
): ChangeEntity {
  return {
    kind: "modified",
    filePath: "src/target.ts",
    oldBody: null,
    newBody: null,
    ...over,
  };
}

function changeFile(over: Partial<ChangeFile> & { path: string }): ChangeFile {
  return { kind: "modified", oldContent: null, newContent: null, ...over };
}

function ctx(
  graph: ReviewGraph,
  over: Partial<ReviewContext> & {
    entities?: ChangeEntity[];
    files?: ChangeFile[];
  } = {}
): ReviewContext {
  const entities = over.entities ?? [];
  return {
    changeSet: {
      entities,
      files: over.files ?? [],
      source: "manual",
    },
    graph,
    notes: over.notes ?? null,
    drift: over.drift ?? null,
    rules: over.rules ?? null,
    search: over.search ?? null,
    intent: over.intent ?? null,
    config: over.config ?? DEFAULT_REVIEW_CONFIG,
  };
}

function fakeNotes(notes: ReviewNote[]): ReviewNotes {
  return {
    forAnchors: async (anchors) =>
      notes.filter((n) => anchors.includes(n.anchor)),
  };
}

function fakeRules(violations: ReviewRuleViolation[]): ReviewRules {
  return { violationsForFile: async () => violations };
}

// ── architecture_boundary ────────────────────────────────────────────────────

describe("ArchitectureBoundaryChecker", () => {
  // Path-based (DM-0): bridge.ts must not import intelligence/behaviors/tracking.
  // No graph community map is consulted — layers come from the file path.
  const importLine = 'import { x } from "../intelligence/local-graph.js";';

  it("flags a forbidden cross-layer import (DM-0) as high", async () => {
    const findings = await new ArchitectureBoundaryChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({ path: "src/proxy/bridge.ts", newContent: importLine }),
        ],
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.checkerId).toBe("architecture_boundary");
    expect(findings[0]?.title).toContain("src/proxy/bridge.ts");
    expect(findings[0]?.title).toContain("src/intelligence/");
    expect(findings[0]?.anchor).toEqual({
      kind: "f",
      value: "src/proxy/bridge.ts",
    });
  });

  it("stays silent on an allowed import within the same layer", async () => {
    const findings = await new ArchitectureBoundaryChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({
            path: "src/proxy/bridge.ts",
            newContent: 'import { y } from "./bridge-catalog.js";',
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent for a file outside any declared rule", async () => {
    // proxy.ts is in src/proxy/ but is NOT the bridge — the DM-0 rule is
    // bridge-specific, so importing intelligence here is allowed.
    const findings = await new ArchitectureBoundaryChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({ path: "src/proxy/proxy.ts", newContent: importLine }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });
});

// ── convention_rule ──────────────────────────────────────────────────────────

describe("ConventionRuleChecker", () => {
  const violation: ReviewRuleViolation = {
    ruleKey: "no-console",
    ruleName: "No console in production",
    severity: "error",
    message: "console.log is forbidden outside stderr",
    filePath: "src/x.ts",
    line: 5,
    matchedCode: "console.log(x)",
  };

  it("maps an error-severity rule violation to high", async () => {
    const findings = await new ConventionRuleChecker().check(
      ctx(fakeGraph({}), {
        files: [changeFile({ path: "src/x.ts", newContent: "console.log(x)" })],
        rules: fakeRules([violation]),
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.title).toContain("No console in production");
    expect(findings[0]?.anchor).toEqual({
      kind: "f",
      value: "src/x.ts",
      line: 5,
    });
    expect(findings[0]?.evidence).toContain("console.log(x)");
  });

  it("maps warn → medium and info → low", async () => {
    const warn = await new ConventionRuleChecker().check(
      ctx(fakeGraph({}), {
        files: [changeFile({ path: "src/x.ts", newContent: "x" })],
        rules: fakeRules([{ ...violation, severity: "warn" }]),
      })
    );
    const info = await new ConventionRuleChecker().check(
      ctx(fakeGraph({}), {
        files: [changeFile({ path: "src/x.ts", newContent: "x" })],
        rules: fakeRules([{ ...violation, severity: "info" }]),
      })
    );
    expect(warn[0]?.severity).toBe("medium");
    expect(info[0]?.severity).toBe("low");
  });

  it("stays silent when no rule store is wired", async () => {
    const findings = await new ConventionRuleChecker().check(
      ctx(fakeGraph({}), {
        files: [changeFile({ path: "src/x.ts", newContent: "x" })],
        rules: null,
      })
    );
    expect(findings).toEqual([]);
  });
});

// ── incomplete_refactor ──────────────────────────────────────────────────────

describe("IncompleteRefactorChecker", () => {
  it("flags callers in un-edited files after a signature change", async () => {
    const foo = entity({ key: "k_foo", name: "foo", signature: "foo(a)" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: {
        // one caller in an un-edited file, one in the edited file (excluded)
        k_foo: [caller("other"), caller("target")],
      },
    });
    const findings = await new IncompleteRefactorChecker().check(
      ctx(graph, {
        files: [
          changeFile({
            path: "src/target.ts",
            oldContent: "function foo(a) {}",
            newContent: "function foo(a, b) {}",
          }),
        ],
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.checkerId).toBe("incomplete_refactor");
    expect(findings[0]?.title).toContain("foo");
    expect(findings[0]?.evidence).toEqual(["src/other.ts:other"]);
    expect(findings[0]?.evidence).not.toContain("src/target.ts:target");
    // Bug B: action carries a pasteable get_references({key:…}) using the
    // 16-hex graph key (here the fake key "k_foo") — never {name:…} and never
    // the entity's signature blob. Anchor value is the key, matching siblings.
    expect(findings[0]?.action).toContain(
      "get_references({key:'k_foo', direction:'callers'})"
    );
    expect(findings[0]?.action).not.toContain("{name:");
    expect(findings[0]?.anchor.value).toBe("k_foo");
  });

  it("stays silent when every caller's file was edited this session", async () => {
    const foo = entity({ key: "k_foo", name: "foo", signature: "foo(a)" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: { k_foo: [caller("target")] },
    });
    const findings = await new IncompleteRefactorChecker().check(
      ctx(graph, {
        files: [
          changeFile({
            path: "src/target.ts",
            oldContent: "function foo(a) {}",
            newContent: "function foo(a, b) {}",
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });
});

// ── memory_drift ──────────────────────────────────────────────────────────────

describe("MemoryDriftChecker", () => {
  const decNote: ReviewNote = {
    kind: "dec",
    anchor: "e:k_foo",
    polarity: "+",
    content: "foo must stay synchronous for the hot path",
  };

  it("flags a changed entity governed by a dec note", async () => {
    const findings = await new MemoryDriftChecker().check(
      ctx(fakeGraph({}), {
        entities: [changeEntity({ name: "foo", entityKey: "k_foo" })],
        notes: fakeNotes([decNote]),
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.checkerId).toBe("memory_drift");
    expect(findings[0]?.title).toContain("dec");
    expect(findings[0]?.evidence[0]).toContain(
      "foo must stay synchronous for the hot path"
    );
  });

  it("ignores non-governing note kinds (fct)", async () => {
    const findings = await new MemoryDriftChecker().check(
      ctx(fakeGraph({}), {
        entities: [changeEntity({ name: "foo", entityKey: "k_foo" })],
        notes: fakeNotes([{ ...decNote, kind: "fct" }]),
      })
    );
    expect(findings).toEqual([]);
  });

  it("ignores added entities (no pre-existing decision to violate)", async () => {
    const findings = await new MemoryDriftChecker().check(
      ctx(fakeGraph({}), {
        entities: [
          changeEntity({ name: "foo", entityKey: "k_foo", kind: "added" }),
        ],
        notes: fakeNotes([decNote]),
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent when no notes layer is wired", async () => {
    const findings = await new MemoryDriftChecker().check(
      ctx(fakeGraph({}), {
        entities: [changeEntity({ name: "foo", entityKey: "k_foo" })],
        notes: null,
      })
    );
    expect(findings).toEqual([]);
  });
});

// ── untested_export ───────────────────────────────────────────────────────────

describe("UntestedExportChecker", () => {
  const foo = entity({ key: "k_foo", name: "foo" });

  it("flags an entity used in prod with no test coverage", async () => {
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: {
        k_foo: [caller("a", "src/a.ts"), caller("b", "src/b.ts")],
      },
    });
    const findings = await new UntestedExportChecker().check(
      ctx(graph, {
        entities: [changeEntity({ name: "foo", entityKey: "k_foo" })],
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.checkerId).toBe("untested_export");
    expect(findings[0]?.title).toContain("2 non-test caller(s)");
    expect(findings[0]?.evidence).toContain("0 test-file callers");
  });

  it("stays silent when a test already calls the entity", async () => {
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: {
        k_foo: [caller("a", "src/a.ts"), caller("t", "src/a.test.ts")],
      },
    });
    const findings = await new UntestedExportChecker().check(
      ctx(graph, {
        entities: [changeEntity({ name: "foo", entityKey: "k_foo" })],
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent on an unused entity (dead-code territory, not untested)", async () => {
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: { k_foo: [] },
    });
    const findings = await new UntestedExportChecker().check(
      ctx(graph, {
        entities: [changeEntity({ name: "foo", entityKey: "k_foo" })],
      })
    );
    expect(findings).toEqual([]);
  });

  it("ignores non-coverable kinds (variable)", async () => {
    const v = entity({ key: "k_v", name: "v", kind: "variable" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [v] },
      callersByKey: { k_v: [caller("a", "src/a.ts")] },
    });
    const findings = await new UntestedExportChecker().check(
      ctx(graph, {
        entities: [changeEntity({ name: "v", entityKey: "k_v" })],
      })
    );
    expect(findings).toEqual([]);
  });
});
