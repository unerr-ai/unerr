import { describe, expect, it } from "vitest";
import { createDurabilityScorer } from "../intelligence/durability-scorer.js";

describe("createDurabilityScorer", () => {
  it("computes durability for entities", () => {
    const scorer = createDurabilityScorer();
    const entries = [
      {
        id: "e1",
        ts: "2026-04-28T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/auth.ts"] },
      },
      {
        id: "e2",
        ts: "2026-04-29T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/auth.ts"] },
      },
      {
        id: "e3",
        ts: "2026-04-30T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: { files: ["src/auth.ts"] },
      },
    ];

    const scores = scorer.computeScores(entries);
    const score = scores.get("src/auth.ts");

    expect(score).toBeDefined();
    expect(score?.modificationCount).toBe(3);
    expect(score?.score).toBeGreaterThan(0);
    expect(score?.score).toBeLessThanOrEqual(1);
  });

  it("entity modified 3x in 3 sessions with 1 day survival has low durability", () => {
    const scorer = createDurabilityScorer();
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries = [
      {
        id: "e1",
        ts: new Date(now - 3 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
      {
        id: "e2",
        ts: new Date(now - 2 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
      {
        id: "e3",
        ts: new Date(now - 1 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
    ];

    scorer.computeScores(entries);
    const score = scorer.getScore("src/flaky.ts");
    expect(score).toBeDefined();
    expect(score?.score).toBeLessThan(0.7);
  });

  it("stable entity has high durability", () => {
    const scorer = createDurabilityScorer();
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries = [
      {
        id: "e1",
        ts: new Date(now - 30 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/stable.ts"] },
      },
      {
        id: "e2",
        ts: new Date(now - 1 * day).toISOString(),
        tool: "get_function",
        args_summary: { key: "src/other.ts" },
      },
    ];

    scorer.computeScores(entries);
    const score = scorer.getScore("src/stable.ts");
    expect(score).toBeDefined();
    expect(score?.score).toBeGreaterThanOrEqual(0.9);
  });

  it("getTopUnstable returns lowest scores", () => {
    const scorer = createDurabilityScorer();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const entries = [
      {
        id: "e1",
        ts: new Date(now - 10 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/stable.ts"] },
      },
      {
        id: "e2",
        ts: new Date(now - 3 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
      {
        id: "e3",
        ts: new Date(now - 2 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
      {
        id: "e4",
        ts: new Date(now - 1 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
    ];

    scorer.computeScores(entries);
    const unstable = scorer.getTopUnstable(1);
    expect(unstable[0]?.entityKey).toBe("src/flaky.ts");
  });

  it("getTopDurable returns highest scores", () => {
    const scorer = createDurabilityScorer();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const entries = [
      {
        id: "e1",
        ts: new Date(now - 10 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/stable.ts"] },
      },
      {
        id: "e2",
        ts: new Date(now - 1 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
      {
        id: "e3",
        ts: new Date(now - 0.5 * day).toISOString(),
        tool: "sync_local_diff",
        args_summary: { files: ["src/flaky.ts"] },
      },
    ];

    scorer.computeScores(entries);
    const durable = scorer.getTopDurable(1);
    expect(durable[0]?.entityKey).toBe("src/stable.ts");
  });

  it("handles empty entries", () => {
    const scorer = createDurabilityScorer();
    const scores = scorer.computeScores([]);
    expect(scores.size).toBe(0);
  });
});
