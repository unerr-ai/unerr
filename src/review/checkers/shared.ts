/**
 * Shared helpers for graph-backed checkers (.internal/reviewer-architecture.md §4.1).
 */

import type { LocalEntity } from "../../intelligence/local-graph.js";
import type { ChangeEntity, ReviewGraph } from "../types.js";

/**
 * Resolve a `ChangeEntity` back to its graph node. Prefers the exact key; falls
 * back to name within the same file (added/renamed entities may carry a synthetic
 * key). Returns `null` when the graph has no matching node — callers must then
 * skip the finding rather than assert callers they can't prove.
 */
export async function resolveChangedEntity(
  graph: ReviewGraph,
  change: ChangeEntity
): Promise<LocalEntity | null> {
  const inFile = await graph.getEntitiesByFile(change.filePath);
  return (
    inFile.find((e) => e.key === change.entityKey) ??
    inFile.find((e) => e.name === change.name) ??
    null
  );
}

/**
 * Concrete, pasteable evidence lines for a callee's callers. Capped so a hot
 * entity can't flood the channel (§9.5). Format: "<file>:<line> <caller> calls <callee>".
 */
export function callerEvidence(
  callers: LocalEntity[],
  calleeName: string,
  cap = 5
): string[] {
  const lines = callers
    .slice(0, cap)
    .map((c) => `${c.file_path}:${c.start_line} ${c.name} calls ${calleeName}`);
  if (callers.length > cap) {
    lines.push(`… +${callers.length - cap} more caller(s)`);
  }
  return lines;
}

/**
 * Structural token multiset of a function body, normalised for shape comparison:
 * strips comments and string/number literals (so renamed literals don't hide a
 * twin), lowercases, and splits on non-identifier chars. Identifier names are
 * KEPT — two functions that share control flow but operate on different domains
 * shouldn't read as duplicates. Used by the duplicate-logic checker.
 */
export function bodyTokens(body: string): string[] {
  const stripped = body
    .replace(/\/\/[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " STR ") // string literals
    .replace(/\b\d+(?:\.\d+)?\b/g, " NUM "); // numeric literals
  return stripped
    .split(/[^a-zA-Z0-9_$]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

/** Jaccard similarity (|∩| / |∪|) over two token multisets, treated as sets. 0 when both empty. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
