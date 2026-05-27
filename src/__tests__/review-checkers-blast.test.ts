import { describe, expect, it } from "vitest";
import type { LocalEntity } from "../intelligence/local-graph.js";
import { BlastRadiusChecker } from "../review/checkers/blast-radius.js";
import { BreakingCallersChecker } from "../review/checkers/breaking-callers.js";
import {
  type ChangeEntity,
  DEFAULT_REVIEW_CONFIG,
  type ReviewContext,
  type ReviewGraph,
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

function fakeGraph(
  byFile: Record<string, LocalEntity[]>,
  callersByKey: Record<string, LocalEntity[]>
): ReviewGraph {
  return {
    getEntitiesByFile: async (fp) => byFile[fp] ?? [],
    getCallersOf: async (key) => callersByKey[key] ?? [],
  };
}

function change(
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

function ctx(graph: ReviewGraph, entities: ChangeEntity[]): ReviewContext {
  return {
    changeSet: {
      entities,
      files: [...new Set(entities.map((e) => e.filePath))].map((path) => ({
        path,
        kind: "modified" as const,
        oldContent: null,
        newContent: null,
      })),
      source: "manual",
    },
    graph,
    notes: null,
    drift: null,
    rules: null,
    search: null,
    intent: null,
    config: DEFAULT_REVIEW_CONFIG,
  };
}

function callers(n: number): LocalEntity[] {
  return Array.from({ length: n }, (_, i) => caller(`c${i}`));
}

// ── breaking_callers ───────────────────────────────────────────────────────

describe("BreakingCallersChecker", () => {
  const foo = entity({ key: "k_foo", name: "foo", signature: "foo(a)" });

  it("flags a signature change with callers as high (parameter added)", async () => {
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: callers(3) });
    const findings = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "foo",
          entityKey: "k_foo",
          oldBody: "function foo(a) { return a; }",
          newBody: "function foo(a, b) { return a + b; }",
        }),
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.checkerId).toBe("breaking_callers");
    expect(findings[0]?.title).toContain("parameter_added");
    expect(findings[0]?.title).toContain("3 caller(s)");
    expect(findings[0]?.evidence.length).toBeGreaterThan(0);
  });

  it("escalates to critical at >= 20 callers", async () => {
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: callers(25) });
    const findings = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "foo",
          entityKey: "k_foo",
          oldBody: "function foo(a) {}",
          newBody: "function foo(a, b) {}",
        }),
      ])
    );
    expect(findings[0]?.severity).toBe("critical");
  });

  it("flags a deletion with surviving callers as critical", async () => {
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: callers(2) });
    const findings = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "foo",
          entityKey: "k_foo",
          kind: "deleted",
          oldBody: "function foo(a) {}",
        }),
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.title).toContain("deleting foo");
  });

  it("stays silent on a body-only change (no signature change)", async () => {
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: callers(5) });
    const findings = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "foo",
          entityKey: "k_foo",
          oldBody: "function foo(a) { return a; }",
          newBody: "function foo(a) { return a * 2; }",
        }),
      ])
    );
    expect(findings).toEqual([]);
  });

  it("stays silent on an added entity and an unresolvable entity", async () => {
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: callers(5) });
    const added = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "foo",
          entityKey: "k_foo",
          kind: "added",
          newBody: "function foo(a){}",
        }),
      ])
    );
    const missing = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "ghost",
          entityKey: "k_ghost",
          oldBody: "function ghost(){}",
          newBody: "function ghost(x){}",
        }),
      ])
    );
    expect(added).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("does not warn below the minimum caller count", async () => {
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: callers(1) });
    const findings = await new BreakingCallersChecker().check(
      ctx(graph, [
        change({
          name: "foo",
          entityKey: "k_foo",
          oldBody: "function foo(a){}",
          newBody: "function foo(a,b){}",
        }),
      ])
    );
    expect(findings).toEqual([]);
  });
});

// ── blast_radius ─────────────────────────────────────────────────────────────

describe("BlastRadiusChecker", () => {
  it("flags a high-fan-in chokepoint as high", async () => {
    const hot = entity({ key: "k_hot", name: "hot", fan_in: 25 });
    const graph = fakeGraph({ "src/target.ts": [hot] }, {});
    const findings = await new BlastRadiusChecker().check(
      ctx(graph, [change({ name: "hot", entityKey: "k_hot" })])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.title).toContain("chokepoint");
    expect(findings[0]?.evidence[0]).toContain("fan_in=25");
  });

  it("flags a medium-fan-in entity as medium", async () => {
    const mid = entity({ key: "k_mid", name: "mid", fan_in: 10 });
    const graph = fakeGraph({ "src/target.ts": [mid] }, {});
    const findings = await new BlastRadiusChecker().check(
      ctx(graph, [change({ name: "mid", entityKey: "k_mid" })])
    );
    expect(findings[0]?.severity).toBe("medium");
  });

  it("stays silent below the medium threshold", async () => {
    const cold = entity({ key: "k_cold", name: "cold", fan_in: 3 });
    const graph = fakeGraph({ "src/target.ts": [cold] }, {});
    const findings = await new BlastRadiusChecker().check(
      ctx(graph, [change({ name: "cold", entityKey: "k_cold" })])
    );
    expect(findings).toEqual([]);
  });

  it("uses the live caller count as a floor when fan_in is stale", async () => {
    const stale = entity({ key: "k_stale", name: "stale", fan_in: 0 });
    const graph = fakeGraph(
      { "src/target.ts": [stale] },
      { k_stale: callers(8) }
    );
    const findings = await new BlastRadiusChecker().check(
      ctx(graph, [change({ name: "stale", entityKey: "k_stale" })])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.title).toContain("8 caller(s)");
  });
});
