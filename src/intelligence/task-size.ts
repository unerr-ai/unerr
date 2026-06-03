/**
 * Task-size classifier — Sprint 3 (R5), T3.1.
 *
 * The token-overhead research (`.internal/research/tool-call-token-overhead.md`)
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
   * Sharpens the verdict: 0–1 → trivial/single, ≤3 → single_entity, more → sweep.
   * Omit when classifying purely from the prompt (pre-recon).
   */
  readonly entityCount?: number;
}

/**
 * Verbs/openers that signal a read-only "understand / explain / locate" ask —
 * no mutation, so the markers + turn_summary ceremony buys nothing.
 */
const READ_ONLY_OPENERS = [
  "explain", "what", "what's", "whats", "how", "why", "describe", "show",
  "summarize", "summarise", "tell", "where", "which", "does", "do", "is",
  "are", "can", "list", "understand", "walk", "give",
];

/**
 * Phrases that mark a genuinely broad sweep regardless of how many entities a
 * single search returned — "every place", "across the codebase", a rename/migrate.
 */
const SWEEP_SIGNALS = [
  "every ", "all the ", "everywhere", "across the", "throughout",
  "each of", "all of", "wherever", "refactor", "rename", "migrate",
  "sweep", "audit", "every place", "all callers", "all usages",
  "all references", "codebase-wide", "project-wide", "all files",
];

const WORD_RE = /[^a-z0-9_]+/;

/** Lowercased first meaningful word of the prompt. */
function firstWord(prompt: string): string {
  const t = prompt.trim().toLowerCase().split(WORD_RE).filter(Boolean);
  return t[0] ?? "";
}

function hasSweepSignal(lower: string): boolean {
  return SWEEP_SIGNALS.some((s) => lower.includes(s));
}

function isReadOnlyOpener(prompt: string): boolean {
  return READ_ONLY_OPENERS.includes(firstWord(prompt));
}

/** Does the prompt contain a code-identifier-shaped token (camelCase, snake, path, dotted)? */
function mentionsIdentifier(prompt: string): boolean {
  // camelCase / PascalCase, snake_case, dotted, or a file path with an extension.
  return /[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*|_[a-z]|[A-Za-z0-9_]+\.[A-Za-z]{1,5}\b|\//.test(
    prompt
  );
}

/**
 * Classify the footprint a prompt deserves. When `entityCount` is supplied the
 * cardinality dominates (it reflects what recon actually found); otherwise the
 * verdict comes from prompt shape alone, defaulting to `single_entity` — the
 * safe middle (one recon bundle), never the zero-ceremony `trivial` path unless
 * the prompt clearly reads as a lookup.
 */
export function classifyTaskSize(
  prompt: string,
  opts: ClassifyOptions = {}
): TaskSizeVerdict {
  const lower = (prompt ?? "").toLowerCase();
  const sweep = hasSweepSignal(lower);
  const readOnly = isReadOnlyOpener(prompt ?? "");
  const { entityCount } = opts;

  // A sweep phrase always wins — "find every place X" is broad even if one
  // search happened to return a single hit.
  if (sweep) {
    return { size: "large_sweep", reason: "prompt carries a sweep signal" };
  }

  if (typeof entityCount === "number") {
    if (entityCount > 3) {
      return {
        size: "large_sweep",
        reason: `recon found ${entityCount} entities (> 3)`,
      };
    }
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
