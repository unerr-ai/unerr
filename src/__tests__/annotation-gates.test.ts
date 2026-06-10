/**
 * Sprint SC-A.4: parse-time quality gates (§5.2).
 *
 * Each gate has accept + reject cases. A failed gate downgrades the
 * annotation — it never throws and never blocks anything.
 */

import { describe, expect, it } from "vitest";
import {
  PROSE_MAX_WORDS,
  UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER,
  applyAnnotationGates,
} from "../intelligence/semantic/annotation-gates.js";
import type { ParsedDocComment } from "../intelligence/semantic/docstring-extractor.js";

function parsed(overrides: Partial<ParsedDocComment>): ParsedDocComment {
  return { prose: null, sentinel: null, tags: [], ...overrides };
}

function sentinel(
  pairs: Record<string, string>,
  lineLength = 40,
  stackedCount = 1
) {
  return { pairs, invalidPairs: [], lineLength, stackedCount };
}

describe("Annotation gates (SC-A.4)", () => {
  it("accepts a good annotation unchanged", () => {
    const result = applyAnnotationGates(
      parsed({
        prose:
          "Validates a session token against the active key set — the auth boundary every inbound call funnels through.",
        sentinel: sentinel({ domain: "auth", role: "gateway" }),
      }),
      { entityName: "validateToken" }
    );
    expect(result.summary).toContain("auth boundary");
    expect(result.pairs).toEqual({ domain: "auth", role: "gateway" });
    expect(result.confidenceMultiplier).toBe(1.0);
    expect(result.candidateDomain).toBeNull();
    expect(result.rejections).toEqual([]);
  });

  describe("length gate", () => {
    it("rejects prose under 3 words", () => {
      const result = applyAnnotationGates(
        parsed({ prose: "Validates tokens." }),
        {
          entityName: "checkInput",
        }
      );
      expect(result.summary).toBe("");
      expect(result.rejections[0]?.gate).toBe("length");
    });

    it("truncates prose over 60 words and records the truncation", () => {
      const longProse = Array.from({ length: 72 }, (_, i) => `word${i}`).join(
        " "
      );
      const result = applyAnnotationGates(parsed({ prose: longProse }), {
        entityName: "bigEntity",
      });
      expect(result.summary.split(/\s+/)).toHaveLength(PROSE_MAX_WORDS);
      expect(result.rejections[0]?.detail).toContain("truncated 72");
    });

    it("rejects a sentinel line over 120 chars", () => {
      const result = applyAnnotationGates(
        parsed({ sentinel: sentinel({ domain: "auth" }, 140) }),
        { entityName: "f" }
      );
      expect(result.pairs).toEqual({});
      expect(result.rejections[0]?.gate).toBe("length");
      expect(result.rejections[0]?.detail).toContain("140");
    });

    it("skips prose gates entirely for a sentinel-only block", () => {
      const result = applyAnnotationGates(
        parsed({ sentinel: sentinel({ domain: "auth" }) }),
        { entityName: "f" }
      );
      expect(result.summary).toBe("");
      expect(result.rejections).toEqual([]);
    });
  });

  describe("tautology gate", () => {
    it("rejects prose that restates the entity name", () => {
      const result = applyAnnotationGates(
        parsed({ prose: "Process a payment." }),
        { entityName: "processPayment" }
      );
      expect(result.summary).toBe("");
      expect(result.rejections[0]?.gate).toBe("tautology");
    });

    it("catches plural/stem variants of the name", () => {
      const result = applyAnnotationGates(
        parsed({ prose: "Validates the tokens." }),
        { entityName: "validate_token" }
      );
      expect(result.summary).toBe("");
      expect(result.rejections[0]?.gate).toBe("tautology");
    });

    it("keeps prose that adds real information", () => {
      const result = applyAnnotationGates(
        parsed({
          prose:
            "Process a payment against the provider ledger before settlement.",
        }),
        { entityName: "processPayment" }
      );
      expect(result.summary).toContain("provider ledger");
      expect(result.rejections).toEqual([]);
    });
  });

  describe("identifier cross-check gate", () => {
    const prose =
      "Reconciles ledger rows produced by exportLedgerRows before settlement runs.";

    it("downgrades confidence when prose names an unknown identifier", () => {
      const result = applyAnnotationGates(parsed({ prose }), {
        entityName: "reconcileBalances",
        knownIdentifiers: new Set(["settleBalances"]),
      });
      expect(result.confidenceMultiplier).toBe(
        UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER
      );
      expect(result.rejections[0]?.gate).toBe("identifier");
      expect(result.rejections[0]?.detail).toContain("exportLedgerRows");
      expect(result.summary).toContain("Reconciles");
    });

    it("keeps full confidence when the identifier exists in the graph", () => {
      const result = applyAnnotationGates(parsed({ prose }), {
        entityName: "reconcileBalances",
        knownIdentifiers: new Set(["exportLedgerRows"]),
      });
      expect(result.confidenceMultiplier).toBe(1.0);
    });

    it("the entity's own name never counts as unknown", () => {
      const result = applyAnnotationGates(
        parsed({
          prose: "Wraps reconcileBalances with a retry and backoff loop.",
        }),
        { entityName: "reconcileBalances", knownIdentifiers: new Set() }
      );
      expect(result.confidenceMultiplier).toBe(1.0);
    });

    it("skips the gate when no identifier set is provided", () => {
      const result = applyAnnotationGates(parsed({ prose }), {
        entityName: "reconcileBalances",
      });
      expect(result.confidenceMultiplier).toBe(1.0);
    });

    it("all-caps acronyms in prose are not identifier references", () => {
      const result = applyAnnotationGates(
        parsed({
          prose: "Validates the JSON payload on every inbound API request.",
        }),
        { entityName: "validatePayload", knownIdentifiers: new Set() }
      );
      expect(result.confidenceMultiplier).toBe(1.0);
      expect(result.rejections).toEqual([]);
    });

    it("SCREAMING_SNAKE constants are still checked", () => {
      const result = applyAnnotationGates(
        parsed({
          prose: "Waits TURN_OPEN_GAP_MS before classifying the turn.",
        }),
        { entityName: "classifyTurn", knownIdentifiers: new Set() }
      );
      expect(result.confidenceMultiplier).toBe(
        UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER
      );
    });

    it("checks snake_case identifiers too", () => {
      const result = applyAnnotationGates(
        parsed({
          prose: "Feeds rows into settle_all_balances for the nightly run.",
        }),
        { entityName: "reconcile", knownIdentifiers: new Set() }
      );
      expect(result.confidenceMultiplier).toBe(
        UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER
      );
    });
  });

  describe("vocabulary gate", () => {
    it("flags an unknown domain as candidate but keeps the pair", () => {
      const result = applyAnnotationGates(
        parsed({ sentinel: sentinel({ domain: "billing" }) }),
        { entityName: "f", activeDomains: new Set(["auth", "payments"]) }
      );
      expect(result.pairs.domain).toBe("billing");
      expect(result.candidateDomain).toBe("billing");
    });

    it("does not flag a domain already in the vocabulary", () => {
      const result = applyAnnotationGates(
        parsed({ sentinel: sentinel({ domain: "auth" }) }),
        { entityName: "f", activeDomains: new Set(["auth"]) }
      );
      expect(result.candidateDomain).toBeNull();
    });

    it("skips the gate when no active set is provided", () => {
      const result = applyAnnotationGates(
        parsed({ sentinel: sentinel({ domain: "billing" }) }),
        { entityName: "f" }
      );
      expect(result.candidateDomain).toBeNull();
    });
  });

  describe("stacking gate", () => {
    it("records stacked sentinel lines (first already won in the parser)", () => {
      const result = applyAnnotationGates(
        parsed({ sentinel: sentinel({ domain: "auth" }, 40, 3) }),
        { entityName: "f" }
      );
      expect(result.pairs.domain).toBe("auth");
      expect(result.rejections[0]?.gate).toBe("stacking");
      expect(result.rejections[0]?.detail).toContain("3");
    });
  });
});
