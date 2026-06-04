/**
 * `memory_drift` checker (.internal/reviewer-architecture.md §3 Tier 1 #8, §11 P0.4).
 *
 * Code↔memory drift: an entity changed under an active `dec` (decision) or `rul`
 * (rule) note, without that decision being reconsidered. unerr's anchored-notes
 * layer is the live home for this signal (the heavy `drift-tracker.ts:processFile`
 * is overlay maintenance, not a review primitive) — so the checker reads notes
 * for the changed entity/file anchors via the narrow `ReviewNotes` surface and
 * surfaces any governing decision so the agent confirms the change still honors
 * it. Detection is deterministic (changed + note exists); the contradiction
 * judgment is the agent's, but the action is concrete, so `needsModel` stays false.
 */

import type { ReviewChecker } from "../checker.js";
import type {
  ReviewContext,
  ReviewFinding,
  ReviewNote,
  Severity,
} from "../types.js";

/** Note kinds that record a deliberate decision worth reconsidering on change. */
const GOVERNING_KINDS = new Set(["dec", "rul"]);

export class MemoryDriftChecker implements ReviewChecker {
  readonly id = "memory_drift";
  readonly tier = 1 as const;
  readonly defaultSeverity: Severity = "medium";

  async check(ctx: ReviewContext): Promise<ReviewFinding[]> {
    const notes = ctx.notes;
    if (!notes) return []; // no notes layer wired for this pass

    const findings: ReviewFinding[] = [];
    // Dedup: one note may anchor both the entity and its file.
    const seen = new Set<string>();

    for (const change of ctx.changeSet.entities) {
      if (change.kind === "added") continue; // a decision can't pre-govern brand-new code

      const anchored = await notes.forAnchors([
        `e:${change.entityKey}`,
        `f:${change.filePath}`,
      ]);
      const governing = anchored.filter((n: ReviewNote) =>
        GOVERNING_KINDS.has(n.kind)
      );

      for (const note of governing) {
        const dedupKey = `${change.entityKey}|${note.kind}|${note.anchor}|${note.content}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        findings.push({
          checkerId: this.id,
          tier: 1,
          severity: "medium",
          anchor: { kind: "e", value: change.entityKey, line: change.line },
          title: `${change.name} changed under a recorded ${note.kind} note on ${note.anchor} — reconsider the decision`,
          evidence: [
            `${note.kind}|${note.anchor}|${note.polarity}|${note.content}`,
          ],
          action: `re-read the ${note.kind} note on ${note.anchor}; confirm the change to ${change.name} still honors it, else emit unerr-save: note ${note.kind}|${note.anchor}|~|<updated decision> in your closing message to supersede it`,
          needsModel: false,
        });
      }
    }

    return findings;
  }
}
