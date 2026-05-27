/**
 * Severity gating + dedup for review findings (docs/reviewer-architecture.md §9).
 *
 * False-positive discipline is make-or-break: developers turn off reviewers
 * that cry wolf. Two of §9's defenses live here:
 *  - §9.2 Severity gating — each surface has a floor; below floor → suppressed
 *    (counted, not silently dropped). Mirrors `guard-formatter.ts:shouldFireGuard`.
 *  - §9.4 Dedup — collapse identical findings so the same fact never shows twice
 *    in one pass. (Cross-SURFACE dedup at emit time is P1's job via
 *    `hooks/hook-dedup.ts:shouldEmitOnce`; this is the within-pass collapse.)
 */

import { type ReviewFinding, SEVERITY_RANK, type Severity } from "./types.js";

/** True when `severity` is at or above the `floor`. */
export function meetsFloor(severity: Severity, floor: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

/** Stable identity of a finding for within-pass dedup: same checker + anchor + title. */
function findingKey(f: ReviewFinding): string {
  const line = f.anchor.line != null ? `:${f.anchor.line}` : "";
  return `${f.checkerId}|${f.anchor.kind}:${f.anchor.value}${line}|${f.title}`;
}

/**
 * Collapse identical findings. On collision keep the higher-severity copy and
 * union the evidence lines (deduped, order-preserving). First occurrence wins
 * for non-evidence fields when severities tie.
 */
export function dedupFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding>();
  for (const f of findings) {
    const key = findingKey(f);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f, evidence: [...f.evidence] });
      continue;
    }
    const mergedEvidence = [...existing.evidence];
    for (const line of f.evidence) {
      if (!mergedEvidence.includes(line)) mergedEvidence.push(line);
    }
    const keepNew =
      SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity];
    const base = keepNew ? f : existing;
    byKey.set(key, { ...base, evidence: mergedEvidence });
  }
  return [...byKey.values()];
}

/** Sort findings by severity descending, then by checker id for stable output. */
export function sortBySeverity(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.checkerId.localeCompare(b.checkerId);
  });
}

export interface GateResult {
  /** Findings at or above the floor, deduped, sorted by severity descending. */
  kept: ReviewFinding[];
  /** Count of findings dropped by the floor. */
  suppressed: number;
}

/**
 * Apply §9 gating to raw checker output: dedup → floor → sort. `suppressed`
 * counts what the floor removed so a surface can say "N findings hidden".
 */
export function gateFindings(
  findings: ReviewFinding[],
  floor: Severity
): GateResult {
  const deduped = dedupFindings(findings);
  const kept: ReviewFinding[] = [];
  let suppressed = 0;
  for (const f of deduped) {
    if (meetsFloor(f.severity, floor)) kept.push(f);
    else suppressed++;
  }
  return { kept: sortBySeverity(kept), suppressed };
}
