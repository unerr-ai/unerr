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
 * ambiguous signal.
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
 * Classify `latest` relative to `current`. Returns `none` unless `latest` is a
 * strictly-newer plain release: a prerelease candidate, a downgrade, an equal
 * version, or any unparseable input all yield `none`.
 */
export function classifyUpdate(current: string, latest: string): ReleaseKind {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return "none";
  // Never chase prereleases automatically — a stable channel only.
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
