/**
 * Structured, anchored review report (docs/reviewer-architecture.md §5.3).
 *
 * Surface C (the `review_changes` MCP tool + `unerr review` CLI) needs a
 * *report*, not a stream of `ur|<tag>` lines: findings grouped by anchor
 * (file/entity), each with its evidence and a concrete action, plus a summary
 * header. This module turns a raw {@link ReviewReport} (the engine's output)
 * into that view once, so the tool (JSON) and the CLI (text) render the
 * identical structure — `format.ts` stays the in-flight `ur|` renderer, this is
 * its on-demand sibling.
 *
 * `buildReviewReportView` is pure (no I/O); `renderReviewReportText` is pure
 * plain-text (no ANSI) so both are trivially testable and the CLI can layer its
 * own colour on top of the structure if it wants.
 */

import {
  type ReviewFinding,
  type ReviewReport,
  SEVERITY_RANK,
  type Severity,
} from "./types.js";

/** One finding as it appears in the report view — the wire-anchor is hoisted to
 *  the enclosing group, so the finding keeps only its own fields. */
export interface ReviewReportFindingView {
  checkerId: string;
  tier: 1 | 2;
  severity: Severity;
  /** Tier-2 evidence for the host model, not a deterministic verdict. */
  needsModel: boolean;
  title: string;
  evidence: string[];
  action: string;
  /** 1-based line in the post-change file, when the finding carried one. */
  line?: number;
}

/** Findings sharing one anchor (a file or an entity), most-severe first. */
export interface ReviewReportGroup {
  /** Wire-format anchor: `f:<path>` | `e:<entity_key>`. */
  anchor: string;
  /** `file` when the anchor is a path, `entity` otherwise. */
  anchorKind: "file" | "entity";
  /** Most-severe finding in the group — drives group ordering. */
  topSeverity: Severity;
  findings: ReviewReportFindingView[];
}

/** The full on-demand report. JSON-serialisable as-is for the MCP tool. */
export interface ReviewReportView {
  /** Human label for the reviewed slice: `staged` | `<from>..<to>`. */
  scope: string;
  /** Reviewable files in the change set (after extension filtering). */
  filesReviewed: number;
  /** True when no finding survived gating — an evidenced-clean pass. */
  clean: boolean;
  /** Findings surfaced (at/above the floor). */
  total: number;
  /** Findings produced but below the floor (shown as a count, never dropped silently). */
  suppressed: number;
  /** Count of surfaced findings by severity. */
  bySeverity: Record<Severity, number>;
  /** Surfaced findings flagged `needsModel` (Tier-2 evidence for host synthesis). */
  needsModel: number;
  /** Checker ids that ran (enabled, did not throw). */
  checkersRun: string[];
  /** Checkers that threw — surfaced so a silent checker failure is never mistaken for a clean pass. */
  checkersErrored: { checkerId: string; error: string }[];
  durationMs: number;
  /** Findings grouped by anchor, groups ordered by top severity desc then anchor asc. */
  groups: ReviewReportGroup[];
}

const ZERO_BY_SEVERITY = (): Record<Severity, number> => ({
  info: 0,
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
});

function findingView(f: ReviewFinding): ReviewReportFindingView {
  return {
    checkerId: f.checkerId,
    tier: f.tier,
    severity: f.severity,
    needsModel: f.needsModel,
    title: f.title,
    evidence: f.evidence,
    action: f.action,
    ...(f.anchor.line !== undefined ? { line: f.anchor.line } : {}),
  };
}

/**
 * Fold a raw engine report into the grouped view. Findings arrive pre-sorted by
 * severity desc; grouping preserves that order within each group, and groups are
 * ordered by their top severity (then anchor) so the worst anchor reads first.
 */
export function buildReviewReportView(
  report: ReviewReport,
  scopeLabel: string,
  filesReviewed: number
): ReviewReportView {
  const bySeverity = ZERO_BY_SEVERITY();
  let needsModel = 0;

  // Group by wire-format anchor, preserving the engine's severity-desc order.
  const groupMap = new Map<string, ReviewReportGroup>();
  for (const f of report.findings) {
    bySeverity[f.severity] += 1;
    if (f.needsModel) needsModel += 1;

    const anchor = `${f.anchor.kind}:${f.anchor.value}`;
    let group = groupMap.get(anchor);
    if (!group) {
      group = {
        anchor,
        anchorKind: f.anchor.kind === "f" ? "file" : "entity",
        topSeverity: f.severity,
        findings: [],
      };
      groupMap.set(anchor, group);
    }
    group.findings.push(findingView(f));
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[group.topSeverity]) {
      group.topSeverity = f.severity;
    }
  }

  const groups = [...groupMap.values()].sort((a, b) => {
    const sev = SEVERITY_RANK[b.topSeverity] - SEVERITY_RANK[a.topSeverity];
    return sev !== 0 ? sev : a.anchor.localeCompare(b.anchor);
  });

  return {
    scope: scopeLabel,
    filesReviewed,
    clean: report.clean,
    total: report.findings.length,
    suppressed: report.suppressed,
    bySeverity,
    needsModel,
    checkersRun: report.checkersRun,
    checkersErrored: report.checkersErrored,
    durationMs: report.durationMs,
    groups,
  };
}

/** One-line summary: counts by the severities that are present, worst-first. */
export function summarizeReviewReport(view: ReviewReportView): string {
  if (view.total === 0) {
    const base = `${view.filesReviewed} file${
      view.filesReviewed !== 1 ? "s" : ""
    } reviewed, ${view.checkersRun.length} check${
      view.checkersRun.length !== 1 ? "s" : ""
    } — clean`;
    return view.suppressed > 0
      ? `${base} (${view.suppressed} below floor)`
      : base;
  }
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  const parts = order
    .filter((s) => view.bySeverity[s] > 0)
    .map((s) => `${view.bySeverity[s]} ${s}`);
  const suffix = view.suppressed > 0 ? ` · ${view.suppressed} below floor` : "";
  return `${view.total} finding${
    view.total !== 1 ? "s" : ""
  } (${parts.join(", ")})${suffix}`;
}

/**
 * Plain-text render of the full report (no ANSI). Header + per-anchor groups,
 * each finding as `[severity] checkerId — title`, its evidence (lead line, or
 * all when `verbose`), and the pasteable action. Errored checkers are listed so
 * a silent failure is never mistaken for a clean group.
 */
export function renderReviewReportText(
  view: ReviewReportView,
  opts: { verbose?: boolean } = {}
): string {
  const lines: string[] = [];
  lines.push(`unerr review — ${view.scope}`);
  lines.push(summarizeReviewReport(view));

  for (const group of view.groups) {
    lines.push("");
    lines.push(`${group.anchor}`);
    for (const f of group.findings) {
      const tag = f.needsModel ? "needs-model" : f.severity;
      const where = f.line !== undefined ? `:${f.line}` : "";
      lines.push(`  [${tag}] ${f.checkerId}${where} — ${f.title}`);
      const evidence = opts.verbose ? f.evidence : f.evidence.slice(0, 1);
      for (const e of evidence) lines.push(`      ${e}`);
      lines.push(`      → ${f.action}`);
    }
  }

  if (view.checkersErrored.length > 0) {
    lines.push("");
    lines.push(
      `${view.checkersErrored.length} checker(s) errored (not a clean signal):`
    );
    for (const e of view.checkersErrored) {
      lines.push(`  ${e.checkerId}: ${e.error}`);
    }
  }

  return lines.join("\n");
}
