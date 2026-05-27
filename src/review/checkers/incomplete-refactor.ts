/**
 * `incomplete_refactor` checker (docs/reviewer-architecture.md §3 Tier 1 #3, §11 P0.4).
 *
 * Wraps `intelligence/edit-impact.ts:reconcileIncompleteCallers` — a signature
 * change applied in some call sites but not all. Distinct from `breaking_callers`
 * (which flags every mismatched caller of one edited entity): this reconciles the
 * *whole change set* and flags only callers in files the session never touched —
 * the ones you forgot. Builds the file-level edit records from `ChangeFile`
 * content and runs them through the shared blast-radius engine. `ReviewGraph`
 * satisfies `EditImpactGraph` structurally (same getEntitiesByFile/getCallersOf).
 */

import {
  type IncompleteCaller,
  type RecordedEdit,
  reconcileIncompleteCallers,
} from "../../intelligence/edit-impact.js";
import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";

export class IncompleteRefactorChecker implements ReviewChecker {
  readonly id = "incomplete_refactor";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "high";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const events: RecordedEdit[] = ctx.changeSet.files.map((f) => ({
      file_path: f.path,
      old_content: f.oldContent,
      new_content: f.newContent,
    }));
    if (events.length === 0) return [];

    const incomplete = await reconcileIncompleteCallers(events, ctx.graph);
    if (incomplete.length === 0) return [];

    // One finding per changed entity, listing the callers left un-updated.
    // Group by the 16-hex graph key (stable, unique) so the emitted
    // get_references action carries a pasteable key — never the entity's
    // multi-line signature. The bare name rides along for display.
    const byEntity = new Map<
      string,
      { name: string; callers: IncompleteCaller[] }
    >();
    for (const c of incomplete) {
      const group = byEntity.get(c.changed_entity_key) ?? {
        name: c.changed_entity,
        callers: [],
      };
      group.callers.push(c);
      byEntity.set(c.changed_entity_key, group);
    }

    const findings: ReviewFinding[] = [];
    for (const [entityKey, { name, callers }] of byEntity) {
      const remaining = callers.map(
        (c) => `${c.caller_file}:${c.caller_entity}`
      );
      const nonTest = callers.filter((c) => !c.is_test).length;
      const changeType = callers[0]?.change_type ?? "signature_modified";

      findings.push({
        checkerId: this.id,
        tier: 1,
        severity: "high",
        anchor: { kind: "e", value: entityKey },
        title: `${changeType} on ${name} reached ${remaining.length} caller(s) in un-edited files (${nonTest} non-test) — refactor is incomplete`,
        evidence: remaining,
        action: `call get_references({key:'${entityKey}', direction:'callers'}) on ${name}; update ${remaining.length} un-edited caller(s): ${remaining.join(", ")}`,
        needsModel: false,
        tokensPrevented: remaining.length * 200,
      });
    }

    return findings;
  }
}
