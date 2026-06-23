/**
 * Delegable-task classifier — Lever C (TOKEN_ECONOMICS_AND_SAVINGS §11.2).
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
  | "recon"
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

/**
 * Read-only recon — "go find out X" investigations that produce a digest, not an
 * edit. The cheapest delegable class: a worker model reads the graph and returns
 * only the answer, so a frontier master never spends tokens on the search itself.
 * Conservative signals — an explicit investigate/trace verb, not any question.
 */
const RECON_SIGNALS = [
  "find out",
  "figure out how",
  "figure out where",
  "investigate",
  "look into",
  "trace how",
  "trace the",
  "track down",
  "understand how",
  "research how",
  "dig into",
];

function matches(lower: string, signals: readonly string[]): boolean {
  return signals.some((s) => lower.includes(s));
}

/**
 * Interrogative openers — a prompt that LEADS with one (or ends with "?") is a
 * question, not an imperative delegation command. The trailing space anchors
 * the word so "document …" never trips "do ".
 */
const QUESTION_OPENERS = [
  "did ",
  "do ",
  "does ",
  "is ",
  "are ",
  "was ",
  "were ",
  "should ",
  "can ",
  "could ",
  "would ",
  "will ",
  "why ",
  "what ",
  "which ",
  "when ",
  "who ",
  "how ",
  "have we",
  "are we",
  "is it",
];

/** A delegable noun under negation ("no unit tests", "without lint"). */
const NEGATED_SIGNAL =
  /\b(no|without|not|don't|dont|never|skip)\s+(\w+\s+){0,2}(tests?|lint|format|docstrings?|comments?)\b/;

/** Meta / verification framing — about EXERCISING the code, not writing a unit. */
const META_SIGNALS = [
  "verify",
  "did we",
  "are working",
  "getting triggered",
  "really being",
  "actually being",
  "actually getting",
  "imagine you",
  "regular user",
  "test these feature",
  "test all these",
];

/**
 * Speculative / modal mood — design deliberation ("should we add a feature…",
 * "what if we…"), not an imperative handoff. The negation-and-speculation pair
 * is the standard non-factual filter in rule-based intent detection.
 */
const SPECULATION_SIGNALS = [
  "should we",
  "could we",
  "shall we",
  "what if",
  "do you think",
  "is it worth",
  "would it make sense",
  "would it be better",
  "i wonder if",
];

/**
 * Harness narration — a session-continuation summary injected by the agent
 * runtime, not a user task. These arrive verbatim and must never fire a nudge.
 */
const NARRATION_SIGNALS = [
  "this session is being continued",
  "session is being continued",
  "the conversation is summarized",
  "continue the conversation from where",
  "summary of the conversation",
];

/**
 * True when a prompt only MENTIONS a delegable signal word but is a question, a
 * negation, a speculation, a meta/verification ask, or harness narration — i.e.
 * not an imperative handoff. Runs BEFORE class matching to keep the delegate
 * nudge high-precision: substring matching alone fired it on "did we test all
 * these?", "no unit tests …", "should we add …", and a pasted session summary,
 * false positives that trained the agent to ignore the nudge.
 */
function isNonTaskMention(lower: string): boolean {
  const trimmed = lower.trim();
  if (trimmed.endsWith("?")) return true;
  if (QUESTION_OPENERS.some((q) => trimmed.startsWith(q))) return true;
  if (NEGATED_SIGNAL.test(lower)) return true;
  if (META_SIGNALS.some((m) => lower.includes(m))) return true;
  if (SPECULATION_SIGNALS.some((m) => lower.includes(m))) return true;
  if (NARRATION_SIGNALS.some((m) => lower.includes(m))) return true;
  return false;
}

/**
 * Imperative action verbs that turn a test NOUN into a test COMMAND. "test" /
 * "unit test" / "test coverage" are ordinary English; absent one of these the
 * mention is descriptive ("the test suite is slow") or QA ("test these by
 * running prompts"), not a handoff to WRITE a unit. The tests class — unlike
 * rename/extract/lint, which are already imperative verbs — gates on this.
 */
const TEST_IMPERATIVE_VERBS = [
  "add ",
  "write ",
  "create ",
  "implement ",
  "increase ",
  "improve ",
  "expand ",
  "extend ",
  "cover ",
  "build ",
  "generate ",
  "raise ",
  "boost ",
  "backfill ",
  "fill in ",
  "more ",
];

/**
 * Classify whether a prompt names a delegable task class. Precedence runs from the
 * highest-confidence, most-verifiable class downward (tests → lint/format → docs →
 * mechanical refactor); the first match wins. No match returns `class:"none"`.
 */
export function classifyDelegable(prompt: string): DelegableVerdict {
  const lower = (prompt ?? "").toLowerCase();

  // Precision gate: drop questions / negations / speculation / meta / narration
  // before any class match so the nudge only fires on an imperative handoff.
  if (isNonTaskMention(lower)) {
    return {
      delegable: false,
      class: "none",
      reason:
        "question / negation / speculation / meta — not a delegation command",
    };
  }

  // Tests gates on an imperative action verb: "test" alone is QA or description,
  // not a request to write a unit. rename/extract/lint are already verbs, so the
  // other classes below need no such gate.
  if (matches(lower, TEST_SIGNALS) && matches(lower, TEST_IMPERATIVE_VERBS)) {
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
  // Recon ranks LAST among delegable classes: an explicit edit signal above wins,
  // so "investigate and fix the bug" stays an edit task with the senior. Only a
  // pure read-only investigation falls through to here.
  if (matches(lower, RECON_SIGNALS)) {
    return {
      delegable: true,
      class: "recon",
      reason: "read-only recon (find out / investigate / trace)",
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
