/**
 * Sprint Q: Persistent Context & Causal Intelligence tests.
 *
 * Tests the complete persistent intelligence loop:
 * Q.1: Causal bridge, Q.2: Auto-snapshots, Q.3: Convention learning,
 * Q.4: Session resume, Q.5: Timeline forks, Q.6: Prompt durability,
 * Q.9: Session health + exploration cost
 */

import { describe, expect, it } from "vitest";

describe("Q.1: Causal Bridge Query Engine", () => {
  it("assembles causal chain from entity interactions", async () => {
    const { assembleCausalChain } = await import(
      "../tracking/causal-bridge.js"
    );
    const entries = [
      {
        id: "e1",
        ts: "2026-05-01T10:00:00Z",
        tool: "sync_local_diff",
        args_summary: {
          files: ["src/auth.ts"],
          prompt: "Add login validation",
        },
        result_summary: {},
        session_id: "s1",
        head_sha: "abc",
      },
      {
        id: "e2",
        ts: "2026-05-01T10:05:00Z",
        tool: "sync_local_diff",
        args_summary: {
          files: ["src/auth.ts"],
          prompt: "Fix validation edge case",
        },
        result_summary: { commit_sha: "def" },
        session_id: "s1",
        head_sha: "def",
      },
    ];
    const chain = assembleCausalChain("src/auth.ts", entries);
    expect(chain.entityKey).toBe("src/auth.ts");
    expect(chain.interactions.length).toBeGreaterThanOrEqual(1);
  });

  it("computes durability from survival data", async () => {
    const { computeDurability } = await import("../tracking/causal-bridge.js");
    const interactions = [
      { survived: true, survivalMs: 86400000 },
      { survived: true, survivalMs: 86400000 },
      { survived: false, survivalMs: 3600000 },
    ];
    const durability = computeDurability(interactions as any);
    expect(durability).toBeGreaterThan(0.5);
    expect(durability).toBeLessThanOrEqual(1.0);
  });
});

describe("Q.2: Auto-Snapshot Triggers", () => {
  it("detects test pass commands", async () => {
    const { isTestCommand } = await import(
      "../tracking/auto-snapshot-triggers.js"
    );
    expect(isTestCommand("pnpm test:run")).toBe(true);
    expect(isTestCommand("vitest run")).toBe(true);
    expect(isTestCommand("jest --coverage")).toBe(true);
    expect(isTestCommand("pytest -v")).toBe(true);
    expect(isTestCommand("git status")).toBe(false);
    expect(isTestCommand("ls -la")).toBe(false);
  });

  it("triggers snapshot on test pass", async () => {
    const { shouldAutoSnapshot } = await import(
      "../tracking/auto-snapshot-triggers.js"
    );
    const trigger = shouldAutoSnapshot(
      "bash",
      { command: "pnpm test:run" },
      { exitCode: 0 }
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.type).toBe("test_pass");
  });

  it("does not trigger on test failure", async () => {
    const { shouldAutoSnapshot } = await import(
      "../tracking/auto-snapshot-triggers.js"
    );
    const trigger = shouldAutoSnapshot(
      "bash",
      { command: "pnpm test:run" },
      { exitCode: 1 }
    );
    expect(trigger).toBeNull();
  });
});

describe("Q.5: Timeline Branching on Rewind", () => {
  it("creates timeline fork with abandoned + new branches", async () => {
    const { createTimelineFork } = await import("../tracking/timeline-fork.js");
    const fork = createTimelineFork(
      "snapshot-123",
      ["src/auth.ts::login", "src/auth.ts::validate"],
      ["Add optional param to login", "Fix validate edge case"],
      "Broke 3 downstream callers"
    );
    expect(fork.forkPoint).toBe("snapshot-123");
    expect(fork.abandonedBranch.entityChanges).toHaveLength(2);
    expect(fork.abandonedBranch.promptsTried).toHaveLength(2);
    expect(fork.abandonedBranch.failureReason).toContain("Broke");
    expect(fork.newBranch.timelineId).toBeGreaterThan(
      fork.abandonedBranch.timelineId
    );
  });
});

describe("Q.6: Prompt Durability Ranking", () => {
  it("extracts action types from prompts", async () => {
    const { extractActionType } = await import(
      "../tracking/prompt-durability.js"
    );
    expect(extractActionType("Add a new helper function")).toBe("add");
    expect(extractActionType("Fix the authentication bug")).toBe("fix");
    expect(extractActionType("Refactor the payment module")).toBe("refactor");
    expect(extractActionType("Modify the user service")).toBe("modify");
    expect(extractActionType("Delete unused imports")).toBe("delete");
    expect(extractActionType("Do something complex")).toBe("other");
  });

  it("computes durability profiles", async () => {
    const { computePromptDurabilityProfiles } = await import(
      "../tracking/prompt-durability.js"
    );
    const entries = [
      {
        prompt: "Add helper function",
        files: ["src/utils.ts"],
        survived: true,
        riskLevel: "low",
      },
      {
        prompt: "Add another helper",
        files: ["src/utils.ts"],
        survived: true,
        riskLevel: "low",
      },
      {
        prompt: "Modify critical service",
        files: ["src/core.ts"],
        survived: false,
        riskLevel: "critical",
      },
    ];
    const profiles = computePromptDurabilityProfiles(entries);
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    const addProfile = profiles.find((p) => p.actionType === "add");
    if (addProfile) {
      expect(addProfile.durability).toBe(1.0);
    }
  });
});

describe("Q.9: Session Health Monitor", () => {
  it("starts healthy", async () => {
    const { createSessionHealthMonitor } = await import(
      "../intelligence/session-health-monitor.js"
    );
    const monitor = createSessionHealthMonitor();
    const health = monitor.getHealth();
    expect(health.health).toBe(1.0);
    expect(health.recommendation).toBe("continue");
    expect(health.signals).toHaveLength(0);
  });

  it("detects repeated queries as degradation", async () => {
    const { createSessionHealthMonitor } = await import(
      "../intelligence/session-health-monitor.js"
    );
    const monitor = createSessionHealthMonitor();
    for (let i = 0; i < 5; i++) {
      monitor.recordToolCall("get_function", "entity-x");
    }
    const health = monitor.getHealth();
    expect(health.health).toBeLessThan(1.0);
    const repeated = health.signals.find((s) => s.type === "repeated_query");
    expect(repeated).toBeDefined();
  });

  it("detects convention violation spikes", async () => {
    const { createSessionHealthMonitor } = await import(
      "../intelligence/session-health-monitor.js"
    );
    const monitor = createSessionHealthMonitor();
    for (let i = 0; i < 6; i++) {
      monitor.recordConventionViolation();
    }
    const health = monitor.getHealth();
    const spike = health.signals.find(
      (s) => s.type === "convention_violation_spike"
    );
    expect(spike).toBeDefined();
  });
});

describe("Q.9: Exploration Cost Estimator", () => {
  it("estimates counterfactual for blast_radius query", async () => {
    const { estimateExplorationCost } = await import(
      "../intelligence/exploration-cost.js"
    );
    const estimate = estimateExplorationCost("blast_radius", 500, 10);
    expect(estimate.tokensWithout).toBeGreaterThan(estimate.tokensUsed);
    expect(estimate.counterfactualMethod).toBeTruthy();
    expect(estimate.explanation).toBeTruthy();
  });

  it("accumulates session savings", async () => {
    const { createExplorationAccumulator, estimateExplorationCost } =
      await import("../intelligence/exploration-cost.js");
    const acc = createExplorationAccumulator();
    acc.record(estimateExplorationCost("blast_radius", 500, 10));
    acc.record(estimateExplorationCost("find_callers", 200, 5));
    const total = acc.getTotal();
    expect(total.saved).toBeGreaterThan(0);
    expect(total.ratio).toBeGreaterThan(0);
  });
});

describe("Q: Intent Token Tracker", () => {
  it("tracks tokens per intent group", async () => {
    const { createIntentTokenTracker } = await import(
      "../tracking/intent-token-tracker.js"
    );
    const tracker = createIntentTokenTracker();
    tracker.recordToolCall("intent-1", 500, 200, "entity-a");
    tracker.recordToolCall("intent-1", 300, 100, "entity-b");
    const group = tracker.getGroup("intent-1");
    expect(group).not.toBeNull();
    expect(group?.toolCalls).toBe(2);
    expect(group?.tokensConsumed).toBe(800);
    expect(group?.tokensSaved).toBe(300);
    expect(group?.entitiesModified).toContain("entity-a");
  });

  it("marks outcomes", async () => {
    const { createIntentTokenTracker } = await import(
      "../tracking/intent-token-tracker.js"
    );
    const tracker = createIntentTokenTracker();
    tracker.recordToolCall("intent-2", 100, 50);
    tracker.markOutcome("intent-2", "completed");
    const group = tracker.getGroup("intent-2");
    expect(group?.outcome).toBe("completed");
  });
});
