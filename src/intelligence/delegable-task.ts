/**
 * Delegable-task classifier — Lever C (.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md §11.2).
 *
 * A task is "delegable" when it belongs to a narrow, check-verifiable class that a
 * cheaper model can complete under a recon brief and senior review: test work,
 * docstring maintenance, mechanical refactors (rename/extract/inline/move),
 * and lint/format fixups. This is ORTHOGONAL to task size — a delegable task can be
 * trivial or a sweep; size routes the recon footprint, this routes the model tier.
 *
 * Pure verdict function — classifies from prompt verbs alone, no I/O, no graph, so
 * the provider gate and the `unerr-delegate` skill can both consult it. The bar is
 * deliberately conservative: a class is claimed only on an explicit signal, so an
 * ambiguous "refactor the auth flow" stays with the senior rather than risking a
 * judgement-heavy edit on the cheaper tier.
 *
 */

export type DelegableClass =
  | "tests"
  | "docs"
  | "mechanical_refactor"
  | "lint_format"
  | "recon"
  | "caller_propagation"
  | "typecheck_fix"
  | "scaffold"
  | "verify"
  | "command_run"
  | "research"
  | "qa_lookup"
  | "inventory_audit"
  | "log_triage"
  | "repro"
  | "codemod"
  | "feature_impl"
  | "code_review"
  | "security_audit"
  | "dependency_upgrade"
  | "git_ops"
  | "benchmark_run"
  | "migration_script"
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

/** Docstring / comment maintenance — prose, no logic change. */
const DOC_SIGNALS = [
  "docstring",
  "doc comment",
  "doc-comment",
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
  "trace what",
  "trace through",
  "trace this",
  "track down",
  "understand how",
  "research how",
  "dig into",
  "map out",
  "walk me through",
];

/**
 * Post-edit caller/import propagation — after the senior changes a signature or
 * moves a symbol, a worker updates every call site + import to match. Mechanical:
 * the blast radius is graph-derivable (`get_references`), no design judgement.
 */
const CALLER_PROPAGATION_SIGNALS = [
  "update the caller",
  "update callers",
  "update all callers",
  "update all the caller",
  "update the call site",
  "update call sites",
  "update all the call site",
  "callers and imports",
  "fix the callers",
  "fix all callers",
  "propagate the signature",
  "propagate the change",
  "propagate the rename",
  "update the imports",
  "update imports",
  "fix the imports",
  "fix broken imports",
];

/**
 * Mechanical compiler-error fixups — resolve tsc / build / type errors whose fix
 * the compiler dictates (missing type, bad import path, arity), not a design
 * choice. A worker applies the fix and re-runs the check. Plain "fix the bug" is
 * EXCLUDED — that needs root-cause judgement and stays with the senior.
 */
const TYPECHECK_FIX_SIGNALS = [
  "fix the type error",
  "fix type errors",
  "fix the type errors",
  "fix the build error",
  "fix build errors",
  "fix the build errors",
  "fix the compile error",
  "fix compile errors",
  "resolve the type error",
  "resolve type errors",
  "fix the tsc error",
  "fix the typecheck",
  "fix the failing typecheck",
  "make it compile",
  "make it typecheck",
  "get it to compile",
  "build is red",
  "the build is red",
  "tsc errors",
  "tsc is red",
  "typecheck is red",
];

/**
 * Scaffold / boilerplate generation — stamp a new file's skeleton from an existing
 * sibling as the template (a test-file shell, a module/component stub, barrel /
 * index exports). The main thread fills the real logic. Narrow signals so "build a
 * new feature" (design) never matches.
 */
const SCAFFOLD_SIGNALS = [
  "scaffold",
  "boilerplate",
  "skeleton",
  "stub out",
  "stub in",
  "stub a",
  "barrel file",
  "barrel export",
  "index exports",
];

/**
 * Verification run — execute the checks (typecheck, targeted tests, lint, build)
 * and report the structured failure list. READ-ONLY: the junior runs commands and
 * returns output, makes no edits. Gates on an explicit RUN phrase, never the word
 * "verify" (META_SIGNALS vetoes that as meta-narration before class matching).
 */
const VERIFY_SIGNALS = [
  "run the test",
  "run tests",
  "run the tests",
  "run the test suite",
  "run typecheck",
  "run the typecheck",
  "run the type check",
  "run tsc",
  "run lint",
  "run the lint",
  "run the linter",
  "run the build",
  "run the checks",
  "make sure it compiles",
  "make sure the tests pass",
  "make sure it builds",
  "check it compiles",
  "check that it builds",
];

/**
 * Shell-command runs — execute a sequence of bash commands (build, scripts,
 * migrations, setup, a batch of one-off commands) and report the output. A junior
 * runs them off the main thread so command output never floods the senior's
 * context. Broader than `verify` (which is specifically the check commands).
 * Gates on an explicit run/execute phrase paired with a command/script noun.
 */
const COMMAND_RUN_SIGNALS = [
  "run these commands",
  "run the following commands",
  "run the commands",
  "run a series of",
  "run a sequence of",
  "run these bash",
  "run the bash",
  "bash commands",
  "shell commands",
  "run the script",
  "run the scripts",
  "run the setup",
  "run the migration",
  "run the migrations",
  "execute these commands",
  "execute the commands",
  "run each of these",
  "run all of these commands",
];

/**
 * Code review — inspect a diff/PR/change set and report findings. READ-ONLY: no
 * edit, a junior reads the changes and returns the feedback for the senior to
 * act on. Gates on an explicit "review"/"look over"/"check" phrase paired with
 * a diff/PR/change noun, not the bare word "review" (too broad on its own).
 */
const CODE_REVIEW_SIGNALS = [
  "review the diff",
  "review this diff",
  "review the pr",
  "review this pr",
  "review my pr",
  "review my changes",
  "review the changes",
  "review this change",
  "check my changes",
  "look over my changes",
  "look over the diff",
  "look over the pr",
  "code review",
];

/**
 * Security audit — scan for vulnerabilities, exposed secrets, or known CVEs.
 * READ-ONLY: a junior reads the code and reports findings, no edit. "injection"
 * is intentionally NOT a bare signal — it would false-positive on "dependency
 * injection"; the narrower "sql injection" / "code injection" phrases are used
 * instead.
 */
const SECURITY_AUDIT_SIGNALS = [
  "security audit",
  "security review",
  "vulnerab",
  "owasp",
  "cve",
  "sql injection",
  "code injection",
  "secrets scan",
  "scan for secrets",
  "leaked secrets",
  "secret scanning",
];

/**
 * Benchmark / profiling run — execute a benchmark or profiler and report the
 * measured numbers. READ-ONLY (run + observe, no edit), the same shape as
 * `verify`/`command_run` but scoped to performance measurement.
 */
const BENCHMARK_RUN_SIGNALS = [
  "run the benchmark",
  "run a benchmark",
  "run benchmarks",
  "benchmark the",
  "run the profiler",
  "profile the",
  "perf run",
  "run perf",
  "measure the latency",
  "measure latency",
  "measure the throughput",
  "measure throughput",
];

/**
 * Web research / docs lookup — gather information from the web (library docs, an
 * API reference, a changelog, the latest published version). READ-ONLY and produces
 * a digest, no edit. A junior fetches and summarizes so the senior never spends its
 * context window on raw doc pages. Routes to the junior tier (web tools granted).
 */
const RESEARCH_SIGNALS = [
  "look up",
  "search the web",
  "search online",
  "find the docs",
  "find docs for",
  "the documentation for",
  "api reference",
  "check the changelog",
  "changelog for",
  "release notes",
  "latest version of",
  "what's the latest",
  "whats the latest",
  "how to use the",
  "what does the doc say",
  "what does the docs say",
  "what do the docs say",
  "what does the documentation say",
  "check the docs for",
];

/**
 * Codebase Q&A — a read-only question about where/which/how the code does
 * something ("where is auth handled", "what calls X", "how does the drainer
 * batch"). Unlike `recon` (an investigate/trace imperative) these are phrased as
 * questions; the class-aware gate lets a question TRIGGER this class instead of
 * vetoing it. A junior reads the graph and returns the answer.
 */
const QA_LOOKUP_SIGNALS = [
  "where is",
  "where are",
  "where does",
  "where do we",
  "where's the",
  "which file",
  "which module",
  "which function",
  "what calls",
  "what uses",
  "what handles",
  "how does",
  "how is",
];

/**
 * Inventory / audit — enumerate every site that matches some predicate ("find all
 * usages of X", "list every place that calls Y", "how many places do Z"). READ-ONLY
 * enumeration, distinct from `caller_propagation` which then EDITS those sites. A
 * junior produces the list; the senior decides what to do with it.
 */
const INVENTORY_AUDIT_SIGNALS = [
  "list all",
  "list every",
  "find all",
  "find every",
  "enumerate",
  "all usages",
  "all the usages",
  "all places that",
  "everywhere that",
  "how many places",
  "audit the",
  "audit all",
  "inventory of",
];

/**
 * Log / error-output triage — read a log file or captured output and extract the
 * failure (the stack, the first error, the relevant lines). READ-ONLY. A junior
 * parses the noise and returns only the signal so it never floods the senior's
 * context.
 */
const LOG_TRIAGE_SIGNALS = [
  "read the log",
  "read the logs",
  "check the log",
  "check the logs",
  "look at the logs",
  "the error in the log",
  "what's the error in",
  "whats the error in",
  "triage the failure",
  "parse the output of",
  "tail the log",
  "grep the logs",
];

/**
 * Reproduction — run the repro steps for a reported bug and report whether it still
 * happens, with the captured output. READ-ONLY (run + observe, no edit). The senior
 * does the root-cause once the junior confirms the symptom. Plain "fix the bug" is
 * NOT here — that needs root-cause judgement and stays with the senior.
 */
const REPRO_SIGNALS = [
  "reproduce the",
  "reproduce this",
  "repro the",
  "run the repro",
  "confirm the bug",
  "confirm the issue",
  "see if it still",
  "check if it still happens",
  "does it still happen",
];

/**
 * Codemod / bulk find-replace — a single mechanical substitution applied across
 * many files ("replace every X with Y", "sweep all files"). Split out of
 * `mechanical_refactor` because its blast radius (many files) routes it to the
 * WORKER tier and the difficulty gate may escalate it to the senior. A single-file
 * rename stays in `mechanical_refactor`.
 */
const CODEMOD_SIGNALS = [
  "codemod",
  "find and replace across",
  "find-and-replace",
  "replace every",
  "replace all occurrences",
  "sweep all files",
  "sweep every file",
  "bulk replace",
  "search and replace across",
  "across all files",
];

/**
 * Dependency / package version bump — bump a package, dependency, or lockfile
 * version. Mechanical: the fix is an install + a test/build run, no design
 * choice. Ordered with the other narrow write-classes, above `feature_impl`.
 */
const DEPENDENCY_UPGRADE_SIGNALS = [
  "bump the dependency",
  "bump dependencies",
  "bump the version",
  "bump packages",
  "bump npm package",
  "upgrade the dependency",
  "upgrade dependencies",
  "upgrade the package",
  "upgrade packages",
  "update the dependency",
  "update dependencies",
  "update the package version",
  "outdated dependencies",
  "outdated deps",
  "outdated packages",
  "renovate",
];

/**
 * Migration / backfill script — write or run a schema migration or data
 * backfill. Ranked ABOVE `feature_impl`: "create a migration" / "write a
 * migration" would otherwise fall into feature_impl's generic "create a "
 * catch-all. Deliberately excludes the bare "run the migration(s)" phrasing —
 * that stays `command_run`'s job (see COMMAND_RUN_SIGNALS); this class only
 * claims the more specific migration/schema/backfill/script phrasing.
 */
const MIGRATION_SCRIPT_SIGNALS = [
  "write a migration",
  "write the migration",
  "write migration script",
  "create a migration",
  "create the migration",
  "migration script",
  "schema migration",
  "data migration",
  "data backfill",
  "backfill script",
  "run the migration script",
  "run a data migration",
  "run the data migration",
];

/**
 * Git operations — branch/PR/rebase/cherry-pick/changelog mechanics around a
 * change, not the change itself. Ranked ABOVE `feature_impl`: "create a
 * branch" would otherwise fall into feature_impl's generic "create a "
 * catch-all.
 */
const GIT_OPS_SIGNALS = [
  "create a branch",
  "create branch",
  "new branch for",
  "open a pr",
  "open the pr",
  "prepare a pr",
  "prepare the pr",
  "prep the pr",
  "rebase onto",
  "rebase the branch",
  "cherry-pick",
  "cherry pick",
  "stage the commit",
  "stage these changes for commit",
  "commit prep",
  "prep the commit",
  "changelog from the commits",
  "changelog from commits",
  "generate the changelog",
];

/**
 * Scoped implementation — constructive edit verbs that name a concrete change
 * (add a flag, wire X into Y, implement a handler) but match none of the narrow
 * write-classes above. The bulk of ordinary coding work lands here; it routes to
 * the WORKER tier, which executes a well-scoped spec at near-frontier quality.
 * Only constructive verbs — plain "fix the bug" has none, so root-cause debugging
 * falls through to recon/none and stays with the senior. Ranks LAST on the
 * imperative path (above read-only) so every narrow class still wins first.
 */
const FEATURE_IMPL_SIGNALS = [
  "add ",
  "implement ",
  "wire up",
  "wire in",
  "wire the",
  "hook up",
  "hook it up",
  "hook the",
  "integrate ",
  "add support",
  "support for",
  "build a ",
  "build the ",
  "build out",
  "create a ",
  "create an ",
  "create the ",
  "set up",
  "set it up",
  "make the ",
  "expose ",
  "emit ",
  "plumb ",
  "connect ",
  "enable ",
  "disable ",
  "replace the",
  "swap the",
  "switch to",
  "switch the",
  "persist ",
  "render ",
  "serialize ",
  "validate the",
];

/**
 * Hard-reasoning veto for {@link FEATURE_IMPL_SIGNALS} ONLY — keeps genuine
 * design / algorithm / architecture / root-cause work on the senior even when the
 * prompt also carries a constructive verb ("implement a new caching ALGORITHM").
 * Scoped to feature_impl, not global: a mechanical "rename FooArchitecture" must
 * still classify as a refactor. The ~9-pt Opus→Sonnet gap concentrates here, so
 * these stay on the strongest model.
 */
const HARD_REASONING_SIGNALS = [
  "design ",
  "redesign",
  "architect",
  "algorithm",
  "data structure",
  "from scratch",
  "root cause",
  "root-cause",
  "diagnose",
  "debug ",
  "why is",
  "why does",
  "why are",
  "figure out why",
  "come up with",
  "best approach",
  "optimal ",
  "concurrency",
  "race condition",
  "thread-saf",
  "rewrite the",
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
 * Global non-task veto — a negation, a meta/verification ask, design speculation,
 * or harness narration is never a delegation command, question OR imperative. Runs
 * BEFORE any class match (read-only or write). Keeps the delegate nudge
 * high-precision: substring matching alone fired it on "no unit tests …",
 * "should we add …", "verify these now", and a pasted session summary.
 */
function hasNonTaskVeto(lower: string): boolean {
  if (NEGATED_SIGNAL.test(lower)) return true;
  if (META_SIGNALS.some((m) => lower.includes(m))) return true;
  if (SPECULATION_SIGNALS.some((m) => lower.includes(m))) return true;
  if (NARRATION_SIGNALS.some((m) => lower.includes(m))) return true;
  return false;
}

/**
 * A prompt that LEADS with a question word or ends with "?" — an interrogative,
 * not an imperative edit command. This blocks only the WRITE classes (a question
 * is never a handoff to change code); the READ-ONLY classes are SAFE on a question
 * because a question IS their trigger ("where is auth handled?").
 */
function isQuestionPrompt(lower: string): boolean {
  const trimmed = lower.trim();
  if (trimmed.endsWith("?")) return true;
  return QUESTION_OPENERS.some((q) => trimmed.startsWith(q));
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
/**
 * Match the READ-ONLY delegable classes (no edit — run checks, read logs, read the
 * graph, fetch docs). Ordered most-specific first; `recon` is the catch-all and
 * ranks last. Safe to call on a question, since a question is these classes'
 * trigger. Returns null when no read-only signal matches.
 */
function matchReadOnly(lower: string): DelegableVerdict | null {
  // Verify's specific check phrases win over the general command_run.
  if (matches(lower, VERIFY_SIGNALS)) {
    return {
      delegable: true,
      class: "verify",
      reason: "verification run (typecheck/tests/lint/build, read-only)",
    };
  }
  if (matches(lower, BENCHMARK_RUN_SIGNALS)) {
    return {
      delegable: true,
      class: "benchmark_run",
      reason: "benchmark/profile run (measure and report, read-only)",
    };
  }
  if (matches(lower, COMMAND_RUN_SIGNALS)) {
    return {
      delegable: true,
      class: "command_run",
      reason: "shell-command run (execute a sequence, report output)",
    };
  }
  if (matches(lower, CODE_REVIEW_SIGNALS)) {
    return {
      delegable: true,
      class: "code_review",
      reason: "code review (inspect a diff/PR, report findings, read-only)",
    };
  }
  if (matches(lower, SECURITY_AUDIT_SIGNALS)) {
    return {
      delegable: true,
      class: "security_audit",
      reason: "security audit (scan for vulnerabilities/secrets, read-only)",
    };
  }
  if (matches(lower, REPRO_SIGNALS)) {
    return {
      delegable: true,
      class: "repro",
      reason: "reproduce a bug (run the repro steps, report, no edit)",
    };
  }
  if (matches(lower, LOG_TRIAGE_SIGNALS)) {
    return {
      delegable: true,
      class: "log_triage",
      reason: "log/error-output triage (read logs, extract the failure)",
    };
  }
  if (matches(lower, INVENTORY_AUDIT_SIGNALS)) {
    return {
      delegable: true,
      class: "inventory_audit",
      reason: "inventory/audit (enumerate usages, read-only)",
    };
  }
  if (matches(lower, QA_LOOKUP_SIGNALS)) {
    return {
      delegable: true,
      class: "qa_lookup",
      reason: "codebase Q&A (where/which/how, read-only)",
    };
  }
  if (matches(lower, RESEARCH_SIGNALS)) {
    return {
      delegable: true,
      class: "research",
      reason: "web research / docs lookup (read-only)",
    };
  }
  // Recon ranks LAST among read-only classes: a more specific read-only signal
  // above wins; only a bare investigate/trace imperative falls through to here.
  if (matches(lower, RECON_SIGNALS)) {
    return {
      delegable: true,
      class: "recon",
      reason: "read-only recon (find out / investigate / trace)",
    };
  }
  return null;
}

export function classifyDelegable(prompt: string): DelegableVerdict {
  const lower = (prompt ?? "").toLowerCase();

  // Global veto: negation / speculation / meta / narration is never a task,
  // question or imperative. Drop it before any class match.
  if (hasNonTaskVeto(lower)) {
    return {
      delegable: false,
      class: "none",
      reason:
        "negation / speculation / meta / narration — not a delegation command",
    };
  }

  // A question is the TRIGGER for the read-only classes ("where is auth handled?",
  // "what's the latest zod version?") but NEVER an edit command. On a question, try
  // only the read-only classes; a question naming none of them is not a handoff.
  if (isQuestionPrompt(lower)) {
    return (
      matchReadOnly(lower) ?? {
        delegable: false,
        class: "none",
        reason: "question — names no read-only delegable class",
      }
    );
  }

  // Imperative path: the WRITE classes rank first so an explicit edit signal wins
  // ("rename X and trace callers" stays a refactor, not recon), then read-only.
  //
  // Tests gates on an imperative action verb: "test" alone is QA or description,
  // not a request to write a unit. rename/extract/lint are already verbs.
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
  // Compiler-error fixups rank above the structural classes: the fix is dictated
  // by tsc/build output, not a design choice, so a worker can apply it directly.
  if (matches(lower, TYPECHECK_FIX_SIGNALS)) {
    return {
      delegable: true,
      class: "typecheck_fix",
      reason: "mechanical typecheck/build-error fix",
    };
  }
  if (matches(lower, DOC_SIGNALS)) {
    return {
      delegable: true,
      class: "docs",
      reason: "docstring maintenance",
    };
  }
  if (matches(lower, MECHANICAL_REFACTOR_SIGNALS)) {
    return {
      delegable: true,
      class: "mechanical_refactor",
      reason: "mechanical refactor (rename/extract/inline/move)",
    };
  }
  // Codemod ranks below an explicit rename (a single-symbol rename is
  // mechanical_refactor) and catches a bulk find-replace across many files.
  if (matches(lower, CODEMOD_SIGNALS)) {
    return {
      delegable: true,
      class: "codemod",
      reason: "bulk find-replace across many files",
    };
  }
  // Dependency bump ranks above feature_impl so its own narrow signals win.
  if (matches(lower, DEPENDENCY_UPGRADE_SIGNALS)) {
    return {
      delegable: true,
      class: "dependency_upgrade",
      reason: "package/dependency version bump",
    };
  }
  // Caller/import propagation ranks below an explicit rename (a "rename X and
  // update callers" prompt is mechanical_refactor's job); this catches the
  // standalone "update all callers of X" follow-up after a senior signature edit.
  if (matches(lower, CALLER_PROPAGATION_SIGNALS)) {
    return {
      delegable: true,
      class: "caller_propagation",
      reason: "caller/import propagation after a signature change",
    };
  }
  if (matches(lower, SCAFFOLD_SIGNALS)) {
    return {
      delegable: true,
      class: "scaffold",
      reason: "scaffold/boilerplate from an existing pattern",
    };
  }
  // Migration/backfill scripts and git ops both rank above feature_impl: their
  // "create a migration" / "create a branch" phrasing would otherwise fall into
  // feature_impl's generic "create a " catch-all.
  if (matches(lower, MIGRATION_SCRIPT_SIGNALS)) {
    return {
      delegable: true,
      class: "migration_script",
      reason: "write/run a schema migration or data backfill",
    };
  }
  if (matches(lower, GIT_OPS_SIGNALS)) {
    return {
      delegable: true,
      class: "git_ops",
      reason: "git mechanics (branch/PR/rebase/cherry-pick/changelog)",
    };
  }
  // Scoped implementation — constructive edit verbs that name none of the narrow
  // write-classes above. Routes to the worker (Sonnet). The HARD_REASONING veto
  // keeps design / algorithm / architecture / root-cause asks on the senior even
  // when they carry a constructive verb. Ranks above read-only so a real edit
  // ("add a --json flag") beats a stray investigative phrase.
  if (
    matches(lower, FEATURE_IMPL_SIGNALS) &&
    !matches(lower, HARD_REASONING_SIGNALS)
  ) {
    return {
      delegable: true,
      class: "feature_impl",
      reason: "scoped implementation from a clear spec",
    };
  }
  // Read-only classes rank last on the imperative path: an explicit edit signal
  // above wins, so "investigate and fix the bug" stays with the senior.
  const readOnly = matchReadOnly(lower);
  if (readOnly) return readOnly;

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
