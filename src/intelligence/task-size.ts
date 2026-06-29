/**
 * Task-size classifier — Sprint 3 (R5), T3.1.
 *
 * The token-overhead research (`.internal/archive/TOKEN_ECONOMICS_AND_SAVINGS.md`)
 * §4 decision rule: unerr is net-positive on large blind-navigation tasks and
 * net-negative on trivial lookups (round-trip overhead wins on the small ones).
 * The fix is to make unerr self-select its footprint by task size so the cheap
 * path is the default:
 *
 *   trivial       → built-in read, NO unerr ceremony (skip markers + summary)
 *   single_entity → ONE `unerr recon` bundle (R1)
 *   large_sweep   → subagent recon → digest (R6, Sprint 4)
 *
 * This module is the pure verdict function the footprint router and the
 * orchestrator skill consult. It classifies from prompt verbs alone, and tightens
 * the verdict when the caller can supply recon result cardinality (entity count).
 * No I/O, no graph — unit-testable in isolation.
 */

export type TaskSize = "trivial" | "single_entity" | "large_sweep";

export interface TaskSizeVerdict {
  readonly size: TaskSize;
  /** One-line, human-readable justification for telemetry/debugging. */
  readonly reason: string;
}

export interface ClassifyOptions {
  /**
   * Number of entities a recon/search turned up for this prompt, when known.
   * Sharpens trivial-vs-single only: read-only verb + ≤1 entity → trivial,
   * otherwise → single_entity. It does NOT promote to large_sweep — recon's
   * search returns ~10 ranked candidates for ANY focused prompt, so cardinality
   * is search breadth, not task size; only a sweep PHRASE marks a real sweep.
   * Omit when classifying purely from the prompt (pre-recon).
   */
  readonly entityCount?: number;
}

/**
 * Verbs/openers that signal a read-only "understand / explain / locate" ask —
 * no mutation, so the markers + turn_summary ceremony buys nothing.
 */
const READ_ONLY_OPENERS = [
  "explain",
  "what",
  "what's",
  "whats",
  "how",
  "why",
  "describe",
  "show",
  "summarize",
  "summarise",
  "tell",
  "where",
  "which",
  "does",
  "do",
  "is",
  "are",
  "can",
  "list",
  "understand",
  "walk",
  "give",
];

/**
 * Breadth phrases that mark a genuinely many-site change regardless of the verb —
 * "every place", "across the codebase", "all callers". These ALWAYS win, because
 * the phrase itself names the breadth.
 */
const BREADTH_SIGNALS = [
  "every ",
  "all the ",
  "everywhere",
  "across the",
  "throughout",
  "each of",
  "all of",
  "wherever",
  "sweep",
  "every place",
  "all callers",
  "all usages",
  "all references",
  "codebase-wide",
  "project-wide",
  "all files",
];

/**
 * Action verbs that DESCRIBE a change but do not by themselves imply breadth:
 * "refactor signToken" / "rename getUser to fetchUser" are focused single-entity
 * edits; "refactor across the codebase" is a sweep (caught by a BREADTH_SIGNAL).
 * These mark a sweep ONLY when the prompt names no specific code identifier — i.e.
 * the target is broad and unnamed ("refactor the error handling") rather than a
 * single entity. Conflating the verb with breadth was stripping the focus body
 * from exactly the focused-edit case the recon bundle exists to front-load.
 */
const SCOPED_ACTION_VERBS = ["refactor", "rename", "migrate", "audit"];

/**
 * Short acknowledgement phrases that confirm a prior answer or give a green-light
 * without introducing a new task. Matched against the trimmed-lowercased prompt.
 */
const CONTINUATION_SIGNALS = new Set([
  "yes",
  "yeah",
  "ok",
  "okay",
  "go ahead",
  "continue",
  "proceed",
  "do it",
  "lgtm",
  "sounds good",
  "thanks",
  "ship it",
]);

const WORD_RE = /[^a-z0-9_]+/;

/** Lowercased first meaningful word of the prompt. */
function firstWord(prompt: string): string {
  const t = prompt.trim().toLowerCase().split(WORD_RE).filter(Boolean);
  return t[0] ?? "";
}

/**
 * Strip common inflection suffixes (ing/ed/es/s) so signal-list comparisons
 * match inflected verb forms. Guards prevent over-stripping short words.
 */
function normalizeSuffix(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

function hasSweepSignal(lower: string, prompt: string): boolean {
  // A breadth phrase names the scope outright — always a sweep.
  if (BREADTH_SIGNALS.some((s) => lower.includes(s))) return true;
  // An action verb (refactor/rename/migrate/audit) is a sweep only when no
  // single entity is named: "refactor parseHeader" is focused; "refactor the
  // error handling" (no identifier) is broad.
  if (
    SCOPED_ACTION_VERBS.some((v) => lower.includes(v)) &&
    !mentionsIdentifier(prompt)
  ) {
    return true;
  }
  return false;
}

function isReadOnlyOpener(prompt: string): boolean {
  const fw = firstWord(prompt);
  return (
    READ_ONLY_OPENERS.includes(fw) ||
    READ_ONLY_OPENERS.includes(normalizeSuffix(fw))
  );
}

/** True when the prompt is a short continuation phrase (green-light / acknowledgement). */
function isContinuation(trimmedLower: string): boolean {
  if (CONTINUATION_SIGNALS.has(trimmedLower)) return true;
  for (const signal of CONTINUATION_SIGNALS) {
    if (trimmedLower.startsWith(signal)) {
      const rest = trimmedLower.slice(signal.length);
      // Allow only trailing punctuation / whitespace after the signal
      if (/^[.,!?;:\s]*$/.test(rest)) return true;
    }
  }
  return false;
}

/** Does the prompt contain a code-identifier-shaped token (camelCase, snake, path, dotted)? */
function mentionsIdentifier(prompt: string): boolean {
  // camelCase / PascalCase, snake_case, dotted, or a file path with an extension.
  return /[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*|_[a-z]|[A-Za-z0-9_]+\.[A-Za-z]{1,5}\b|\//.test(
    prompt
  );
}

/**
 * Classify the footprint a prompt deserves. A sweep PHRASE always wins
 * (large_sweep). Otherwise the verdict defaults to `single_entity` — the safe
 * middle (one recon bundle) — and a supplied `entityCount` only demotes to the
 * zero-ceremony `trivial` path (read-only verb + ≤1 entity). Cardinality never
 * promotes to large_sweep: recon's ~10-candidate search breadth is not task size.
 */
export function classifyTaskSize(
  prompt: string,
  opts: ClassifyOptions = {}
): TaskSizeVerdict {
  const lower = (prompt ?? "").toLowerCase();
  const sweep = hasSweepSignal(lower, prompt ?? "");
  const readOnly = isReadOnlyOpener(prompt ?? "");
  const { entityCount } = opts;

  // A sweep phrase always wins — "find every place X" is broad even if one
  // search happened to return a single hit.
  if (sweep) {
    return { size: "large_sweep", reason: "prompt carries a sweep signal" };
  }

  if (typeof entityCount === "number") {
    // Cardinality does NOT promote to large_sweep: recon's search returns ~10
    // ranked candidates for any focused prompt, so a high count is search
    // breadth, not a sweep. Only a sweep PHRASE (handled above) marks one.
    // entityCount sharpens the trivial-vs-single split only.
    if (readOnly && entityCount <= 1) {
      return {
        size: "trivial",
        reason: `read-only verb + ${entityCount} entity`,
      };
    }
    return {
      size: "single_entity",
      reason: `recon found ${entityCount} entit${entityCount === 1 ? "y" : "ies"}`,
    };
  }

  // Prompt-only classification (pre-recon).
  if (readOnly && !mentionsIdentifier(prompt ?? "")) {
    return {
      size: "trivial",
      reason: "read-only verb, no specific code identifier",
    };
  }
  return {
    size: "single_entity",
    reason: "default footprint (one recon bundle)",
  };
}

/** True when the verdict should skip markers + turn_summary ceremony (R5, T3.2). */
export function skipsCeremony(size: TaskSize): boolean {
  return size === "trivial";
}

/** True when the task should be routed to a single recon bundle (R5, T3.3). */
export function prefersReconBundle(size: TaskSize): boolean {
  return size === "single_entity" || size === "large_sweep";
}

export type InjectionTier = "skip" | "focused" | "broad";

export interface InjectionDecision {
  readonly tier: InjectionTier;
  /** false ONLY for "skip" */
  readonly inject: boolean;
  /** skip:0, focused:2, broad:4 */
  readonly noteMax: number;
  /** Short telemetry string. */
  readonly reason: string;
}

/**
 * Maps a prompt to an injection tier (skip/focused/broad) that controls how
 * many anchored notes and what injection depth the footprint router applies.
 * Continuation phrases short-circuit to skip before classifyTaskSize is called,
 * so green-lights are never misclassified as new tasks.
 *
 * @sem domain=intelligence role=classifier
 */
export function classifyInjectionTier(prompt: string): InjectionDecision {
  const trimmedLower = (prompt ?? "").trim().toLowerCase();

  if (isContinuation(trimmedLower)) {
    return {
      tier: "skip",
      inject: false,
      noteMax: 0,
      reason: "continuation phrase",
    };
  }

  const verdict = classifyTaskSize(prompt);

  switch (verdict.size) {
    case "trivial":
      return {
        tier: "skip",
        inject: false,
        noteMax: 0,
        reason: verdict.reason,
      };
    case "single_entity":
      return {
        tier: "focused",
        inject: true,
        noteMax: 2,
        reason: verdict.reason,
      };
    case "large_sweep":
      return {
        tier: "broad",
        inject: true,
        noteMax: 4,
        reason: verdict.reason,
      };
  }
}
