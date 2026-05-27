/**
 * Layer 3 Sprint Q: Output Compression & Budget Enforcement tests.
 *
 * Tests: compression stats, quality monitor, skills, performance.
 */

import { describe, expect, it } from "vitest";
import { enforceBudget } from "../proxy/budget-enforcer.js";
import {
  type ContentType,
  createCompressionQualityMonitor,
} from "../proxy/compression-quality-monitor.js";
import { createCompressionStatsCollector } from "../proxy/compression-stats.js";
import {
  type EntityRiskInfo,
  compressOutput,
} from "../proxy/output-compressor.js";
import {
  LOCAL_SKILLS,
  getSkill,
  getSkillsContext,
} from "../skills/local-pack.js";

describe("Compression Stats (Q.6)", () => {
  it("records compression events", () => {
    const stats = createCompressionStatsCollector();
    const id = stats.record({
      contentType: "git_diff",
      originalTokens: 5000,
      compressedTokens: 1500,
      sectionsPreserved: 3,
      sectionsOmitted: 7,
      annotationsAdded: 2,
      durationMs: 3.5,
    });

    expect(id).toBeTruthy();
    const event = stats.getEvent(id);
    expect(event).not.toBeNull();
    expect(event?.originalTokens).toBe(5000);
    expect(event?.compressedTokens).toBe(1500);
  });

  it("computes session-level stats", () => {
    const stats = createCompressionStatsCollector();
    stats.record({
      contentType: "git_diff",
      originalTokens: 5000,
      compressedTokens: 1500,
      sectionsPreserved: 3,
      sectionsOmitted: 7,
      annotationsAdded: 2,
      durationMs: 3,
    });
    stats.record({
      contentType: "test_output",
      originalTokens: 3000,
      compressedTokens: 1000,
      sectionsPreserved: 2,
      sectionsOmitted: 5,
      annotationsAdded: 0,
      durationMs: 2,
    });

    const session = stats.getSessionStats();
    expect(session.totalEvents).toBe(2);
    expect(session.totalOriginalTokens).toBe(8000);
    expect(session.totalCompressedTokens).toBe(2500);
    expect(session.totalSaved).toBe(5500);
    expect(session.avgCompressionRatio).toBeCloseTo(0.69, 1);
    expect(session.byContentType.git_diff?.count).toBe(1);
  });

  it("returns recent events", () => {
    const stats = createCompressionStatsCollector();
    for (let i = 0; i < 5; i++) {
      stats.record({
        contentType: "generic",
        originalTokens: 100,
        compressedTokens: 50,
        sectionsPreserved: 1,
        sectionsOmitted: 1,
        annotationsAdded: 0,
        durationMs: 1,
      });
    }
    expect(stats.getRecentEvents(3)).toHaveLength(3);
  });
});

describe("Compression Quality Monitor (Q.13)", () => {
  it("starts with default retention values", () => {
    const monitor = createCompressionQualityMonitor();
    expect(monitor.getRetention("git_diff")).toBeGreaterThanOrEqual(0.4);
    expect(monitor.getRetention("test_output")).toBeGreaterThanOrEqual(0.4);
  });

  it("records compression events without error", () => {
    const monitor = createCompressionQualityMonitor();
    monitor.recordCompression("comp-1", "git_diff", 0.7);
    expect(monitor.getSignalCount()).toBe(0);
  });

  it("detects over-compression when agent retries", () => {
    const monitor = createCompressionQualityMonitor();
    monitor.recordCompression("comp-1", "git_diff", 0.8);
    monitor.recordAgentAction("entity-x", true, false);
    expect(monitor.getSignalCount()).toBeGreaterThan(0);
  });

  it("increases retention after 3+ over-compression signals", () => {
    const monitor = createCompressionQualityMonitor();
    const initialRetention = monitor.getRetention("git_diff");

    for (let i = 0; i < 4; i++) {
      monitor.recordCompression(`comp-${i}`, "git_diff", 0.8);
      monitor.recordAgentAction("entity-x", true, false);
    }

    const newRetention = monitor.getRetention("git_diff");
    expect(newRetention).toBeGreaterThanOrEqual(initialRetention);
  });

  it("never drops below 40% hard floor", () => {
    const monitor = createCompressionQualityMonitor();
    const retention = monitor.getRetention("generic");
    expect(retention).toBeGreaterThanOrEqual(0.4);
  });

  it("provides adaptive config with confidence", () => {
    const monitor = createCompressionQualityMonitor();
    const config = monitor.getAdaptiveConfig();
    expect(config.minRetention).toBeDefined();
    expect(config.adaptedRetention).toBeDefined();
    expect(config.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe("Skills Pack (Q.11-Q.12, post-27→7 consolidation)", () => {
  it("token-efficient guidance lives inside the master skill body", () => {
    // Folded into using-unerr (always-on master).
    const skill = getSkill("using-unerr");
    expect(skill).not.toBeNull();
    expect(skill?.category).toBe("workflow");
    expect(skill?.instructions).toContain("bullet points");
  });

  it("graph-first navigation lives inside unerr-exploration", () => {
    // Absorbed graph-first-navigation, architecture-exploration, file-read-protocol.
    const skill = getSkill("exploration");
    expect(skill).not.toBeNull();
    expect(skill?.category).toBe("navigation");
    expect(skill?.instructions).toContain("get_references");
    expect(skill?.instructions).toContain("direction:callees");
    expect(skill?.instructions).toContain("search_code");
  });

  it("getSkillsContext returns always-on skills (post-27→7 consolidation)", () => {
    const context = getSkillsContext();
    const skills = context["dev.unerr/active_skills"] as Array<{ id: string }>;
    // The 4 always-on skills in the consolidated 7-skill set.
    expect(skills.map((s) => s.id)).toContain("using-unerr");
    expect(skills.map((s) => s.id)).toContain("safe-modification");
    expect(skills.map((s) => s.id)).toContain("memory");
    expect(skills.map((s) => s.id)).toContain("markers");
    expect(skills.length).toBe(
      LOCAL_SKILLS.filter((s) => s.trigger.type === "always").length
    );
  });

  it("review producer lives inside unerr-review", () => {
    // Skill 8 — agent-as-reviewer. PRODUCES a review (distinct from
    // test-and-review Track B, which ADDRESSES review comments left by others).
    const skill = getSkill("review");
    expect(skill).not.toBeNull();
    expect(skill?.category).toBe("workflow");
    expect(skill?.trigger.type).toBe("agent-requested");
    // Iron Law: every finding cites graph evidence, not the diff alone.
    expect(skill?.instructions).toContain("get_references");
    expect(skill?.instructions).toContain("get_test_coverage");
    // Disambiguation marker vs test-and-review Track B.
    expect(skill?.whenToUse).toContain("NOT for addressing review comments");
  });

  it("LOCAL_SKILLS has the 8 consolidated skills", () => {
    // Hard cut: the 22 absorbed legacy skills are gone. Skill 8 (review) —
    // agent-as-reviewer producer — added 2026-05.
    expect(LOCAL_SKILLS).toHaveLength(8);
    const ids = LOCAL_SKILLS.map((s) => s.id);
    expect(ids).toEqual([
      "using-unerr",
      "safe-modification",
      "exploration",
      "memory",
      "markers",
      "build-and-debug",
      "test-and-review",
      "review",
    ]);
  });
});

describe("Compression + Budget Pipeline (Q.7)", () => {
  it("compresses first, then enforces budget", () => {
    const largeInput = Array.from(
      { length: 200 },
      (_, i) => `Line ${i}: some content that takes up space in the output`
    ).join("\n");

    const compressed = compressOutput(largeInput, { tokenBudget: 500 });
    const enforced = enforceBudget(compressed.output, 300);

    expect(enforced.deliveredTokens).toBeLessThanOrEqual(
      enforced.originalTokens
    );
  });
});

describe("Performance (Q.10)", () => {
  it("100KB input compressed in <10ms", () => {
    const bigInput = "x".repeat(100 * 1024);
    const start = performance.now();
    compressOutput(bigInput, { tokenBudget: 2000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});
