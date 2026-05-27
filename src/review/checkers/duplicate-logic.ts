/**
 * `duplicate_logic` checker (docs/reviewer-architecture.md §3 Tier 1 #5, §11 P0.5).
 *
 * A newly added entity that duplicates an existing utility — a DRY breach across
 * files that lint never sees (it only ever looks at one file). The narrow
 * `ReviewSearch` surface supplies name-token candidates with their bodies;
 * THIS checker owns the duplicate judgment: it compares normalised body-token
 * shapes (`bodyTokens` + `jaccardSimilarity`) and fires only above a high
 * similarity floor, so a coincidental name collision never reads as a twin (§9).
 */

import type { ReviewChecker } from "../checker.js";
import type { ReviewContext, ReviewFinding, Severity } from "../types.js";
import { bodyTokens, jaccardSimilarity } from "./shared.js";

/** Bodies below this token count are too trivial to call a meaningful duplicate. */
const MIN_BODY_TOKENS = 12;
/** Shape similarity at or above this is a near-certain copy (DRY breach). */
const DUPLICATE_THRESHOLD = 0.8;
/** Candidate fan-out per added entity — name-token search is the pre-filter. */
const CANDIDATE_LIMIT = 10;

export class DuplicateLogicChecker implements ReviewChecker {
  readonly id = "duplicate_logic";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "medium";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const search = ctx.search;
    if (!search) return []; // no search index wired for this pass

    const findings: ReviewFinding[] = [];

    for (const change of ctx.changeSet.entities) {
      if (change.kind !== "added" || !change.newBody) continue;

      const tokens = bodyTokens(change.newBody);
      if (tokens.length < MIN_BODY_TOKENS) continue; // too trivial to judge

      const candidates = await search.candidatesFor(
        { name: change.name, body: change.newBody },
        CANDIDATE_LIMIT
      );

      let best: { filePath: string; name: string; score: number } | null = null;
      for (const c of candidates) {
        if (c.filePath === change.filePath && c.name === change.name) continue; // itself
        const score = jaccardSimilarity(tokens, bodyTokens(c.body));
        if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) {
          best = { filePath: c.filePath, name: c.name, score };
        }
      }
      if (!best) continue;

      const pct = Math.round(best.score * 100);
      findings.push({
        checkerId: this.id,
        tier: 1,
        severity: "medium",
        anchor: { kind: "e", value: change.entityKey, line: change.line },
        title: `${change.name} is ${pct}% identical to existing ${best.name} (${best.filePath}) — likely duplicate logic`,
        evidence: [
          `${change.name} (${change.filePath}) shares ${pct}% of its body shape with ${best.name} (${best.filePath})`,
        ],
        action: `call get_entity({name:'${best.name}'}); reuse ${best.name} from ${best.filePath} instead of duplicating it`,
        needsModel: false,
      });
    }

    return findings;
  }
}
