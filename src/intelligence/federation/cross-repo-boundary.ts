/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.4: flag a new import that reaches into a
 * federated sibling repo's INTERNALS instead of its published entry point. The
 * intra-repo boundary check (`computeBoundaryViolations`) only inspects relative
 * imports; a cross-repo coupling is a BARE specifier (`svc/src/db.ts`) into a
 * peer package. Importing the package root (`svc`) is the public contract and is
 * fine — reaching past it into `src/`, `dist/`, `internal/`, or `lib/` couples
 * the home repo to a sibling's implementation, the cross-repo analogue of an
 * architecture-boundary breach.
 *
 * Output is shaped as a {@link BoundaryViolation} so cross-repo breaches reuse
 * the existing pre-edit boundary nudge and `boundary_violation_flagged`
 * telemetry — no new wire field or event type.
 *
 */

import type { BoundaryViolation } from "../boundary-check.js";

/** Subpath segments that unambiguously reach past a package's public entry. */
const INTERNAL_SEGMENTS = ["src", "dist", "internal", "lib"];

/**
 * Resolve a bare import specifier to its package name, or null when it is
 * relative, absolute, a Node builtin (`node:`), or empty. Handles scoped
 * packages: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`.
 */
function packageOfSpecifier(
  specifier: string
): { pkg: string; subpath: string } | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return null; // malformed scope
    const pkg = `${parts[0]}/${parts[1]}`;
    return { pkg, subpath: parts.slice(2).join("/") };
  }
  return { pkg: parts[0] ?? "", subpath: parts.slice(1).join("/") };
}

/** A bare-specifier import reaches a sibling's internals when its subpath leads
 *  with one of {@link INTERNAL_SEGMENTS}. The bare package root has no subpath. */
function reachesInternals(subpath: string): boolean {
  if (!subpath) return false; // package root = public entry, allowed
  const first = subpath.split("/")[0];
  return first !== undefined && INTERNAL_SEGMENTS.includes(first);
}

/**
 * Scan `newContent` for bare imports that reach into a federated peer package's
 * internals and return one {@link BoundaryViolation} per breach. `peerPackages`
 * is the live set of federated sibling package names (from the drift sweep's
 * fan-out); a deep import into a package NOT in that set is third-party and left
 * alone. Empty result when there's no content or no known peers — the check
 * degrades to a no-op, consistent with the rest of the federation being advisory.
 */
export function detectCrossRepoImportBreaches(
  sourceFile: string,
  newContent: string | null,
  peerPackages: ReadonlySet<string>
): BoundaryViolation[] {
  if (!newContent || peerPackages.size === 0) return [];

  const breaches: BoundaryViolation[] = [];
  for (const line of newContent.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(
      /^import\s+(?:type\s+)?(?:\{[^}]*\}|[^'"]+)\s+from\s+['"]([^'"]+)['"]/
    );
    if (!match) continue;
    const specifier = match[1];
    if (!specifier) continue;

    const parsed = packageOfSpecifier(specifier);
    if (!parsed || !peerPackages.has(parsed.pkg)) continue;
    if (!reachesInternals(parsed.subpath)) continue;

    breaches.push({
      import: trimmed,
      specifier,
      source_file: sourceFile,
      source_layer: "cross-repo",
      target_layer: `${parsed.pkg} (peer repo internals)`,
      suggestion: `import from the '${parsed.pkg}' package entry point, not its internals at '${specifier}' — a sibling repo's internal layout is not its contract and can change without notice.`,
    });
  }
  return breaches;
}
