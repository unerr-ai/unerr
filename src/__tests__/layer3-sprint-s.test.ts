/**
 * Layer 3 Sprint S: Proactive Injection & Session Intelligence tests.
 */

import { describe, expect, it } from "vitest";
import {
  suggestApproach,
  suggestApproachesForFile,
} from "../intelligence/approach-suggester.js";
import { createSessionContext } from "../intelligence/exploration-pattern-tracker.js";
import { assembleFileIntelligence } from "../intelligence/file-intelligence.js";
import { createSubgraphCache } from "../intelligence/subgraph-cache.js";

describe("File Intelligence (S.1)", () => {
  it("assembles intelligence for a file", () => {
    const entities = [
      {
        key: "k1",
        name: "processPayment",
        kind: "function",
        file_path: "src/pay.ts",
        risk_level: "high",
        fan_in: 25,
        community: 1,
      },
      {
        key: "k2",
        name: "validateCard",
        kind: "function",
        file_path: "src/pay.ts",
        risk_level: "normal",
        fan_in: 5,
        community: 1,
      },
      {
        key: "k3",
        name: "logError",
        kind: "function",
        file_path: "src/utils.ts",
        risk_level: "normal",
        fan_in: 2,
        community: 0,
      },
    ];

    const intel = assembleFileIntelligence("src/pay.ts", entities);
    expect(intel.entityCount).toBe(2);
    expect(intel.topRiskEntities).toHaveLength(1);
    expect(intel.topRiskEntities[0]?.name).toBe("processPayment");
    expect(intel.totalBlastRadius).toBe(30);
    expect(intel.dominantCommunity).toBe(1);
    expect(intel.fileRiskLevel).toBe("high");
  });

  it("handles file with no entities", () => {
    const intel = assembleFileIntelligence("empty.ts", []);
    expect(intel.entityCount).toBe(0);
    expect(intel.fileRiskLevel).toBe("normal");
    expect(intel.totalBlastRadius).toBe(0);
  });

  it("ranks entities by fan_in", () => {
    const entities = [
      { key: "a", name: "low", kind: "function", file_path: "f.ts", fan_in: 2 },
      {
        key: "b",
        name: "high",
        kind: "function",
        file_path: "f.ts",
        fan_in: 50,
      },
      {
        key: "c",
        name: "mid",
        kind: "function",
        file_path: "f.ts",
        fan_in: 15,
      },
    ];
    const intel = assembleFileIntelligence("f.ts", entities);
    expect(intel.entities[0]?.name).toBe("high");
    expect(intel.entities[1]?.name).toBe("mid");
  });
});

describe("Subgraph Cache (S.3)", () => {
  it("warms directory on first access", () => {
    const cache = createSubgraphCache();
    cache.warmDirectory(
      "src/auth",
      ["src/auth/login.ts", "src/auth/logout.ts"],
      (f) => ({ file: f }),
    );
    expect(cache.has("src/auth/login.ts")).toBe(true);
    expect(cache.has("src/auth/logout.ts")).toBe(true);
    expect(cache.size()).toBe(2);
  });

  it("skips already-warmed directories", () => {
    const cache = createSubgraphCache();
    let loadCount = 0;
    const loader = (f: string) => {
      loadCount++;
      return f;
    };
    cache.warmDirectory("src/auth", ["src/auth/a.ts"], loader);
    cache.warmDirectory("src/auth", ["src/auth/b.ts"], loader);
    expect(loadCount).toBe(1);
  });

  it("invalidates directory entries", () => {
    const cache = createSubgraphCache();
    cache.warmDirectory(
      "src/auth",
      ["src/auth/a.ts", "src/auth/b.ts"],
      (f) => f,
    );
    cache.invalidateDirectory("src/auth");
    expect(cache.has("src/auth/a.ts")).toBe(false);
  });

  it("respects TTL", () => {
    const cache = createSubgraphCache();
    cache.warmDirectory("src/x", ["src/x/a.ts"], (f) => f);
    expect(cache.get("src/x/a.ts")).not.toBeNull();
  });
});

describe("Approach Suggestions (S.4)", () => {
  it("suggests overload for critical fan_in", () => {
    const suggestion = suggestApproach(
      "k1",
      "processPayment",
      "critical",
      55,
      "function",
    );
    expect(suggestion).not.toBeNull();
    expect(suggestion?.pattern).toBe("overload-adapter");
    expect(suggestion?.suggestion).toContain("55 callers");
  });

  it("suggests feature flag for high fan_in", () => {
    const suggestion = suggestApproach(
      "k2",
      "validateInput",
      "high",
      35,
      "function",
    );
    expect(suggestion).not.toBeNull();
    expect(suggestion?.pattern).toBe("feature-flag");
  });

  it("suggests test-first for high risk without extreme fan_in", () => {
    const suggestion = suggestApproach(
      "k3",
      "helperFn",
      "high",
      10,
      "function",
    );
    expect(suggestion).not.toBeNull();
    expect(suggestion?.pattern).toBe("test-first");
  });

  it("returns null for low-risk entities", () => {
    expect(
      suggestApproach("k4", "simpleUtil", "normal", 3, "function"),
    ).toBeNull();
  });

  it("generates suggestions for file", () => {
    const entities = [
      {
        key: "k1",
        name: "hub",
        risk_level: "critical",
        fan_in: 60,
        kind: "function",
      },
      {
        key: "k2",
        name: "simple",
        risk_level: "normal",
        fan_in: 2,
        kind: "function",
      },
    ];
    const suggestions = suggestApproachesForFile(entities);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.entityName).toBe("hub");
  });
});

describe("Session Context (S.5)", () => {
  it("tracks exploration patterns", () => {
    const ctx = createSessionContext();
    ctx.recordQuery("src/auth/login.ts", "k1");
    ctx.recordQuery("src/auth/logout.ts", "k2");
    ctx.recordQuery("src/auth/validate.ts");

    const pattern = ctx.getPattern();
    expect(pattern.queryCount).toBe(3);
    expect(pattern.directories.get("src/auth")).toBe(3);
  });

  it("detects active directory", () => {
    const ctx = createSessionContext();
    ctx.recordQuery("src/auth/a.ts");
    ctx.recordQuery("src/auth/b.ts");
    ctx.recordQuery("src/payments/c.ts");
    ctx.recordQuery("src/auth/d.ts");

    expect(ctx.getActiveDirectory()).toBe("src/auth");
  });

  it("predicts next files from active directory", () => {
    const ctx = createSessionContext();
    ctx.recordQuery("src/auth/login.ts");
    ctx.recordQuery("src/auth/logout.ts");
    ctx.recordQuery("src/auth/validate.ts");

    const predicted = ctx.predictNextFiles(3);
    expect(predicted.length).toBeGreaterThan(0);
    expect(predicted.every((f) => f.startsWith("src/auth"))).toBe(true);
  });

  it("resets cleanly", () => {
    const ctx = createSessionContext();
    ctx.recordQuery("src/a.ts");
    ctx.reset();
    expect(ctx.getPattern().queryCount).toBe(0);
  });
});
