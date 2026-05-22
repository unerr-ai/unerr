/**
 * `notes` family registration — Active-cognition Layer B MCP surface.
 *
 * Both consolidated tools (`unerr_recall_notes`, `unerr_remember`) belong
 * to a single MCP family. The family is **always-on (Tier 1)** — the
 * four-moment contract requires these tools available from turn 1, before
 * intent scoring has any signal to score.
 *
 * Wire-in points (proxy / dispatcher):
 *   - Pass NOTES_FAMILY_NAME into the always-on set when constructing
 *     `FamilyMaskEngine` (see src/router/family-mask.ts:51).
 *   - Add NOTES_FAMILY_TOOLS to `LOCAL_TOOLS` in
 *     src/intelligence/query-router.ts so the router dispatches them.
 *   - Add NOTES_FAMILY_LABEL to `FAMILY_LABELS` in
 *     src/router/family-nudge.ts so unmask nudges render the right name.
 *
 * See ACTIVE_COGNITION_REASON_LAYER.md §6.2.
 */

export const NOTES_FAMILY_NAME = "notes" as const;

export const NOTES_FAMILY_LABEL = "Active-cognition notes" as const;

export const NOTES_FAMILY_TOOLS: readonly string[] = [
  "unerr_recall_notes",
  "unerr_remember", // overloaded by `type` field; the legacy free-form path becomes one of its sub-handlers
] as const;

/** Single-call helper for callers that just need the always-on set extended. */
export function withNotesAlwaysOn(
  existingAlwaysOn: ReadonlySet<string>,
): Set<string> {
  return new Set([...existingAlwaysOn, NOTES_FAMILY_NAME]);
}

/** Single-call helper for callers that need the known-families set extended. */
export function withNotesKnown(
  existingKnown: ReadonlySet<string>,
): Set<string> {
  return new Set([...existingKnown, NOTES_FAMILY_NAME]);
}
