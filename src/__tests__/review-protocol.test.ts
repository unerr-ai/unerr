/**
 * P1 — `handleReviewEditRequest`: in-flight review over the warm graph.
 *
 * Proves the L0 change extraction (one edit → one ChangeFile + modified entities)
 * feeds the engine correctly, that a real breaking-callers scenario surfaces, and
 * that the never-special-case contract holds (clean + empty on missing path /
 * absent graph).
 */

import { describe, expect, it } from "vitest";
import type { LocalEntity } from "../intelligence/local-graph.js";
import {
  type ReviewEditRequestParams,
  handleReviewEditRequest,
} from "../proxy/review-protocol.js";
import type { ReviewGraph } from "../review/types.js";

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

function caller(name: string): LocalEntity {
  return entity({
    key: `k_${name}`,
    name,
    file_path: `src/${name}.ts`,
    start_line: 5,
  });
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

describe("handleReviewEditRequest", () => {
  it("surfaces a breaking-callers finding for an in-flight signature change", async () => {
    const foo = entity({ key: "k_foo", name: "foo", signature: "foo(a)" });
    const graph = fakeGraph(
      { "src/target.ts": [foo] },
      { k_foo: [caller("a"), caller("b"), caller("c")] }
    );
    const params: ReviewEditRequestParams = {
      file_path: "src/target.ts",
      old_content: "function foo(a) { return a; }",
      new_content: "function foo(a, b) { return a + b; }",
    };

    const result = await handleReviewEditRequest(graph, params);

    expect(result.clean).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(
      result.findings.some((f) => f.checkerId === "breaking_callers")
    ).toBe(true);
    const bc = result.findings.find((f) => f.checkerId === "breaking_callers");
    expect(bc?.severity).toBe("high");
  });

  // Regression: Claude Code's PostToolUse `tool_input.file_path` is ALWAYS
  // absolute, but the graph keys entities by repo-relative path. Without
  // normalization, getEntitiesByFile(absolute) returns [] → no entities →
  // clean/empty, so the reviewer never fired on a real edit. The other tests
  // all use relative paths, which is why the bug shipped green.
  it("normalizes an ABSOLUTE file_path so findings still surface", async () => {
    const foo = entity({ key: "k_foo", name: "foo", signature: "foo(a)" });
    const graph = fakeGraph(
      { "src/target.ts": [foo] },
      { k_foo: [caller("a"), caller("b"), caller("c")] }
    );
    const projectRoot = "/home/alice/proj";
    const result = await handleReviewEditRequest(
      graph,
      {
        file_path: `${projectRoot}/src/target.ts`,
        old_content: "function foo(a) { return a; }",
        new_content: "function foo(a, b) { return a + b; }",
      },
      { projectRoot }
    );
    expect(result.clean).toBe(false);
    expect(
      result.findings.some((f) => f.checkerId === "breaking_callers")
    ).toBe(true);
  });

  it("returns clean + empty when no file path is supplied", async () => {
    const result = await handleReviewEditRequest(fakeGraph({}, {}), {});
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("returns clean + empty when the graph is absent", async () => {
    const result = await handleReviewEditRequest(null, {
      file_path: "src/target.ts",
    });
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("stays silent on a body-only change (no cascade, no blast)", async () => {
    const foo = entity({ key: "k_foo", name: "foo", signature: "foo(a)" });
    // A test caller keeps untested_export quiet; the point here is that a
    // body-only edit raises no breaking_callers / blast_radius finding.
    const testCaller = entity({
      key: "k_t",
      name: "fooTest",
      file_path: "src/foo.test.ts",
      start_line: 3,
    });
    const graph = fakeGraph(
      { "src/target.ts": [foo] },
      { k_foo: [caller("a"), testCaller] }
    );
    const result = await handleReviewEditRequest(graph, {
      file_path: "src/target.ts",
      old_content: "function foo(a) { return a; }",
      new_content: "function foo(a) { return a * 2; }",
    });
    expect(result.clean).toBe(true);
  });

  it("honours an explicit severity floor", async () => {
    const foo = entity({
      key: "k_foo",
      name: "foo",
      signature: "foo(a)",
      fan_in: 8,
    });
    const graph = fakeGraph({ "src/target.ts": [foo] }, { k_foo: [] });
    // fan_in 8 is a medium blast_radius finding; raising the floor to high hides it.
    const medium = await handleReviewEditRequest(graph, {
      file_path: "src/target.ts",
      old_content: "x",
      new_content: "y",
      min_severity: "medium",
    });
    const high = await handleReviewEditRequest(graph, {
      file_path: "src/target.ts",
      old_content: "x",
      new_content: "y",
      min_severity: "high",
    });
    expect(medium.findings.some((f) => f.checkerId === "blast_radius")).toBe(
      true
    );
    expect(high.findings.some((f) => f.checkerId === "blast_radius")).toBe(
      false
    );
  });
});
