/**
 * `blast_radius` checker (.internal/reviewer-architecture.md §3 Tier 1, §11 P0.3).
 *
 * Fires when an edit touches a high-fan-in chokepoint — even without a signature
 * change — so the agent proposes a non-breaking shape before editing. Distinct
 * from `breaking_callers` (which fires only on an actual contract change): a
 * chokepoint edit is risky regardless. Uses the precomputed `fan_in` column
 * (depth-1 is sufficient — CLAUDE.md Datalog rules; no recursion needed), floored
 * by the live caller count so a stale `fan_in` never hides a hot entity.
 */

import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";
import { callerEvidence, resolveChangedEntity } from "./shared.js";

/** At or above this caller count, editing the entity is high-risk. */
const HIGH_FAN_IN = 20;
/** Between this and HIGH_FAN_IN, medium-risk; below it, not worth a finding. */
const MEDIUM_FAN_IN = 6;

export class BlastRadiusChecker implements ReviewChecker {
  readonly id = "blast_radius";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "medium";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];

    for (const change of ctx.changeSet.entities) {
      if (change.kind === "added") continue; // a new entity has no inbound fan-in

      const entity = await resolveChangedEntity(ctx.graph, change);
      if (!entity) continue;

      const callers = await ctx.graph.getCallersOf(entity.key);
      // Live count floors the precomputed column so a stale fan_in can't hide a chokepoint.
      const fanIn = Math.max(entity.fan_in, callers.length);
      if (fanIn < MEDIUM_FAN_IN) continue;

      const severity: Severity = fanIn >= HIGH_FAN_IN ? "high" : "medium";

      findings.push({
        checkerId: this.id,
        tier: 1,
        severity,
        anchor: { kind: "e", value: entity.key, line: entity.start_line },
        title: `${entity.name} is a chokepoint — ${fanIn} caller(s) depend on it`,
        evidence: [
          `${entity.name} fan_in=${fanIn} (depth-1, precomputed)`,
          ...callerEvidence(callers, entity.name, 3),
        ],
        action: `call get_references({key:'${entity.key}', direction:'callers'}) on ${entity.name}; propose a non-breaking change (additive overload / deprecation shim) before editing`,
        needsModel: false,
      });
    }

    return findings;
  }
}
