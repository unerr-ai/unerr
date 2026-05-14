import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommunityCache,
  detectCommunities,
  needsRecomputation,
} from "../intelligence/community-detector.js";
import { entityKey } from "../intelligence/indexer/entity-key.js";
import type {
  IndexedEdge,
  IndexedEntity,
} from "../intelligence/indexer/plugin-interface.js";

beforeEach(() => {
  clearCommunityCache();
});

function makeEntity(name: string, filePath: string): IndexedEntity {
  return {
    key: entityKey(filePath, "function", name, ""),
    kind: "function",
    name,
    file_path: filePath,
    start_line: 1,
    end_line: 10,
    signature: `${name}()`,
    body_hash: "hash",
    exported: true,
    parent_key: null,
    language: "typescript",
    is_async: false,
    parameter_count: 0,
    doc: null,
  };
}

describe("Community Detection (M.1-M.3)", () => {
  it("detects distinct clusters in a graph", async () => {
    const entities = [
      makeEntity("authLogin", "src/auth/login.ts"),
      makeEntity("authLogout", "src/auth/logout.ts"),
      makeEntity("authValidate", "src/auth/validate.ts"),
      makeEntity("payProcess", "src/payments/process.ts"),
      makeEntity("payRefund", "src/payments/refund.ts"),
      makeEntity("payCharge", "src/payments/charge.ts"),
    ];

    const edges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 1,
      },
      {
        from_key: entities[0]!.key,
        to_key: entities[2]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 2,
      },
      {
        from_key: entities[1]!.key,
        to_key: entities[2]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 3,
      },
      {
        from_key: entities[3]!.key,
        to_key: entities[4]!.key,
        type: "calls",
        file_path: "b.ts",
        line: 1,
      },
      {
        from_key: entities[3]!.key,
        to_key: entities[5]!.key,
        type: "calls",
        file_path: "b.ts",
        line: 2,
      },
      {
        from_key: entities[4]!.key,
        to_key: entities[5]!.key,
        type: "calls",
        file_path: "b.ts",
        line: 3,
      },
    ];

    const result = await await detectCommunities(entities, edges);
    expect(result.communities.length).toBeGreaterThanOrEqual(2);
    expect(result.assignments.size).toBe(6);
  });

  it("produces community profiles with files and kinds", async () => {
    const entities = [
      makeEntity("fn1", "src/auth/a.ts"),
      makeEntity("fn2", "src/auth/b.ts"),
    ];
    const edges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 1,
      },
    ];

    const result = await await detectCommunities(entities, edges);
    expect(result.communities.length).toBeGreaterThanOrEqual(1);
    const profile = result.communities[0]!;
    expect(profile.entityCount).toBeGreaterThan(0);
    expect(profile.files.length).toBeGreaterThan(0);
    expect(profile.dominantKinds.length).toBeGreaterThan(0);
  });

  it("infers community name from directory", async () => {
    const entities = [
      makeEntity("login", "src/auth/login.ts"),
      makeEntity("logout", "src/auth/logout.ts"),
      makeEntity("validate", "src/auth/validate.ts"),
    ];
    const edges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 1,
      },
      {
        from_key: entities[1]!.key,
        to_key: entities[2]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 2,
      },
    ];

    const result = await await detectCommunities(entities, edges);
    const authCommunity = result.communities.find((c) => c.name === "auth");
    expect(authCommunity).toBeDefined();
  });

  it("handles empty graph", async () => {
    const result = await detectCommunities([], []);
    expect(result.communities).toHaveLength(0);
    expect(result.modularity).toBe(0);
  });

  it("computes cohesion and coupling", async () => {
    const entities = [
      makeEntity("a", "src/mod/a.ts"),
      makeEntity("b", "src/mod/b.ts"),
      makeEntity("external", "src/other/c.ts"),
    ];
    const edges: IndexedEdge[] = [
      {
        from_key: entities[0]!.key,
        to_key: entities[1]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 1,
      },
      {
        from_key: entities[0]!.key,
        to_key: entities[2]!.key,
        type: "calls",
        file_path: "a.ts",
        line: 2,
      },
    ];

    const result = await await detectCommunities(entities, edges);
    for (const community of result.communities) {
      expect(community.cohesion).toBeGreaterThanOrEqual(0);
      expect(community.coupling).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Community Recomputation (M.6)", () => {
  it("triggers recomputation when no cache", async () => {
    expect(needsRecomputation(100)).toBe(true);
  });

  it("skips recomputation when below threshold", async () => {
    const entities = Array.from({ length: 100 }, (_, i) =>
      makeEntity(`fn${i}`, `src/f${i}.ts`),
    );
    const edges: IndexedEdge[] = [];
    await detectCommunities(entities, edges);

    expect(needsRecomputation(105)).toBe(false);
  });

  it("triggers recomputation when >10% change", async () => {
    const entities = Array.from({ length: 100 }, (_, i) =>
      makeEntity(`fn${i}`, `src/f${i}.ts`),
    );
    detectCommunities(entities, []);

    expect(needsRecomputation(115)).toBe(true);
  });
});
