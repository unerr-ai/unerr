/**
 * Git-backed review orchestration (.internal/reviewer-architecture.md §5.2 Surface B,
 * §5.3 Surface C).
 *
 * The review ENGINE is process-agnostic and depends only on the narrow
 * structural surfaces in `types.ts`. THIS module is the orchestrator that
 * bridges the concrete stores (`CozoGraphStore`, `NotesStore`) into those
 * narrow surfaces and assembles a `ChangeSet` from a git state (the staged
 * index, today; an arbitrary range, for Surface C). It is the single wiring
 * point both the commit gate (`check-commit`) and the on-demand command reuse,
 * so a finding is byte-identical whichever surface produced it.
 *
 * Standalone-safe: the commit gate runs in a short-lived CLI process with no
 * proxy attached, so every dependency degrades to `null` (the matching checker
 * stays silent) rather than throwing. False-positive discipline (§9): a missing
 * store produces silence, never a guess.
 */

import { extname } from "node:path";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import type { NotesStore } from "../intelligence/notes-store.js";
import { defaultCheckers } from "./checkers/index.js";
import { ReviewEngine } from "./engine.js";
import {
  type ChangeEntity,
  type ChangeFile,
  type ChangeSet,
  type ChangeSource,
  DEFAULT_REVIEW_CONFIG,
  type ReviewConfig,
  type ReviewGraph,
  type ReviewNote,
  type ReviewNotes,
  type ReviewReport,
  type ReviewRules,
  type ReviewSearch,
  type ReviewSearchHit,
  type Severity,
} from "./types.js";

/** File extensions the reviewer evaluates. Mirrors the commit-gate's historical
 *  set so behaviour is stable; non-code files carry no graph entities and are
 *  skipped by the entity-bound checkers anyway. */
const REVIEWABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
]);

/** A staged path keeps the reviewer focused; anything else is git noise. */
export function isReviewableFile(path: string): boolean {
  return REVIEWABLE_EXTENSIONS.has(extname(path));
}

// ── Adapters: concrete stores → narrow review surfaces ──────────────────────

/**
 * `ReviewRules` over the live graph's rule store. `violationsForFile` loads the
 * file's rules and runs the existing `evaluateRules` engine — the SAME evaluator
 * the legacy convention check used, so the commit gate's rule verdict never
 * drifts from what `unerr` taught itself. Returns `[]` when no rules apply.
 */
export function reviewRulesFromGraph(graph: CozoGraphStore): ReviewRules {
  return {
    async violationsForFile(filePath, content, entityKey) {
      const rules = await graph.getRules(filePath);
      if (rules.length === 0) return [];
      const { evaluateRules } = await import(
        "../intelligence/rule-evaluator.js"
      );
      const result = await evaluateRules(
        rules,
        filePath,
        content,
        graph,
        entityKey ? { entityKey } : undefined
      );
      // RuleViolation is a structural superset of ReviewRuleViolation.
      return result.violations;
    },
  };
}

/**
 * `ReviewSearch` over the name-token search index. `candidatesFor` ranks by name
 * (`searchEntities`), then hydrates each hit's body (`getEntity`) so the
 * duplicate-logic checker can measure body-shape similarity. Hits without a body
 * are dropped — there is nothing to compare.
 */
export function reviewSearchFromGraph(graph: CozoGraphStore): ReviewSearch {
  return {
    async candidatesFor(query, limit) {
      const hits = await graph.searchEntities(query.name, limit);
      const out: ReviewSearchHit[] = [];
      for (const h of hits) {
        const entity = await graph.getEntity(h.key);
        if (!entity?.body) continue;
        out.push({
          key: h.key,
          name: h.name,
          filePath: h.file_path,
          body: entity.body,
        });
      }
      return out;
    },
  };
}

/**
 * `ReviewNotes` over the anchored-notes store. `forAnchors` reads active
 * (non-superseded) notes for the wire-format anchors and re-serialises each to
 * the DSL anchor the memory-drift checker matches on. A synthetic `session_id`
 * keeps the store's per-session counter honest without a live agent session.
 */
export function reviewNotesFromStore(
  store: NotesStore,
  sessionId = "review-gate"
): ReviewNotes {
  return {
    async forAnchors(anchors) {
      if (anchors.length === 0) return [];
      const result = await store.recallByAnchors({
        anchors,
        session_id: sessionId,
      });
      return result.notes.map(
        (n): ReviewNote => ({
          kind: n.kind,
          anchor: `${n.anchor_type}:${n.anchor_value}`,
          polarity: n.polarity,
          content: n.content,
        })
      );
    },
  };
}

// ── Change-set assembly ─────────────────────────────────────────────────────

/**
 * Read the staged index into review `ChangeFile`s. Each reviewable path is
 * resolved to its HEAD (pre-change) and index (post-change) blobs so file-level
 * checkers see the exact text `git commit` would record. Added files have no
 * HEAD content; deleted files have no staged content.
 */
export async function collectStagedChangeFiles(
  cwd: string
): Promise<ChangeFile[]> {
  const { getStagedFileStatuses, getStagedContent, getHeadContent } =
    await import("../utils/git.js");
  const statuses = await getStagedFileStatuses(cwd);
  const files: ChangeFile[] = [];
  for (const { path, kind } of statuses) {
    if (!isReviewableFile(path)) continue;
    const oldContent =
      kind === "added" ? null : await getHeadContent(cwd, path);
    const newContent =
      kind === "deleted" ? null : await getStagedContent(cwd, path);
    files.push({ path, kind, oldContent, newContent });
  }
  return files;
}

/**
 * Read the diff between two git refs (`<from>..<to>`) into review `ChangeFile`s,
 * for the on-demand range reviewer (`unerr review --range A..B`). The parallel
 * of {@link collectStagedChangeFiles}: each reviewable path resolves to its blob
 * at `from` (pre-change) and `to` (post-change). Files added in the range have
 * no `from` blob; files deleted in the range have no `to` blob.
 */
export async function collectRangeChangeFiles(
  cwd: string,
  from: string,
  to: string
): Promise<ChangeFile[]> {
  const { getRangeFileStatuses, getContentAtRef } = await import(
    "../utils/git.js"
  );
  const statuses = await getRangeFileStatuses(cwd, from, to);
  const files: ChangeFile[] = [];
  for (const { path, kind } of statuses) {
    if (!isReviewableFile(path)) continue;
    const oldContent =
      kind === "added" ? null : await getContentAtRef(cwd, from, path);
    const newContent =
      kind === "deleted" ? null : await getContentAtRef(cwd, to, path);
    files.push({ path, kind, oldContent, newContent });
  }
  return files;
}

/**
 * Read every tracked source file in the work tree into review `ChangeFile`s, for
 * the full-repo reviewer (`unerr review --all`). Each reviewable tracked path is
 * treated as `added` — its current working-tree content is the `newContent` and
 * there is no prior blob — so every entity in the repo is reviewed, not just a
 * git diff slice. The same engine/checkers run; the no-diff scope just feeds the
 * whole tree through. Returns `[]` on any git error.
 */
export async function collectFullRepoChangeFiles(
  cwd: string
): Promise<ChangeFile[]> {
  const { listTrackedFiles } = await import("../utils/git.js");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const tracked = await listTrackedFiles(cwd);
  const files: ChangeFile[] = [];
  for (const path of tracked) {
    if (!isReviewableFile(path)) continue;
    let newContent: string | null = null;
    try {
      newContent = await readFile(join(cwd, path), "utf-8");
    } catch {
      // Unreadable (deleted from disk but still tracked) → skip it.
      continue;
    }
    files.push({ path, kind: "added", oldContent: null, newContent });
  }
  return files;
}

/**
 * Resolve the entities each changed file touches via the graph and pair them
 * with whole-file old/new content. The signature-change primitive is
 * name-scoped, so whole-file content is the correct per-entity input (the same
 * contract `computeEditImpact` and the in-flight path rely on). Deleted files
 * and files with no indexed entities contribute no entities — file-level
 * checkers (secret-scan) still run off `ChangeFile.newContent`.
 */
export async function buildChangeSet(
  files: ChangeFile[],
  graph: { getEntitiesByFile: CozoGraphStore["getEntitiesByFile"] },
  source: ChangeSource
): Promise<ChangeSet> {
  const entities: ChangeEntity[] = [];
  for (const file of files) {
    if (file.kind === "deleted") continue;
    const inFile = await graph.getEntitiesByFile(file.path);
    for (const e of inFile) {
      entities.push({
        // File-level kind is the right granularity here: a freshly added file's
        // entities are `added`; an edited file's entities are `modified`.
        kind: file.kind,
        entityKey: e.key,
        name: e.name,
        filePath: file.path,
        oldBody: file.oldContent,
        newBody: file.newContent,
        line: e.start_line,
      });
    }
  }
  return { entities, files, source };
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface GitReviewDeps {
  /** Anchored-notes surface (memory-drift checker). `null` → checker silent. */
  notes?: ReviewNotes | null;
  /** Session intent, used as Tier-2 evidence. */
  intent?: string | null;
}

export interface GitReviewOptions {
  /** Floor severity to surface. Below this, findings are counted as suppressed. */
  minSeverity?: Severity;
  config?: ReviewConfig;
}

export interface GitReviewOutcome {
  report: ReviewReport;
  /** Reviewable files in the change set (after extension filtering). */
  filesReviewed: number;
}

/**
 * What slice of git history a review pass covers (Surface C). `staged` reviews
 * the index (the same slice the commit gate uses); `range` reviews everything
 * between two refs. Both flow through {@link reviewScopedChanges} so a finding
 * is byte-identical regardless of which slice produced it.
 */
export type ReviewScope =
  | { kind: "staged" }
  | { kind: "range"; from: string; to: string }
  | { kind: "full" };

/** Parse a `A..B` range spec into a {@link ReviewScope}. Returns null when the
 *  spec is not exactly two non-empty refs joined by `..` — the caller surfaces
 *  the usage error rather than silently reviewing the wrong slice. */
export function parseRangeScope(spec: string): ReviewScope | null {
  const m = spec.split("..");
  if (m.length !== 2) return null;
  const from = m[0]?.trim();
  const to = m[1]?.trim();
  if (!from || !to) return null;
  return { kind: "range", from, to };
}

/** Empty {@link ReviewGraph} for a no-graph pass: yields no entities and no
 *  callers, so entity-bound checkers stay silent while file-level checkers
 *  (secret-scan) still run off `ChangeFile` content. */
const EMPTY_REVIEW_GRAPH: ReviewGraph = {
  getEntitiesByFile: async () => [],
  getCallersOf: async () => [],
};

/**
 * Run the full Tier-1 checker set over an already-collected set of changed
 * files. The single engine-wiring point both the staged and range scopes (and
 * the commit gate) share: when a graph is present it powers the entity-bound
 * checkers and (via adapters) the rule + search surfaces; `deps.notes` powers
 * memory-drift. A `null` graph degrades the whole graph-backed layer to silence
 * (§9 false-positive discipline) while file-level checkers still fire. Always
 * resolves — an empty file set yields a clean report.
 */
async function runReviewOnChangeFiles(
  files: ChangeFile[],
  graph: CozoGraphStore | null,
  source: ChangeSource,
  deps: GitReviewDeps,
  options: GitReviewOptions
): Promise<GitReviewOutcome> {
  const reviewGraph: ReviewGraph = graph ?? EMPTY_REVIEW_GRAPH;
  const changeSet = await buildChangeSet(files, reviewGraph, source);

  const engine = new ReviewEngine();
  engine.registerAll(defaultCheckers());

  const report = await engine.run(
    {
      changeSet,
      graph: reviewGraph,
      notes: deps.notes ?? null,
      drift: null,
      rules: graph ? reviewRulesFromGraph(graph) : null,
      search: graph ? reviewSearchFromGraph(graph) : null,
      intent: deps.intent ?? null,
      config: options.config ?? DEFAULT_REVIEW_CONFIG,
    },
    { minSeverity: options.minSeverity ?? "medium" }
  );

  return { report, filesReviewed: files.length };
}

/**
 * Review the staged index against the full Tier-1 checker set. Always resolves
 * — an empty change set yields a clean report. The commit gate's entry point;
 * equivalent to `reviewScopedChanges(cwd, {kind:'staged'}, …)`.
 */
export async function reviewStagedChanges(
  cwd: string,
  graph: CozoGraphStore,
  deps: GitReviewDeps = {},
  options: GitReviewOptions = {}
): Promise<GitReviewOutcome> {
  const files = await collectStagedChangeFiles(cwd);
  return runReviewOnChangeFiles(files, graph, "staged", deps, options);
}

/**
 * Review an arbitrary scope (staged index or a `from..to` range) against the
 * full Tier-1 checker set — the on-demand `review_changes` tool + `unerr review`
 * CLI entry point. A range or full-repo scope carries `source: "manual"` (an
 * on-demand pass, not a staged-commit one); staged carries `source: "staged"`.
 * The `full` scope reviews every tracked source file (not a diff slice). A
 * `null` graph (repo not yet indexed) runs file-level checkers only. Always
 * resolves.
 */
export async function reviewScopedChanges(
  cwd: string,
  scope: ReviewScope,
  graph: CozoGraphStore | null,
  deps: GitReviewDeps = {},
  options: GitReviewOptions = {}
): Promise<GitReviewOutcome> {
  let files: ChangeFile[];
  if (scope.kind === "staged") {
    files = await collectStagedChangeFiles(cwd);
  } else if (scope.kind === "range") {
    files = await collectRangeChangeFiles(cwd, scope.from, scope.to);
  } else {
    files = await collectFullRepoChangeFiles(cwd);
  }
  const source: ChangeSource = scope.kind === "staged" ? "staged" : "manual";
  return runReviewOnChangeFiles(files, graph, source, deps, options);
}
