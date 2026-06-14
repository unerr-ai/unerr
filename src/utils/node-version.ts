/**
 * Node version policy — single source of truth.
 *
 * unerr RUNS on Node >= MIN_NODE_VERSION (the hard floor, mirrored in
 * package.json `engines.node`). It RECOMMENDS Node >= RECOMMENDED_NODE_VERSION
 * for best performance and so the built-in `node:sqlite` path is available.
 *
 * The two values are intentionally different: `engines` can only express one
 * range, so it stays at the honest floor (Node 20 installs cleanly, no
 * "unsupported" warning). The recommendation is surfaced as a custom,
 * non-blocking notice at runtime (proxy startup) and in `unerr doctor` — a
 * channel that survives npm v12 / pnpm install-script lockdown, unlike a
 * postinstall script.
 */

/** Hard floor — below this unerr will not run. Mirrors package.json engines.node. */
export const MIN_NODE_VERSION = "20.9.0";

/** Recommended floor — at/above this is the supported-best experience. */
export const RECOMMENDED_NODE_VERSION = "22.5.0";

/**
 * Compare two dotted semver-ish strings (e.g. "20.9.0"). Pre-release/build
 * suffixes are ignored. Returns -1 if a < b, 1 if a > b, 0 if equal.
 */
export function compareNodeVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const core = v.replace(/^v/, "").split("-")[0] ?? "";
    return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** True if `version` (default: the running Node) meets the recommended floor. */
export function meetsRecommendedNode(
  version: string = process.versions.node
): boolean {
  return compareNodeVersions(version, RECOMMENDED_NODE_VERSION) >= 0;
}

/** True if `version` (default: the running Node) meets the hard minimum. */
export function meetsMinimumNode(
  version: string = process.versions.node
): boolean {
  return compareNodeVersions(version, MIN_NODE_VERSION) >= 0;
}

/**
 * One-line recommendation shown when running below the recommended floor.
 * Returns null when the running Node already meets the recommendation, so
 * callers can skip emitting anything.
 */
export function nodeUpgradeNotice(
  version: string = process.versions.node
): string | null {
  if (meetsRecommendedNode(version)) return null;
  return `Node v${version} detected — unerr runs on Node ≥${MIN_NODE_VERSION}, but Node ≥${RECOMMENDED_NODE_VERSION} is recommended. Upgrade: nvm install 22`;
}
