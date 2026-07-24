// @ts-nocheck — test file, array index access is intentional
/**
 * Signal Scorer tests — scoring formula, ranking, burst multipliers, convention signals.
 */

import { describe, expect, it } from "vitest";
import {
  type DecisionLevel,
  type IntelligenceSignal,
  type RawContextData,
  SignalScorer,
  getSignalScorer,
} from "../intelligence/signal-scorer.js";

describe("SignalScorer", () => {
  const scorer = new SignalScorer();

  describe("contextToSignals", () => {
    it("converts blast_radius to warning signal", () => {
      const raw: RawContextData = {
        blast_radius: "5 direct callers, 3 callees",
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("warning");
      expect(signals[0].content).toContain("5 direct callers");
      expect(signals[0].actionability).toBe(0.9);
      expect(signals[0].source).toBe("graph");
      expect(signals[0].action).toBeDefined();
    });

    it("converts pending_violations to warning signals (max 3)", () => {
      const raw: RawContextData = {
        pending_violations: [
          { file: "a.ts", rule: "naming", message: "bad name", line: 10 },
          { file: "b.ts", rule: "style", message: "wrong indent" },
          { file: "c.ts", rule: "error", message: "missing catch", line: 5 },
          { file: "d.ts", rule: "extra", message: "should be capped" },
        ],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(3); // capped at 3
      expect(signals.every((s) => s.type === "warning")).toBe(true);
      expect(signals[0].content).toContain("a.ts");
      expect(signals[0].action).toContain("naming");
      expect(signals[0].action).toContain("line 10");
      // Second violation has no line
      expect(signals[1].action).toBe("Fix: style");
    });

    it("converts conventions to guidance signals (max 3)", () => {
      const raw: RawContextData = {
        conventions: [
          "Error handler: wrap in try/catch (90% adherence)",
          "Naming: camelCase (85% adherence)",
        ],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(2);
      expect(signals.every((s) => s.type === "guidance")).toBe(true);
      expect(signals[0].actionability).toBe(0.7);
      expect(signals[0].source).toBe("graph");
    });

    it("converts relevant_facts with episodic prefix to history signal", () => {
      const raw: RawContextData = {
        relevant_facts: ["[episodic] Modified doStuff to add error handling"],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("history");
      expect(signals[0].actionability).toBe(0.7);
      // Episodic fact action points the agent back at the narrative above
      // instead of a round-trip tool call.
      expect(signals[0].action).toContain(
        "read narrative above before editing"
      );
    });

    it("converts relevant_facts with negative prefix to warning signal", () => {
      const raw: RawContextData = {
        relevant_facts: ["[negative] This pattern caused bugs before"],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("warning");
      // Negative facts boosted to 0.85 (Issue #4 fix — anti-pattern facts must
      // outrank co-change hnt even at low decision level cap=2).
      expect(signals[0].actionability).toBe(0.85);
    });

    it("converts drift_alert to warning signal", () => {
      const raw: RawContextData = {
        drift_alert: "WARNING: entity modified since last index",
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("warning");
      expect(signals[0].source).toBe("graph");
    });

    it("converts community to context signal", () => {
      const raw: RawContextData = {
        community: "Part of auth module (12 entities)",
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("context");
      expect(signals[0].actionability).toBe(0.4);
    });

    it("handles empty raw context", () => {
      const signals = scorer.contextToSignals({}, "get_entity", {});
      expect(signals).toHaveLength(0);
    });

    it("handles all fields simultaneously", () => {
      const raw: RawContextData = {
        blast_radius: "3 callers",
        conventions: ["naming: camelCase"],
        drift_alert: "WARNING: drift",
        corrections: ["fix this"],
        community: "auth module",
        reminder: "previously queried",
        history: ["changed last session"],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      // blast_radius(1) + conventions(1) + drift(1) + corrections(1) + community(1) + reminder(1) + history(1) = 7
      expect(signals.length).toBe(7);
    });
  });

  describe("composite score formula", () => {
    it("computes actionability^1.5 * relevance * confidence", () => {
      const raw: RawContextData = {
        blast_radius: "test",
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const s = signals[0];
      const expected = s.actionability ** 1.5 * s.relevance * s.confidence;
      expect(s.composite_score).toBeCloseTo(expected, 10);
    });

    it("higher actionability gives disproportionately higher score", () => {
      // Warning (actionability 0.9) vs context (actionability 0.4)
      const raw: RawContextData = {
        blast_radius: "test",
        community: "test",
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const warning = signals.find((s) => s.type === "warning")!;
      const context = signals.find((s) => s.type === "context")!;
      // Ratio should be > 0.9/0.4 due to exponent
      expect(warning.composite_score).toBeGreaterThan(
        context.composite_score * 2
      );
    });
  });

  describe("rank", () => {
    it("returns top N signals by composite score", () => {
      const raw: RawContextData = {
        blast_radius: "3 callers",
        conventions: ["naming: camelCase", "style: semicolons"],
        community: "auth module",
        reminder: "previously queried",
        history: ["session 1", "session 2"],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const ranked = scorer.rank(signals, 3);
      expect(ranked).toHaveLength(3);
      // Should be sorted descending by composite_score
      expect(ranked[0].composite_score).toBeGreaterThanOrEqual(
        ranked[1].composite_score
      );
      expect(ranked[1].composite_score).toBeGreaterThanOrEqual(
        ranked[2].composite_score
      );
    });

    it("returns empty array for empty input", () => {
      expect(scorer.rank([], 3)).toHaveLength(0);
    });

    it("returns all signals when fewer than maxSignals", () => {
      const raw: RawContextData = { blast_radius: "test" };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const ranked = scorer.rank(signals, 5);
      expect(ranked).toHaveLength(1);
    });

    it("defaults to max 3 signals", () => {
      const raw: RawContextData = {
        blast_radius: "test",
        drift_alert: "test",
        conventions: ["a", "b", "c"],
        community: "test",
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const ranked = scorer.rank(signals);
      expect(ranked).toHaveLength(3);
    });
  });

  describe("applyBurstMultipliers", () => {
    it("does not modify signals for non-high decision level", () => {
      const raw: RawContextData = { blast_radius: "test" };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const original = signals[0].composite_score;
      const boosted = scorer.applyBurstMultipliers(signals, "medium");
      expect(boosted[0].composite_score).toBe(original);
    });

    it("boosts warning relevance at high decision level", () => {
      const raw: RawContextData = { blast_radius: "test" };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const original = signals[0].composite_score;
      const boosted = scorer.applyBurstMultipliers(signals, "high");
      expect(boosted[0].composite_score).toBeGreaterThan(original);
      expect(boosted[0].relevance).toBeGreaterThan(signals[0].relevance);
    });

    it("boosts history signals more than warnings at high decision level", () => {
      const raw: RawContextData = {
        blast_radius: "test",
        history: ["changed last session"],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      const warning = signals.find((s) => s.type === "warning")!;
      const history = signals.find((s) => s.type === "history")!;

      const boosted = scorer.applyBurstMultipliers(signals, "high");
      const boostedWarning = boosted.find((s) => s.type === "warning")!;
      const boostedHistory = boosted.find((s) => s.type === "history")!;

      // History gets 1.5x, warning gets 1.3x
      const warningBoostRatio = boostedWarning.relevance / warning.relevance;
      const historyBoostRatio = boostedHistory.relevance / history.relevance;
      expect(historyBoostRatio).toBeGreaterThan(warningBoostRatio);
    });

    it("caps boosted relevance at 1.0", () => {
      const raw: RawContextData = {
        pending_violations: [{ file: "a.ts", rule: "r", message: "m" }],
      };
      const signals = scorer.contextToSignals(raw, "get_entity", {});
      // pending_violations have relevance 0.95, * 1.3 = 1.235 → capped at 1.0
      const boosted = scorer.applyBurstMultipliers(signals, "high");
      expect(boosted[0].relevance).toBeLessThanOrEqual(1.0);
    });
  });

  describe("conventionToSignal", () => {
    const convention = {
      name: "camelCase naming",
      rule: "Use camelCase for functions",
      adherence_pct: 87,
      kind: "function",
    };

    it("generates prescriptive signal for entity tools", () => {
      const signal = scorer.conventionToSignal(convention, "get_entity");
      expect(signal.type).toBe("guidance");
      expect(signal.content).toContain("Follow");
      expect(signal.content).toContain("87%");
      expect(signal.action).toContain("Apply pattern");
      expect(signal.actionability).toBe(0.8);
    });

    it("generates descriptive signal for get_conventions", () => {
      const signal = scorer.conventionToSignal(convention, "get_conventions");
      expect(signal.type).toBe("guidance");
      expect(signal.content).toContain("camelCase naming");
      expect(signal.content).toContain("87%");
      expect(signal.action).toBeUndefined();
      expect(signal.actionability).toBe(0.5);
    });

    it("uses adherence_pct for relevance and confidence", () => {
      const signal = scorer.conventionToSignal(convention, "get_entity");
      expect(signal.relevance).toBe(0.87);
      expect(signal.confidence).toBe(0.87);
    });
  });

  describe("getSignalScorer singleton", () => {
    it("returns same instance", () => {
      const a = getSignalScorer();
      const b = getSignalScorer();
      expect(a).toBe(b);
    });
  });
});
