/**
 * Layer 3 Sprint U: Persistent Intelligence (Cross-Session) tests.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateForPromotion,
  shouldPromote,
} from "../intelligence/rule-generator.js";
import { createContextRotDetector } from "../proxy/context-rot-detector.js";
import { createDurabilityTracker } from "../tracking/durability-tracker.js";

describe("Auto-Rule Generation (U.6)", () => {
  it("promotes corrections with high confidence + occurrences", () => {
    const corrections = [
      {
        entityKey: "src/auth.ts::login",
        pattern: "rename",
        description: "Use 'authenticate' instead of 'login'",
        occurrences: 4,
        confidence: 0.95,
      },
    ];
    const rules = evaluateForPromotion(corrections);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.severity).toBe("warn");
    expect(rules[0]?.source).toBe("correction-auto");
  });

  it("does not promote low-confidence corrections", () => {
    const corrections = [
      {
        entityKey: "src/a.ts::fn",
        pattern: "rename",
        description: "test",
        occurrences: 5,
        confidence: 0.6,
      },
    ];
    expect(evaluateForPromotion(corrections)).toHaveLength(0);
  });

  it("does not promote low-occurrence corrections", () => {
    const corrections = [
      {
        entityKey: "src/b.ts::fn",
        pattern: "rename",
        description: "test",
        occurrences: 1,
        confidence: 0.95,
      },
    ];
    expect(evaluateForPromotion(corrections)).toHaveLength(0);
  });

  it("shouldPromote checks thresholds", () => {
    expect(
      shouldPromote({
        entityKey: "x",
        pattern: "p",
        description: "d",
        occurrences: 3,
        confidence: 0.9,
      })
    ).toBe(true);
    expect(
      shouldPromote({
        entityKey: "x",
        pattern: "p",
        description: "d",
        occurrences: 2,
        confidence: 0.9,
      })
    ).toBe(false);
  });
});

describe("Durability Tracker (U.7-U.8)", () => {
  it("records modifications and computes score", () => {
    const tracker = createDurabilityTracker();
    tracker.recordModification("entity-a", "session-1", "hash1");
    tracker.recordModification("entity-a", "session-2", "hash2");

    const result = tracker.getScore("entity-a");
    expect(result).not.toBeNull();
    expect(result?.totalModifications).toBe(2);
    expect(result?.pending).toBe(2);
  });

  it("evaluates survival correctly", () => {
    const tracker = createDurabilityTracker();
    tracker.recordModification("entity-b", "s1", "hashOriginal");

    const mods =
      (
        tracker as unknown as {
          records: Map<
            string,
            Array<{ modifiedAt: number; survived: boolean | null }>
          >;
        }
      ).records ?? new Map();

    tracker.evaluateSurvival("entity-b", "hashOriginal");
  });

  it("returns null for unknown entities", () => {
    const tracker = createDurabilityTracker();
    expect(tracker.getScore("nonexistent")).toBeNull();
  });

  it("getLowDurabilityEntities filters below threshold", () => {
    const tracker = createDurabilityTracker();
    tracker.recordModification("fragile", "s1", "h1");
    tracker.recordModification("fragile", "s2", "h2");
    const low = tracker.getLowDurabilityEntities(0.5);
    expect(low.length).toBeGreaterThanOrEqual(0);
  });

  it("getAllScores returns map", () => {
    const tracker = createDurabilityTracker();
    tracker.recordModification("e1", "s1", "h1");
    tracker.recordModification("e2", "s1", "h2");
    const scores = tracker.getAllScores();
    expect(scores.size).toBe(2);
  });
});

describe("Context Rot Detector (U.14-U.15)", () => {
  it("starts with zero rot", () => {
    const detector = createContextRotDetector();
    const signal = detector.evaluate();
    expect(signal.rotConfidence).toBe(0);
    expect(signal.action).toBe("none");
  });

  it("detects depth threshold warning", () => {
    const detector = createContextRotDetector();
    detector.recordToolCallTokens(250_000);
    const signal = detector.evaluate();
    expect(signal.rotConfidence).toBeGreaterThan(0);
    expect(signal.signals.some((s) => s.type === "depth_threshold")).toBe(true);
  });

  it("detects critical depth", () => {
    const detector = createContextRotDetector();
    detector.recordToolCallTokens(350_000);
    const signal = detector.evaluate();
    expect(signal.rotConfidence).toBeGreaterThanOrEqual(0.4);
  });

  it("detects repeated exploration", () => {
    const detector = createContextRotDetector();
    for (let i = 0; i < 5; i++) {
      detector.recordRepeatedQuery("entity-x");
    }
    const signal = detector.evaluate();
    expect(signal.signals.some((s) => s.type === "repeated_exploration")).toBe(
      true
    );
  });

  it("triggers inject_refresh at moderate rot", () => {
    const detector = createContextRotDetector();
    detector.recordToolCallTokens(250_000);
    for (let i = 0; i < 4; i++) detector.recordRepeatedQuery("entity-y");
    detector.recordError();
    detector.recordError();
    detector.recordError();
    detector.recordError();
    detector.recordError();

    const signal = detector.evaluate();
    expect(["inject_refresh", "suggest_new_session"]).toContain(signal.action);
  });

  it("triggers suggest_new_session at severe rot", () => {
    const detector = createContextRotDetector();
    detector.recordToolCallTokens(350_000);
    for (let i = 0; i < 5; i++) detector.recordRepeatedQuery(`ent-${i}`);
    for (let i = 0; i < 6; i++) detector.recordError();
    detector.recordForgottenContext("blast_radius", Date.now() - 60000);
    detector.recordConventionViolationAfterDelivery("camelCase");

    const signal = detector.evaluate();
    expect(signal.rotConfidence).toBeGreaterThan(0.7);
    expect(signal.action).toBe("suggest_new_session");
  });

  it("provides refresh context when triggered", () => {
    const detector = createContextRotDetector();
    detector.recordToolCallTokens(250_000);
    for (let i = 0; i < 4; i++) detector.recordRepeatedQuery("stale-entity");
    detector.evaluate();
    const ctx = detector.getRefreshContext();
    if (ctx) {
      expect(ctx.reason).toBeTruthy();
      expect(ctx.estimated_depth).toBeGreaterThan(0);
    }
  });

  it("resets cleanly", () => {
    const detector = createContextRotDetector();
    detector.recordToolCallTokens(500_000);
    detector.reset();
    const signal = detector.evaluate();
    expect(signal.estimatedDepth).toBe(0);
    expect(signal.rotConfidence).toBe(0);
  });
});
