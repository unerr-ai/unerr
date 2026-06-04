/**
 * `architecture_boundary` checker (.internal/reviewer-architecture.md §3 Tier 1 #6, §11 P0.4).
 *
 * Wraps `intelligence/boundary-check.ts:computeBoundaryViolations` — a
 * cross-layer implementation import that compiles fine but couples layers the
 * project keeps apart (e.g. `proxy/bridge.ts` importing `intelligence/`). The
 * engine is path-based: it derives layers from file paths and matches them
 * against declared rules (the DM-0 bridge-isolation invariant by default), so it
 * needs only the changed file's content — no graph, no community map.
 */

import { computeBoundaryViolations } from "../../intelligence/boundary-check.js";
import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";

export class ArchitectureBoundaryChecker implements ReviewChecker {
  readonly id = "architecture_boundary";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "high";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];

    for (const file of ctx.changeSet.files) {
      if (file.kind === "deleted" || !file.newContent) continue;

      const violations = computeBoundaryViolations(file.path, file.newContent);

      for (const v of violations) {
        findings.push({
          checkerId: this.id,
          tier: 1,
          severity: "high",
          anchor: { kind: "f", value: file.path },
          title: `${file.path} imports across a layer boundary: ${v.source_layer} → ${v.target_layer}`,
          evidence: [
            v.import,
            `${v.source_layer} must not import the implementation of ${v.target_layer}`,
          ],
          action: v.suggestion,
          needsModel: false,
        });
      }
    }

    return findings;
  }
}
