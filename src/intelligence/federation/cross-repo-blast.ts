/**
 * CROSS_REPO_INTELLIGENCE Sprint 6.1: federate the pre-edit blast radius. After
 * the home proxy computes local cascade warnings (`computeEditImpact`), this
 * augments each changed entity with its callers in federated peer repos —
 * resolved through the L2 SCIP moniker linker, not a re-scan. The pre-edit gate
 * then cites cross-repo callers so a signature change isn't shipped while
 * callers in another repo go unupdated.
 *
 * Local and federation stay decoupled: `computeEditImpact` knows nothing of
 * peers; this runs only in the home proxy where the coordinator + moniker index
 * live, and degrades to a no-op (warnings unchanged) on free tier, with no
 * coordinator/index, or when an entity has no cross-repo moniker.
 *
 */

import type { CascadeWarning } from "../edit-impact.js";
import type { FederationCoordinator } from "./coordinator.js";
import { type MonikerIndex, monikerForEntity } from "./moniker-index.js";

/** What a peer's `xref_by_moniker` reply carries (get_references-shaped). */
interface PeerXrefResult {
  references?: unknown[];
  total?: number;
}

/** Count the caller sites in one peer's `xref_by_moniker` reply. */
function peerCallerCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const r = result as PeerXrefResult;
  if (typeof r.total === "number") return r.total;
  return Array.isArray(r.references) ? r.references.length : 0;
}

export interface AugmentBlastRadiusOptions {
  monikerIndex: MonikerIndex | null;
  coordinator: FederationCoordinator | null;
  homeRepo: string;
}

/**
 * Attach cross-repo caller counts to each cascade warning in place. For every
 * changed entity that carries a stable SCIP moniker, fan `xref_by_moniker` out
 * to the federated peers and record which repos reference it and how many
 * times. Mutates and returns `warnings`. Never throws: any federation fault
 * leaves a warning unaugmented (home-only), so the gate still fires on the
 * local cascade.
 */
export async function augmentBlastRadiusWithPeers(
  warnings: CascadeWarning[],
  opts: AugmentBlastRadiusOptions
): Promise<CascadeWarning[]> {
  const { monikerIndex, coordinator, homeRepo } = opts;
  if (!monikerIndex || !coordinator || warnings.length === 0) return warnings;

  await Promise.all(
    warnings.map(async (warning) => {
      const moniker = monikerForEntity(
        monikerIndex,
        warning.changed_entity_key
      );
      if (!moniker) return; // not exported / no cross-repo identity → home-only
      try {
        const fan = await coordinator.fanOut({
          homeRepo,
          toolName: "xref_by_moniker",
          args: { moniker, direction: "callers" },
        });
        if (fan.refused) return; // free tier — leave home-only
        const peers = fan.results
          .map((r) => ({
            repoId: r.repoId,
            label: r.label,
            callers: peerCallerCount(r.result),
          }))
          .filter((p) => p.callers > 0)
          .sort((a, b) => b.callers - a.callers);
        if (peers.length === 0) return;
        const total = peers.reduce((sum, p) => sum + p.callers, 0);
        warning.cross_repo = { total_peer_callers: total, peers };
      } catch {
        // Federation is advisory — a fault never blocks the local gate.
      }
    })
  );

  return warnings;
}
