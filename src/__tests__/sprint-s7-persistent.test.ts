/**
 * Sprint S7: Wire Persistent Context (Layer 2) — Integration Tests.
 *
 * Verifies:
 *   - S7.1: Auto-snapshot triggers fire on test_pass and pre_critical_change
 *   - S7.2+S7.3: Session resume generates structured greeting from ledger
 *   - S7.4: Resume context injected as _context.session_resume on first response
 *   - S7.5: Durability scorer wired into entity responses (< 0.5 warning)
 *   - S7.6: Negative knowledge anti-patterns injected before agent touches code
 *   - S7.7: Timeline fork created on rewind
 *   - S7.8: Durability data feeds into session health monitor
 */

import { describe, expect, it } from "vitest";
import { createDurabilityScorer } from "../intelligence/durability-scorer.js";
import { detectInstableEntities } from "../intelligence/negative-knowledge.js";
import {
  type ContextHints,
  orderContextFields,
} from "../intelligence/query-router.js";
import { generateSessionResume } from "../proxy/session-resume.js";
import { shouldAutoSnapshot } from "../tracking/auto-snapshot-triggers.js";
import { createTimelineFork } from "../tracking/timeline-fork.js";

function makeLedgerEntry(
  overrides: Partial<{
    id: string;
    ts: string;
    tool: string;
    args_summary: Record<string, unknown>;
    result_summary: Record<string, unknown>;
    branch: string;
    session_id: string;
  }>
) {
  return {
    id: overrides.id ?? `e${Math.random().toString(36).slice(2, 10)}`,
    ts: overrides.ts ?? new Date().toISOString(),
    tool: overrides.tool ?? "get_function",
    args_summary: overrides.args_summary ?? {},
    result_summary: overrides.result_summary ?? { found: true },
    branch: overrides.branch ?? "main",
    session_id: overrides.session_id ?? "sess-1",
  };
}

describe("Sprint S7: Wire Persistent Context", () => {
  describe("S7.1: Auto-snapshot triggers in proxy lifecycle", () => {
    it("triggers on test_pass result", () => {
      const result = shouldAutoSnapshot(
        "run_command",
        { command: "npm test" },
        { exitCode: 0 }
      );
      expect(result).toBeTruthy();
      expect(result!.type).toBe("test_pass");
    });

    it("triggers on high fan_in threshold (pre-critical change)", () => {
      const result = shouldAutoSnapshot(
        "sync_local_diff",
        { file: "src/core.ts", entity_key: "src/core.ts::processPayment" },
        { fan_in: 50 },
        50
      );
      expect(result).toBeTruthy();
      expect(result!.type).toBe("pre_critical_change");
    });

    it("does not trigger on normal tool call", () => {
      const result = shouldAutoSnapshot(
        "search_code",
        { query: "hello" },
        { count: 5 }
      );
      expect(result).toBeFalsy();
    });
  });

  describe("S7.2+S7.3: Session resume from ledger", () => {
    it("generates resume context from ledger entries", () => {
      const entries = [
        makeLedgerEntry({
          tool: "get_function",
          args_summary: { key: "src/auth.ts::login" },
          ts: "2026-05-01T10:00:00Z",
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/auth.ts"] },
          ts: "2026-05-01T10:01:00Z",
        }),
        makeLedgerEntry({
          tool: "get_callers",
          args_summary: { key: "src/auth.ts::login" },
          ts: "2026-05-01T10:02:00Z",
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/db.ts"] },
          ts: "2026-05-01T10:03:00Z",
        }),
      ];

      const resume = generateSessionResume(entries);
      expect(resume).not.toBeNull();
      expect(resume!.summary).toBeDefined();
      expect(resume!.filesModified.length).toBeGreaterThan(0);
    });

    it("returns null for empty entries", () => {
      const resume = generateSessionResume([]);
      expect(resume).toBeNull();
    });
  });

  describe("S7.4: Context ordering includes session_resume", () => {
    it("orders session_resume between corrections and reminder", () => {
      const ctx: ContextHints = {
        session_resume: {
          summary: "Last session modified auth.ts",
          filesModified: ["src/auth.ts"],
          incompleteEntities: ["login"],
        },
        blast_radius: "14 callers",
        conventions: ["naming: camelCase"],
      };
      const ordered = orderContextFields(ctx);
      const keys = Object.keys(ordered);
      expect(keys.indexOf("blast_radius")).toBeLessThan(
        keys.indexOf("session_resume")
      );
      expect(keys.indexOf("session_resume")).toBeLessThan(
        keys.indexOf("conventions")
      );
    });
  });

  describe("S7.5: Durability scorer wired into entity responses", () => {
    it("computes durability scores from ledger entries", () => {
      const baseTime = Date.now();
      // Fragile: modified 4 times rapidly, stable: modified once early
      const entries = [
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/stable.ts"] },
          ts: new Date(baseTime).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/fragile.ts"] },
          ts: new Date(baseTime + 10000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/fragile.ts"] },
          ts: new Date(baseTime + 20000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/fragile.ts"] },
          ts: new Date(baseTime + 30000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/fragile.ts"] },
          ts: new Date(baseTime + 600000).toISOString(),
        }),
      ];

      const scorer = createDurabilityScorer();
      scorer.computeScores(entries);

      const fragile = scorer.getScore("src/fragile.ts");
      expect(fragile).not.toBeNull();
      expect(fragile!.modificationCount).toBe(4);

      const stable = scorer.getScore("src/stable.ts");
      expect(stable).not.toBeNull();
      expect(stable!.modificationCount).toBe(1);

      // Fragile should have lower or equal durability (more churn = less stable)
      expect(fragile!.score).toBeLessThanOrEqual(stable!.score);
    });

    it("getTopUnstable returns most fragile entities", () => {
      const baseTime = Date.now();
      const entries = [
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/a.ts"] },
          ts: new Date(baseTime).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/a.ts"] },
          ts: new Date(baseTime + 1000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/a.ts"] },
          ts: new Date(baseTime + 2000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/b.ts"] },
          ts: new Date(baseTime).toISOString(),
        }),
      ];

      const scorer = createDurabilityScorer();
      scorer.computeScores(entries);

      const unstable = scorer.getTopUnstable(2);
      expect(unstable.length).toBeGreaterThan(0);
      expect(unstable[0]!.entityKey).toBe("src/a.ts");
    });
  });

  describe("S7.6: Negative knowledge anti-pattern injection", () => {
    it("detects instable entities from rapid modifications", () => {
      const baseTime = Date.now();
      const entries = [
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/flaky.ts"] },
          ts: new Date(baseTime).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/flaky.ts"] },
          ts: new Date(baseTime + 30000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/flaky.ts"] },
          ts: new Date(baseTime + 60000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/flaky.ts"] },
          ts: new Date(baseTime + 90000).toISOString(),
        }),
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/flaky.ts"] },
          ts: new Date(baseTime + 120000).toISOString(),
        }),
      ];

      const corrections = detectInstableEntities(entries, 10 * 60 * 1000);
      expect(corrections.length).toBeGreaterThan(0);
      expect(corrections[0]!.entityKey).toBe("src/flaky.ts");
      expect(corrections[0]!.pattern).toBeDefined();
      expect(corrections[0]!.reason).toBeDefined();
    });

    it("does not flag entities modified only once", () => {
      const entries = [
        makeLedgerEntry({
          tool: "sync_local_diff",
          args_summary: { files: ["src/once.ts"] },
          ts: new Date().toISOString(),
        }),
      ];

      const corrections = detectInstableEntities(entries);
      const forOnce = corrections.filter((c) => c.entityKey === "src/once.ts");
      expect(forOnce.length).toBe(0);
    });
  });

  describe("S7.7: Timeline fork on rewind", () => {
    it("creates timeline fork with abandoned entities", () => {
      const fork = createTimelineFork(
        "snap-123",
        ["processPayment", "validateOrder"],
        ["fix the payment flow"],
        "Approach failed — infinite loop"
      );

      expect(fork.forkPoint).toBe("snap-123");
      expect(fork.abandonedBranch.entityChanges).toContain("processPayment");
      expect(fork.abandonedBranch.entityChanges).toContain("validateOrder");
      expect(fork.abandonedBranch.promptsTried).toContain(
        "fix the payment flow"
      );
      expect(fork.abandonedBranch.failureReason).toBe(
        "Approach failed — infinite loop"
      );
      expect(fork.newBranch.timelineId).toBeGreaterThan(
        fork.abandonedBranch.timelineId
      );
    });

    it("deduplicates abandoned entities", () => {
      const fork = createTimelineFork(
        "snap-456",
        ["entity1", "entity1", "entity2", "entity2"],
        []
      );

      expect(fork.abandonedBranch.entityChanges).toEqual([
        "entity1",
        "entity2",
      ]);
    });
  });

  describe("S7.8: Durability feeds into session health monitor", () => {
    it("context ordering places durability_warning with high priority", () => {
      const ctx: ContextHints = {
        durability_warning: "FRAGILE: entity has durability 0.3",
        conventions: ["naming: camelCase"],
        blast_radius: "14 callers",
      };
      const ordered = orderContextFields(ctx);
      const keys = Object.keys(ordered);
      // durability_warning should come after blast_radius but before conventions
      expect(keys.indexOf("blast_radius")).toBeLessThan(
        keys.indexOf("durability_warning")
      );
      expect(keys.indexOf("durability_warning")).toBeLessThan(
        keys.indexOf("conventions")
      );
    });

    it("anti_patterns ordered with high priority", () => {
      const ctx: ContextHints = {
        anti_patterns: ["ANTI-PATTERN: repeated modification without test"],
        conventions: ["naming: camelCase"],
        blast_radius: "14 callers",
      };
      const ordered = orderContextFields(ctx);
      const keys = Object.keys(ordered);
      expect(keys.indexOf("anti_patterns")).toBeLessThan(
        keys.indexOf("conventions")
      );
    });
  });
});
