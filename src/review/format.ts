/**
 * Render `ReviewFinding`s into agent-facing `ur|<tag>` lines (.internal/reviewer-architecture.md §4 L3).
 *
 * Shared by every surface that injects findings into agent context (the in-flight
 * post-edit hook today; the on-demand command later) so a finding reads identically
 * wherever it fires. Mapping follows the `ur|<tag>` legend in CLAUDE.md:
 *   - deterministic high/critical finding → `ur|rsk` (caution on this path)
 *   - deterministic medium/low/info finding → `ur|fct` (information for context)
 *   - `needsModel` (Tier-2 evidence) → `ur|fct` (evidence for the host model, not a verdict)
 *
 * Each line is the finding's own pasteable `action`, prefixed by its `title` so the
 * agent sees both the fact and the next step — obeying the nudge rules (imperative,
 * named tool, real numbers, no deictic pronouns) the findings were built to satisfy.
 *
 * Tier-2 (`needsModel`) findings are deliberately EXCLUDED from this verdict
 * block — they are routed separately as evidence blocks for the host model to
 * elaborate on (`review/synthesis.ts`), never rendered as a unerr verdict (§9.3).
 */

import { type ReviewFinding, SEVERITY_RANK } from "./types.js";

/** Map a finding to its wire tag: high/critical risk → `rsk`, everything else → `fct`. */
export function findingTag(finding: ReviewFinding): "rsk" | "fct" {
  if (finding.needsModel) return "fct";
  return SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.high ? "rsk" : "fct";
}

/** One `ur|<tag> <title> → <action>` line for a single finding. */
export function formatFindingLine(finding: ReviewFinding): string {
  return `ur|${findingTag(finding)} ${finding.title} → ${finding.action}`;
}

/**
 * Render a full set of findings into a multi-line block, most-severe first
 * (findings arrive pre-sorted from the engine). Capped so a sweeping edit can't
 * flood the channel (§9.5); the overflow is summarised, not dropped silently.
 * `suppressed` (findings below the floor) is appended as a one-line tail so the
 * agent knows lower-severity items exist without reading them. Returns `""` when
 * there is nothing to surface — the caller then emits no review nudge at all.
 */
export function formatReviewFindings(
  findings: ReviewFinding[],
  suppressed = 0,
  cap = 5
): string {
  // Tier-1 verdicts only; Tier-2 (needsModel) is routed via synthesis.ts (§9.3).
  const verdicts = findings.filter((f) => !f.needsModel);
  if (verdicts.length === 0) return "";

  const lines = verdicts.slice(0, cap).map(formatFindingLine);
  if (verdicts.length > cap) {
    lines.push(`ur|fct +${verdicts.length - cap} more review finding(s)`);
  }
  if (suppressed > 0) {
    lines.push(
      `ur|fct +${suppressed} lower-severity finding(s) below the in-flight floor — run \`unerr review\` to see all`
    );
  }
  return lines.join("\n");
}
