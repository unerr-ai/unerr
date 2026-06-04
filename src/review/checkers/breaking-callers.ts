/**
 * `breaking_callers` checker (.internal/reviewer-architecture.md §3 Tier 1, §11 P0.3).
 *
 * Asserts a graph FACT, not an opinion: a changed (or deleted) export whose
 * depth-1 callers now mismatch. Wraps the signature-change primitive already in
 * `intelligence/edit-impact.ts` (`detectSignatureChange`) — the engine unifies,
 * it does not reinvent. This is the highest-value Tier-1 check: build + lint pass
 * while every caller silently breaks.
 */

import {
  detectSignatureChange,
  isTestFilePath,
} from "../../intelligence/edit-impact.js";
import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";
import { callerEvidence, resolveChangedEntity } from "./shared.js";

/** Below this caller count a signature change is low-risk; don't cry wolf (§9). */
const MIN_CALLERS_TO_WARN = 2;
/** At or above this caller count a contract change is critical, not merely high. */
const CRITICAL_CALLER_COUNT = 20;

export class BreakingCallersChecker implements ReviewChecker {
  readonly id = "breaking_callers";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "high";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];

    for (const change of ctx.changeSet.entities) {
      if (change.kind === "added") continue; // nothing calls it yet

      const entity = await resolveChangedEntity(ctx.graph, change);
      if (!entity) continue; // can't prove callers → don't assert

      const callers = await ctx.graph.getCallersOf(entity.key);
      if (callers.length === 0) continue;

      if (change.kind === "deleted") {
        findings.push({
          checkerId: this.id,
          tier: 1,
          severity: "critical",
          anchor: { kind: "e", value: entity.key, line: entity.start_line },
          title: `deleting ${entity.name} leaves ${callers.length} caller(s) referencing a missing entity`,
          evidence: callerEvidence(callers, entity.name),
          action: `restore ${entity.name} or update ${callers.length} caller(s): call get_references({key:'${entity.key}', direction:'callers'})`,
          needsModel: false,
          tokensPrevented: callers.length * 200,
        });
        continue;
      }

      // kind === "modified"
      const changeType = detectSignatureChange(
        entity,
        change.oldBody,
        change.newBody
      );
      if (!changeType) continue;

      const nonTestCallers = callers.filter(
        (c) => !isTestFilePath(c.file_path)
      );
      if (callers.length < MIN_CALLERS_TO_WARN) continue;

      const severity: Severity =
        callers.length >= CRITICAL_CALLER_COUNT ? "critical" : "high";

      findings.push({
        checkerId: this.id,
        tier: 1,
        severity,
        anchor: { kind: "e", value: entity.key, line: entity.start_line },
        title: `${changeType} on ${entity.name} — ${callers.length} caller(s) now mismatch (${nonTestCallers.length} non-test)`,
        evidence: callerEvidence(callers, entity.name),
        action: `call get_references({key:'${entity.key}', direction:'callers'}) on ${entity.name}; update all ${callers.length} call site(s) before commit`,
        needsModel: false,
        tokensPrevented: callers.length * 200,
      });
    }

    return findings;
  }
}
