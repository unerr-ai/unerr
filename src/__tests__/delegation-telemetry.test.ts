import { describe, expect, it } from "vitest";
import {
  parseDelegationIntent,
  tierForDelegationClass,
} from "../intelligence/delegation.js";

describe("parseDelegationIntent (Lever C C6)", () => {
  it("parses a single-entity delegation intent", () => {
    const d = parseDelegationIntent(
      "delegate tests: add coverage for the router"
    );
    expect(d).toEqual({ class: "tests", sweep: false });
  });

  it("parses a sweep delegation intent", () => {
    const d = parseDelegationIntent(
      "delegate mechanical_refactor sweep: rename across sites"
    );
    expect(d).toEqual({ class: "mechanical_refactor", sweep: true });
  });

  it("returns null for a non-delegation intent", () => {
    expect(parseDelegationIntent("review 3 changed entities")).toBeNull();
    expect(parseDelegationIntent("delegate the auth flow")).toBeNull(); // no class
    expect(parseDelegationIntent("")).toBeNull();
  });
});

describe("tierForDelegationClass (Issue 5 model-tier routing)", () => {
  it("routes judgement classes to the worker tier, brainless ones to junior", () => {
    expect(tierForDelegationClass("tests")).toBe("worker");
    expect(tierForDelegationClass("mechanical_refactor")).toBe("worker");
    expect(tierForDelegationClass("docs")).toBe("junior");
    expect(tierForDelegationClass("lint_format")).toBe("junior");
    expect(tierForDelegationClass("recon")).toBe("junior");
  });

  it("stays consistent with selectTier's worker set (scoped writes → worker)", () => {
    for (const c of [
      "codemod",
      "caller_propagation",
      "typecheck_fix",
      "scaffold",
    ] as const) {
      expect(tierForDelegationClass(c)).toBe("worker");
    }
    // The new read-only classes are brainless → junior.
    for (const c of [
      "research",
      "qa_lookup",
      "inventory_audit",
      "log_triage",
      "repro",
    ] as const) {
      expect(tierForDelegationClass(c)).toBe("junior");
    }
  });
});
