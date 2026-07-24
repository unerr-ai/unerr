/**
 * Resolve which repo owns a filesystem path: the home repo when the path sits
 * under its root, otherwise the federated peer whose root is the longest prefix
 * of the path. Drives implicit cross-repo routing — when an agent references a
 * file that lives in a sibling repo, the call is sent to that repo's proxy
 * instead of failing against the home graph. Pure and path-only (no I/O) so the
 * match logic is unit-testable without a live filesystem or daemon.
 *
 */
import { resolve, sep } from "node:path";

/** Minimal repo descriptor the resolver matches against (a `PeerEntry` fits). */
export interface OwningRepoCandidate {
  repoId: string;
  label: string;
  path: string;
}

export type OwningRepoResolution =
  | { owner: "home" }
  | { owner: "peer"; peer: OwningRepoCandidate }
  | { owner: "unknown" };

/** True when `child` is `parent` itself or nested under it (boundary-safe). */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Decide who owns `filePath`. Home wins when the path is under the home root.
 * Otherwise the peer with the longest matching root prefix wins (so a nested
 * repo beats its ancestor). Returns `unknown` when no root contains the path —
 * the caller then lazy-adds it (scenario 1: on disk, not yet registered) or
 * falls back to home.
 *
 */
export function resolveOwningRepo(
  filePath: string,
  homeRoot: string,
  peers: OwningRepoCandidate[]
): OwningRepoResolution {
  // Relative paths are always home-relative by definition — no peer can own one.
  const abs = resolve(filePath);
  const home = resolve(homeRoot);

  let best: { peer: OwningRepoCandidate; rootLen: number } | null = null;
  for (const peer of peers) {
    const root = resolve(peer.path);
    if (!isUnder(abs, root)) continue;
    if (!best || root.length > best.rootLen) {
      best = { peer, rootLen: root.length };
    }
  }

  // A peer root nested under the home root (or vice versa) is possible; the
  // longer prefix is the true owner. Compare the best peer match to home.
  const homeOwns = isUnder(abs, home);
  if (homeOwns && (!best || home.length >= best.rootLen)) {
    return { owner: "home" };
  }
  if (best) return { owner: "peer", peer: best.peer };
  return { owner: "unknown" };
}
