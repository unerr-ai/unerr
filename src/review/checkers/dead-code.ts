/**
 * `dead_code` checker (docs/reviewer-architecture.md §3 Tier 1 #10, §11 P0.5).
 *
 * A newly added entity with zero inbound edges that is not exported (so nothing
 * outside the repo can reach it either) — cross-file dead code lint may not flag.
 * Scoped to `added` entities only: an *existing* unused entity is the project's
 * pre-existing state, not something this change introduced (§9 — don't nag about
 * what the author didn't touch). Exported entities are skipped: they are a public
 * surface a caller may live outside the indexed graph. Low severity by design.
 */

import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";
import { resolveChangedEntity } from "./shared.js";

/** Kinds that can be meaningfully dead. Skip types/interfaces (consumed structurally). */
const ELIGIBLE_KINDS = new Set(["function", "method", "class"]);

/** Does the added entity's declaration export it (public surface — caller may be external)? */
function isExported(newBody: string | null): boolean {
  if (!newBody) return false;
  // Inspect the declaration line(s), not the whole body, so an inner `export`
  // in a re-export block doesn't mask a private top-level function.
  const head = newBody.trimStart().slice(0, 200);
  return /^\s*export\b/.test(head) || /\bexport\s+default\b/.test(head);
}

export class DeadCodeChecker implements ReviewChecker {
  readonly id = "dead_code";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "low";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = [];

    for (const change of ctx.changeSet.entities) {
      if (change.kind !== "added") continue;
      if (isExported(change.newBody)) continue; // public surface — caller may be external

      const entity = await resolveChangedEntity(ctx.graph, change);
      if (!entity) continue;
      if (!ELIGIBLE_KINDS.has(entity.kind)) continue;

      const callers = await ctx.graph.getCallersOf(entity.key);
      if (callers.length > 0) continue; // reachable

      findings.push({
        checkerId: this.id,
        tier: 1,
        severity: "low",
        anchor: { kind: "e", value: entity.key, line: entity.start_line },
        title: `${entity.name} is newly added with 0 callers and is not exported — dead code`,
        evidence: [
          `${entity.name} (${entity.file_path}:${entity.start_line}) has 0 inbound edges and no export`,
        ],
        action: `wire a caller for ${entity.name}, export it, or delete it; call get_references({key:'${entity.key}', direction:'callers'}) to confirm 0 inbound edges`,
        needsModel: false,
      });
    }

    return findings;
  }
}
