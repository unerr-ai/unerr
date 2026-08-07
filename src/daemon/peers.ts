/**
 * Decide which registered repos a home repo may federate with for cross-repo
 * intelligence: drop the home repo itself and any repo that opted out. Pure
 * so the filter logic is unit-testable without a live daemon.
 *
 */
import { resolve } from "node:path";
import type { RepoEntry } from "./protocol.js";
import { expandHome } from "./registry.js";

export interface PeerResolveInput {
  /** Absolute-or-tilde path of the requesting repo; excluded from the result. */
  homeRepo: string;
  /** All registered repos (`listRepos()`). */
  repos: RepoEntry[];
}

export type PeerResolveResult = { ok: true; peers: RepoEntry[] };

/**
 * Resolve the federatable peers for a home repo. The caller maps the returned
 * registry entries to wire `PeerEntry` objects (adding repoId + live socket),
 * which keeps this function free of async id derivation.
 *
 */
export function resolveFederatedPeers(
  input: PeerResolveInput
): PeerResolveResult {
  const home = resolve(expandHome(input.homeRepo));
  const peers = input.repos.filter((r) => {
    if (resolve(expandHome(r.path)) === home) return false;
    // Absent federate ⇒ opted in (default true). Only an explicit false excludes.
    if (r.settings?.federate === false) return false;
    return true;
  });

  return { ok: true, peers };
}
