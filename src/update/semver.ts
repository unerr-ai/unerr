/**
 * Minimal semver parse + compare, scoped to exactly what auto-update needs:
 * classify a candidate version against the running one as patch / minor / major
 * (the semver safety boundary — same-major is auto-eligible, major is notify-
 * only). We do NOT need range matching (`^`, `~`, `>=`), so we deliberately
 * avoid pulling in the full `semver` package — a parse + a three-field compare
 * is the whole job, and a smaller surface is easier to reason about.
 *
 * Conservative by construction: anything unparseable, a downgrade, or a
 * prerelease candidate classifies as `none` so auto-update never acts on an
 * ambiguous signal. With `opts.allowPrerelease` the beta channel can upgrade
 * beta→beta and beta→stable using full semver §11 prerelease precedence.
 */

/** A parsed `MAJOR.MINOR.PATCH` with an optional prerelease tag. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** The `-rc.1` style suffix, or null for a plain release. */
  prerelease: string | null;
}

/**
 * How a candidate version relates to the current one. `none` covers equal,
 * older, unparseable, and prerelease candidates — every case auto-update must
 * NOT act on. `major` is the notify-only boundary.
 */
export type ReleaseKind = "none" | "patch" | "minor" | "major";

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version string, or null when it isn't a clean semver. */
export function parseSemver(version: string): SemVer | null {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** Compare release precedence ignoring prerelease tags: -1 / 0 / 1. */
export function compareCore(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Compare prerelease identifiers per semver.org §11: null (no prerelease) has
 * higher precedence than any prerelease string. Both null → 0. Both present:
 * split on ".", compare left-to-right; purely numeric identifiers compare
 * numerically and sort LOWER than alphanumeric; a longer list wins if all
 * prior identifiers are equal.
 */
export function comparePrerelease(
  a: string | null,
  b: string | null
): -1 | 0 | 1 {
  if (a === null && b === null) return 0;
  // null (stable) has higher precedence than any prerelease
  if (a === null) return 1;
  if (b === null) return -1;

  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    // shorter list is lower precedence (per semver §11.4.4)
    if (i >= aParts.length) return -1;
    if (i >= bParts.length) return 1;

    const ai = aParts[i]!;
    const bi = bParts[i]!;
    const aNum = /^\d+$/.test(ai) ? Number(ai) : null;
    const bNum = /^\d+$/.test(bi) ? Number(bi) : null;

    if (aNum !== null && bNum !== null) {
      // both numeric: compare numerically
      if (aNum !== bNum) return aNum < bNum ? -1 : 1;
    } else if (aNum !== null) {
      // numeric < alphanumeric
      return -1;
    } else if (bNum !== null) {
      // alphanumeric > numeric
      return 1;
    } else {
      // both alphanumeric: lexicographic
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Full semver comparison per §11: compare core (major.minor.patch) first, then
 * break ties with comparePrerelease. Returns -1 / 0 / 1.
 */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  const core = compareCore(a, b);
  if (core !== 0) return core;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Classify `latest` relative to `current`. Returns `none` unless `latest` is a
 * strictly-newer version. By default (stable channel) a prerelease `latest`
 * returns `none`. With `opts.allowPrerelease` the beta channel accepts
 * prerelease-to-prerelease and prerelease-to-stable upgrades; when the core
 * versions match but the prerelease advances, returns `patch` (smallest,
 * auto-eligible).
 */
export function classifyUpdate(
  current: string,
  latest: string,
  opts?: { allowPrerelease?: boolean }
): ReleaseKind {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return "none";

  if (opts?.allowPrerelease) {
    // Beta channel: full semver comparison including prerelease
    if (compareSemver(next, cur) <= 0) return "none";
    const coreDiff = compareCore(next, cur);
    if (coreDiff > 0) {
      if (next.major > cur.major) return "major";
      if (next.minor > cur.minor) return "minor";
      return "patch";
    }
    // Core equal, prerelease advanced (e.g. beta.1→beta.2, or beta.1→stable)
    return "patch";
  }

  // Stable channel (default): never chase prereleases
  if (next.prerelease) return "none";
  if (compareCore(next, cur) <= 0) return "none";
  if (next.major > cur.major) return "major";
  if (next.minor > cur.minor) return "minor";
  return "patch";
}

/** True when `latest` is a strictly-newer plain release than `current`. */
export function isNewerStable(current: string, latest: string): boolean {
  return classifyUpdate(current, latest) !== "none";
}
