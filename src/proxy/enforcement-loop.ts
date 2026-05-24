/**
 * Fact-steering preface (formerly Surface 4d) — File-touch enforcement loop.
 *
 * When the agent touches a file (read, edit, write), surface every
 * persistent fact that applies to that file as a high-priority signal.
 * The agent already gets facts injected through `file_read`, but
 * user_fed facts can carry an `applies_to` list of paths/entities that
 * the recall path's `scope` column does not match exactly (e.g., the
 * user says "always X in src/foo/*"). This module bridges the gap:
 * it takes a file path and a candidate fact list, then filters those
 * whose `applies_to` overlap.
 *
 * Pure module. No IO. Test-friendly. The proxy injects the result into
 * its `ur|fct` prefix builder; the dashboard's logbook uses it to
 * render the enforcement column.
 */

import type { TemporalFact } from "../intelligence/temporal-facts.js";
import type { EvidenceEntry } from "../intelligence/temporal-facts.js";

/** A path matches if it's an exact match OR if `applies_to` entry is a
 *  directory prefix the file lives under. */
function pathMatches(filePath: string, target: string): boolean {
  if (filePath === target) return true;
  if (target.endsWith("/")) return filePath.startsWith(target);
  if (filePath.startsWith(`${target}/`)) return true;
  // Glob suffix support: "src/foo/*" → starts-with "src/foo/" and no further "/".
  if (target.endsWith("/*")) {
    const dir = target.slice(0, -1);
    if (!filePath.startsWith(dir)) return false;
    return !filePath.slice(dir.length).includes("/");
  }
  // Recursive glob: "src/foo/**" → starts-with "src/foo/".
  if (target.endsWith("/**")) {
    const dir = target.slice(0, -2);
    return filePath.startsWith(dir);
  }
  return false;
}

/** Pull `applies_to` from a fact's evidence list (Phase 2 carries it
 *  on the first EvidenceEntry of user_fed facts). Returns the merged
 *  set across all evidence entries — multiple reinforcements may have
 *  expanded the set. */
export function appliesToFor(evidence: readonly EvidenceEntry[]): string[] {
  const out = new Set<string>();
  for (const e of evidence) {
    if (Array.isArray(e.applies_to)) {
      for (const target of e.applies_to) {
        if (typeof target === "string" && target.length > 0) out.add(target);
      }
    }
  }
  return [...out];
}

export interface EnforcementCandidate {
  fact: TemporalFact;
  applies_to: readonly string[];
}

/**
 * Filter `candidates` to those whose `applies_to` matches `filePath`.
 * The `scope` column is ignored here — the caller already filtered by
 * scope when calling `recallByScope`. This function only adds the
 * cross-scope matches that `applies_to` opens up.
 */
export function factsApplyingTo(
  filePath: string,
  candidates: readonly EnforcementCandidate[]
): TemporalFact[] {
  const hits: TemporalFact[] = [];
  for (const c of candidates) {
    if (c.applies_to.length === 0) continue;
    if (c.applies_to.some((t) => pathMatches(filePath, t))) {
      hits.push(c.fact);
    }
  }
  return hits;
}

/**
 * Compose a `ur|fct` prefix line for an enforced fact. The verb in the
 * line names *what the agent must do*: respect a procedural rule, avoid
 * a negative pattern, follow a convention. Caller stamps tag-only.
 */
export function renderEnforcedFactPrefix(fact: TemporalFact): string {
  const subtype =
    fact.fact_type === "negative"
      ? "[negative]"
      : fact.fact_type === "procedural"
        ? "[procedural]"
        : fact.fact_type === "convention"
          ? "[convention]"
          : "[semantic]";
  const action =
    fact.fact_type === "negative"
      ? `avoid: ${fact.content}`
      : `follow: ${fact.content}`;
  return `ur|fct ${subtype} ${action}`;
}
