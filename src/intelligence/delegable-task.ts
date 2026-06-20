/**
 * Delegable-task classifier — Lever C (TOKEN_ECONOMICS_AND_SAVINGS §11.2 C1).
 *
 * A task is "delegable" when it belongs to a narrow, check-verifiable class that a
 * cheaper model can complete under a recon brief and senior review: test work,
 * docstring + `@sem` maintenance, mechanical refactors (rename/extract/inline/move),
 * and lint/format fixups. This is ORTHOGONAL to task size — a delegable task can be
 * trivial or a sweep; size routes the recon footprint, this routes the model tier.
 *
 * Pure verdict function — classifies from prompt verbs alone, no I/O, no graph, so
 * the provider gate and the `unerr-delegate` skill can both consult it. The bar is
 * deliberately conservative: a class is claimed only on an explicit signal, so an
 * ambiguous "refactor the auth flow" stays with the senior rather than risking a
 * judgement-heavy edit on the cheaper tier.
 *
 * @sem domain=delegation role=classifier
 */

export type DelegableClass =
  | "tests"
  | "docs"
  | "mechanical_refactor"
  | "lint_format"
  | "none";

export interface DelegableVerdict {
  /** True when `class` is anything other than "none". */
  readonly delegable: boolean;
  readonly class: DelegableClass;
  /** One-line, human-readable justification for telemetry/debugging. */
  readonly reason: string;
}

/** Test addition/improvement — the safest delegable class (checks verify it). */
const TEST_SIGNALS = [
  "add test",
  "add a test",
  "add tests",
  "write test",
  "write a test",
  "write tests",
  "unit test",
  "integration test",
  "test coverage",
  "improve test",
  "improve the test",
  "more tests",
  "test case",
  "spec for",
  "tdd",
];

/** Docstring / `@sem` / comment maintenance — prose, no logic change. */
const DOC_SIGNALS = [
  "docstring",
  "doc comment",
  "doc-comment",
  "@sem",
  "jsdoc",
  "tsdoc",
  "document the",
  "add comments",
  "add a comment",
  "comment the",
  "update the comment",
  "update comments",
];

/** Lint / format fixups — fully mechanical, tool-checkable. */
const LINT_FORMAT_SIGNALS = [
  "lint",
  "format",
  "prettier",
  "biome",
  "reformat",
  "fix formatting",
  "fix the formatting",
  "auto-fix",
  "autofix",
];

/**
 * Mechanical refactor verbs — structural moves with no design judgement. Plain
 * "refactor" is intentionally EXCLUDED: it can hide a redesign, so it stays with
 * the senior unless paired with the explicit "mechanical" qualifier below.
 */
const MECHANICAL_REFACTOR_SIGNALS = [
  "rename",
  "extract method",
  "extract function",
  "extract a",
  "inline the",
  "inline this",
  "move the",
  "dedupe",
  "deduplicate",
  "mechanical refactor",
];

function matches(lower: string, signals: readonly string[]): boolean {
  return signals.some((s) => lower.includes(s));
}

/**
 * Classify whether a prompt names a delegable task class. Precedence runs from the
 * highest-confidence, most-verifiable class downward (tests → lint/format → docs →
 * mechanical refactor); the first match wins. No match returns `class:"none"`.
 */
export function classifyDelegable(prompt: string): DelegableVerdict {
  const lower = (prompt ?? "").toLowerCase();

  if (matches(lower, TEST_SIGNALS)) {
    return {
      delegable: true,
      class: "tests",
      reason: "test addition/improvement",
    };
  }
  if (matches(lower, LINT_FORMAT_SIGNALS)) {
    return {
      delegable: true,
      class: "lint_format",
      reason: "lint/format fixup",
    };
  }
  if (matches(lower, DOC_SIGNALS)) {
    return {
      delegable: true,
      class: "docs",
      reason: "docstring/@sem maintenance",
    };
  }
  if (matches(lower, MECHANICAL_REFACTOR_SIGNALS)) {
    return {
      delegable: true,
      class: "mechanical_refactor",
      reason: "mechanical refactor (rename/extract/inline/move)",
    };
  }
  return {
    delegable: false,
    class: "none",
    reason: "no delegable class signal",
  };
}

/** Convenience predicate for callers that only need the boolean. */
export function isDelegable(prompt: string): boolean {
  return classifyDelegable(prompt).delegable;
}
