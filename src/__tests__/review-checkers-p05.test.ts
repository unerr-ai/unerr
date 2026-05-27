import { describe, expect, it } from "vitest";
import type { LocalEntity } from "../intelligence/local-graph.js";
import { DeadCodeChecker } from "../review/checkers/dead-code.js";
import { DuplicateLogicChecker } from "../review/checkers/duplicate-logic.js";
import { SecretScanChecker } from "../review/checkers/secret-scan.js";
import {
  type ChangeEntity,
  type ChangeFile,
  DEFAULT_REVIEW_CONFIG,
  type ReviewContext,
  type ReviewGraph,
  type ReviewSearch,
  type ReviewSearchHit,
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

function fakeGraph(parts: {
  byFile?: Record<string, LocalEntity[]>;
  callersByKey?: Record<string, LocalEntity[]>;
}): ReviewGraph {
  return {
    getEntitiesByFile: async (fp) => parts.byFile?.[fp] ?? [],
    getCallersOf: async (key) => parts.callersByKey?.[key] ?? [],
  };
}

function changeEntity(
  over: Partial<ChangeEntity> & { name: string; entityKey: string }
): ChangeEntity {
  return {
    kind: "added",
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
  over: {
    entities?: ChangeEntity[];
    files?: ChangeFile[];
    search?: ReviewSearch | null;
  } = {}
): ReviewContext {
  return {
    changeSet: {
      entities: over.entities ?? [],
      files: over.files ?? [],
      source: "manual",
    },
    graph,
    notes: null,
    drift: null,
    rules: null,
    search: over.search ?? null,
    intent: null,
    config: DEFAULT_REVIEW_CONFIG,
  };
}

function fakeSearch(hits: ReviewSearchHit[]): ReviewSearch {
  return { candidatesFor: async () => hits };
}

const TOTAL_BODY = `function computeTotal(items) {
  let total = 0;
  for (const item of items) {
    total = total + item.price;
  }
  return total;
}`;

// ── duplicate_logic ───────────────────────────────────────────────────────────

describe("DuplicateLogicChecker", () => {
  it("flags a near-identical body in another file as a duplicate", async () => {
    const search = fakeSearch([
      {
        key: "k_existing",
        name: "sumPrices",
        filePath: "src/util.ts",
        body: TOTAL_BODY,
      },
    ]);
    const findings = await new DuplicateLogicChecker().check(
      ctx(fakeGraph({}), {
        entities: [
          changeEntity({
            name: "computeTotal",
            entityKey: "k_new",
            newBody: TOTAL_BODY,
          }),
        ],
        search,
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.checkerId).toBe("duplicate_logic");
    expect(findings[0]?.title).toContain("sumPrices");
    expect(findings[0]?.action).toContain("src/util.ts");
  });

  it("stays silent when candidates are structurally dissimilar", async () => {
    const search = fakeSearch([
      {
        key: "k_other",
        name: "greet",
        filePath: "src/util.ts",
        body: 'function greet(name) { console.error("hello " + name + " welcome aboard today"); }',
      },
    ]);
    const findings = await new DuplicateLogicChecker().check(
      ctx(fakeGraph({}), {
        entities: [
          changeEntity({
            name: "computeTotal",
            entityKey: "k_new",
            newBody: TOTAL_BODY,
          }),
        ],
        search,
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent on a trivial body below the token floor", async () => {
    const search = fakeSearch([
      { key: "k_x", name: "x", filePath: "src/util.ts", body: "return 1;" },
    ]);
    const findings = await new DuplicateLogicChecker().check(
      ctx(fakeGraph({}), {
        entities: [
          changeEntity({
            name: "one",
            entityKey: "k_one",
            newBody: "return 1;",
          }),
        ],
        search,
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent when no search index is wired", async () => {
    const findings = await new DuplicateLogicChecker().check(
      ctx(fakeGraph({}), {
        entities: [
          changeEntity({
            name: "computeTotal",
            entityKey: "k_new",
            newBody: TOTAL_BODY,
          }),
        ],
        search: null,
      })
    );
    expect(findings).toEqual([]);
  });
});

// ── secret_scan ───────────────────────────────────────────────────────────────

describe("SecretScanChecker", () => {
  it("flags an AWS access key id as critical", async () => {
    const findings = await new SecretScanChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({
            path: "src/config.ts",
            newContent: 'const k = "AKIAIOSFODNN7EXAMPLE";',
          }),
        ],
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.checkerId).toBe("secret_scan");
    expect(findings[0]?.title).toContain("AWS access key id");
    expect(findings[0]?.anchor).toEqual({
      kind: "f",
      value: "src/config.ts",
      line: 1,
    });
    // evidence is redacted — never re-leak the full secret
    expect(findings[0]?.evidence[0]).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(findings[0]?.evidence[0]).toContain("AKIA");
  });

  it("flags a private key block", async () => {
    const findings = await new SecretScanChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({
            path: "src/key.ts",
            newContent: "-----BEGIN RSA PRIVATE KEY-----",
          }),
        ],
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain("private key block");
  });

  it("ignores an env-var / placeholder reference", async () => {
    const findings = await new SecretScanChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({
            path: "src/config.ts",
            newContent: 'const password = "${process.env.DB_PASSWORD}";',
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent on a clean changed file", async () => {
    const findings = await new SecretScanChecker().check(
      ctx(fakeGraph({}), {
        files: [
          changeFile({
            path: "src/clean.ts",
            newContent: "export const answer = 42;",
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });
});

// ── dead_code ─────────────────────────────────────────────────────────────────

describe("DeadCodeChecker", () => {
  it("flags a newly added, unexported, uncalled function as dead code", async () => {
    const foo = entity({ key: "k_foo", name: "foo" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: { k_foo: [] },
    });
    const findings = await new DeadCodeChecker().check(
      ctx(graph, {
        entities: [
          changeEntity({
            name: "foo",
            entityKey: "k_foo",
            newBody: "function foo() { return 1; }",
          }),
        ],
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("low");
    expect(findings[0]?.checkerId).toBe("dead_code");
    expect(findings[0]?.title).toContain("foo");
  });

  it("stays silent on an exported entity (public surface)", async () => {
    const foo = entity({ key: "k_foo", name: "foo" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: { k_foo: [] },
    });
    const findings = await new DeadCodeChecker().check(
      ctx(graph, {
        entities: [
          changeEntity({
            name: "foo",
            entityKey: "k_foo",
            newBody: "export function foo() { return 1; }",
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });

  it("stays silent when the added entity has callers", async () => {
    const foo = entity({ key: "k_foo", name: "foo" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: { k_foo: [caller("a")] },
    });
    const findings = await new DeadCodeChecker().check(
      ctx(graph, {
        entities: [
          changeEntity({
            name: "foo",
            entityKey: "k_foo",
            newBody: "function foo() { return 1; }",
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });

  it("ignores modified (non-added) entities", async () => {
    const foo = entity({ key: "k_foo", name: "foo" });
    const graph = fakeGraph({
      byFile: { "src/target.ts": [foo] },
      callersByKey: { k_foo: [] },
    });
    const findings = await new DeadCodeChecker().check(
      ctx(graph, {
        entities: [
          changeEntity({
            name: "foo",
            entityKey: "k_foo",
            kind: "modified",
            newBody: "function foo() { return 2; }",
          }),
        ],
      })
    );
    expect(findings).toEqual([]);
  });
});
