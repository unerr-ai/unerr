/**
 * Core data model for the unerr review engine (docs/reviewer-architecture.md §4, §6).
 *
 * One engine, three surfaces (in-flight / commit gate / on-demand). These types
 * are the single source of truth so a finding is identical wherever it fires.
 *
 * Design notes:
 *  - The engine depends on NARROW structural surfaces (`ReviewGraph`,
 *    `ReviewNotes`, `ReviewDrift`), not the concrete `CozoGraphStore` /
 *    notes / drift modules. `CozoGraphStore` satisfies `ReviewGraph`
 *    structurally, so production passes the real store while tests pass a
 *    fake — the same pattern proven by `EditImpactGraph` in
 *    `intelligence/edit-impact.ts`. This keeps the engine process-agnostic
 *    and unit-testable without a live CozoDB.
 *  - Every `ReviewFinding` obeys the nudge-writing rules in CLAUDE.md
 *    ("Writing nudges and hints"): imperative verb + named tool, no deictic
 *    pronouns, no hedge verbs, real numbers.
 */

import type { LocalEntity } from "../intelligence/local-graph.js";

// ── Severity ─────────────────────────────────────────────────────────────────

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** Total order over severities. Higher = more severe. Drives floor gating. */
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

// ── Change extraction (L0) ─────────────────────────────────────────────────────

export type ChangeKind = "added" | "modified" | "deleted";

/** How a change set was extracted — drives which surface produced it. */
export type ChangeSource = "staged" | "in_flight" | "watcher" | "manual";

/**
 * One entity that changed in a review pass. `added` entities may not yet exist
 * in the graph (no stable key), so `entityKey` can be synthetic; checkers that
 * need a graph key must tolerate a miss.
 */
export interface ChangeEntity {
  kind: ChangeKind;
  /** Graph key when known; synthetic (`<file>::<name>`) for freshly added entities. */
  entityKey: string;
  name: string;
  filePath: string;
  /** Pre-change body. `null` for `added`. */
  oldBody: string | null;
  /** Post-change body. `null` for `deleted`. */
  newBody: string | null;
  /** 1-based line of the entity in the post-change file, when known. */
  line?: number;
}

/**
 * One file that changed in a review pass. Carries whole-file content so
 * file-level checkers (architecture-boundary on import lines, secret-scan on the
 * diff, incomplete-refactor reconciling un-touched callers) operate on the same
 * text the editor wrote — entity-level `oldBody`/`newBody` can't see file-top
 * imports or cross-entity gaps.
 */
export interface ChangeFile {
  path: string;
  kind: ChangeKind;
  /** Pre-change content. `null` for `added`. */
  oldContent: string | null;
  /** Post-change content. `null` for `deleted`. */
  newContent: string | null;
}

/** The unit a single review pass operates over. */
export interface ChangeSet {
  entities: ChangeEntity[];
  /** Changed files with whole-file content (for boundary / secret-scan / incomplete-refactor). */
  files: ChangeFile[];
  source: ChangeSource;
}

// ── Narrow dependency surfaces (structurally satisfied by the real modules) ────

/**
 * Minimal async graph surface the engine + checkers need. `CozoGraphStore`
 * satisfies this structurally. Grows as checkers are added (P0.3+); kept
 * minimal so tests can supply a fake without a live CozoDB.
 */
export interface ReviewGraph {
  getEntitiesByFile(filePath: string): Promise<LocalEntity[]>;
  getCallersOf(entityKey: string): Promise<LocalEntity[]>;
  /**
   * Community/layer label for an entity. Optional — only the architecture-boundary
   * checker needs it; `CozoGraphStore` provides it, fakes that don't drive boundary
   * checks may omit it (the checker degrades to silent).
   */
  getCommunityForEntity?(
    entityKey: string
  ): Promise<{ id: number; label: string } | null>;
}

/** Anchored note as stored by unerr's notes layer (note DSL: kind|anchor|polarity|content). */
export interface ReviewNote {
  kind: string; // cnv | rul | wrn | dec | blk | fct
  anchor: string; // wire format: f:<path> | e:<entity> | g:<glob> | p:
  polarity: string; // + | - | ~
  content: string;
}

/** Minimal notes surface: fetch active notes for a set of wire-format anchors. */
export interface ReviewNotes {
  forAnchors(anchors: string[]): Promise<ReviewNote[]>;
}

/** Minimal drift surface: which entity keys have drifted from their recorded state. */
export interface ReviewDrift {
  driftedEntityKeys: ReadonlySet<string>;
}

/** A project-rule violation, as produced by `intelligence/rule-evaluator.ts:evaluateRules`. */
export interface ReviewRuleViolation {
  ruleKey: string;
  ruleName: string;
  /** Rule's own severity string (e.g. "error" | "warn" | "info"). */
  severity: string;
  message: string;
  filePath: string;
  line?: number;
  matchedCode?: string;
}

/**
 * Minimal rule-evaluation surface: project-rule violations for a changed file.
 * Production closes over the real rule store + `CozoGraphStore` (calling
 * `evaluateRules`); tests supply a fake. Absent (`null` on the context) means no
 * rule store is wired for this pass — the convention checker stays silent.
 */
export interface ReviewRules {
  violationsForFile(
    filePath: string,
    content: string,
    entityKey?: string
  ): Promise<ReviewRuleViolation[]>;
}

/** A candidate existing entity that may duplicate a newly added one. Carries `body` so the checker can measure shape similarity itself. */
export interface ReviewSearchHit {
  key: string;
  name: string;
  filePath: string;
  body: string;
}

/**
 * Minimal similarity surface for the duplicate-logic checker. Production closes
 * over the name-token search index (`searchEntities`) + entity-body lookup;
 * tests supply a fake. Absent → the duplicate checker stays silent.
 */
export interface ReviewSearch {
  candidatesFor(
    query: { name: string; body: string },
    limit: number
  ): Promise<ReviewSearchHit[]>;
}

// ── Per-surface configuration (mirrors §10 settings shape, additively) ─────────

export interface ReviewConfig {
  /** Findings below this severity are suppressed (not shown), never dropped silently. */
  minSeverity: Severity;
  /** Per-checker enable flags. Absent id = enabled (opt-out, not opt-in). */
  checkers: Record<string, boolean>;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  minSeverity: "info",
  checkers: {},
};

// ── Checker invocation context (L1) ────────────────────────────────────────────

/**
 * Everything a checker is handed for one pass. Notes / drift are nullable — a
 * checker that needs them must degrade gracefully when they are absent (e.g.
 * an in-flight pass with no drift snapshot yet).
 */
export interface ReviewContext {
  changeSet: ChangeSet;
  graph: ReviewGraph;
  notes: ReviewNotes | null;
  drift: ReviewDrift | null;
  /** Project-rule evaluator (convention checker). `null` when no rule store is wired. */
  rules: ReviewRules | null;
  /** Similarity search (duplicate-logic checker). `null` when no search index is wired. */
  search: ReviewSearch | null;
  /** Session `mark_intent`, used as Tier-2 evidence for intent-mismatch checks. */
  intent: string | null;
  config: ReviewConfig;
}

// ── Findings (L2, §6) ──────────────────────────────────────────────────────────

/** Where a finding is anchored — matches the note-dsl `f:` / `e:` anchor kinds. */
export interface FindingAnchor {
  kind: "f" | "e";
  value: string;
  line?: number;
}

/**
 * One review finding. Tier 1 = deterministic graph fact (rendered as a verdict
 * signal); Tier 2 = evidence block for the host model to elaborate (never
 * rendered as a unerr verdict — `needsModel: true`).
 */
export interface ReviewFinding {
  checkerId: string;
  tier: 1 | 2;
  severity: Severity;
  anchor: FindingAnchor;
  /** One-line summary with real numbers: "9 callers mismatch changed signature of foo". */
  title: string;
  /** Concrete evidence lines: ["src/a.ts:42 calls foo(x)", …]. Never empty for a real finding. */
  evidence: string[];
  /** Pasteable next action — a named tool call or a concrete edit. No hedge verbs. */
  action: string;
  /** Tier-2 marker: render as evidence for the host model, not as a verdict. */
  needsModel: boolean;
  /** Optional token-savings estimate, feeds guard-formatter accounting (like behaviors). */
  tokensPrevented?: number;
}

// ── Engine output (L3 input) ────────────────────────────────────────────────────

export interface CheckerError {
  checkerId: string;
  error: string;
}

/**
 * Result of one `ReviewEngine.run`. `findings` are already gated (≥ floor),
 * deduped, and sorted by severity descending. `suppressed` counts findings
 * dropped by the floor (so a surface can say "3 low findings hidden").
 */
export interface ReviewReport {
  findings: ReviewFinding[];
  /** Count of findings produced but below the severity floor. */
  suppressed: number;
  /** Checker ids that ran (enabled and did not throw). */
  checkersRun: string[];
  /** Checkers that threw — isolated so one failure never kills the report. */
  checkersErrored: CheckerError[];
  durationMs: number;
  /** True when no findings survived gating — an evidenced-clean pass. */
  clean: boolean;
}
