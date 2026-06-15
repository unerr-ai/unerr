/**
 * Decide which registered repos a home repo may federate with for cross-repo
 * intelligence: enforce the pro/enterprise gate, then drop the home repo itself
 * and any repo that opted out. Pure and cloud-free so the daemon's tier check
 * stays injectable and the filter logic is unit-testable without a live daemon.
 *
 * @sem domain=process-manager
 */
import { resolve } from "node:path";
import type { RepoEntry } from "./protocol.js";
import { expandHome } from "./registry.js";

/**
 * Shown when a free-tier account asks for workspace scope. Imperative, names
 * the upgrade path — follows the nudge-writing rules in CLAUDE.md.
 */
export const WORKSPACE_PRO_ONLY_MESSAGE =
  "Cross-repo (workspace) intelligence is a Pro feature. " +
  "Upgrade to Pro to query across all your repos: run `unerr login`. " +
  "Free tier stays single-repo.";

export interface PeerResolveInput {
  /** Absolute-or-tilde path of the requesting repo; excluded from the result. */
  homeRepo: string;
  /** All registered repos (`listRepos()`). */
  repos: RepoEntry[];
  /**
   * Whether the active plan grants unlimited repos (pro/enterprise). Injected by
   * the caller as `isUnlimited(repoLimit(tier))` so this module imports no cloud
   * code (the daemon client already imports registry — a back-import would
   * cycle).
   */
  unlimited: boolean;
}

export type PeerResolveResult =
  | { ok: false; refused: "workspace_pro_only"; message: string }
  | { ok: true; peers: RepoEntry[] };

/**
 * Resolve the federatable peers for a home repo, or refuse on free tier. The
 * caller maps the returned registry entries to wire `PeerEntry` objects (adding
 * repoId + live socket), which keeps this function free of async id derivation.
 *
 * @sem domain=process-manager role=identity
 */
export function resolveFederatedPeers(
  input: PeerResolveInput
): PeerResolveResult {
  if (!input.unlimited) {
    return {
      ok: false,
      refused: "workspace_pro_only",
      message: WORKSPACE_PRO_ONLY_MESSAGE,
    };
  }

  const home = resolve(expandHome(input.homeRepo));
  const peers = input.repos.filter((r) => {
    if (resolve(expandHome(r.path)) === home) return false;
    // Absent federate ⇒ opted in (default true). Only an explicit false excludes.
    if (r.settings?.federate === false) return false;
    return true;
  });

  return { ok: true, peers };
}
