/**
 * unerr cloud — read the current tier without any network call.
 *
 * Per-repo proxies need to know the plan to switch paid features on/off, but
 * they must NEVER talk to the cloud themselves (the daemon owns that). This
 * module answers "what plan am I on?" from local state only, two ways:
 *
 *  1. Ask the daemon over its UDS socket (`entitlements` command). The daemon
 *     is the one process that refreshes, so it has the freshest answer.
 *  2. If the daemon isn't running, fall back to reading + verifying the cache
 *     file directly (`effectiveTier()`).
 *
 * Both paths are offline and never block. The shape returned is the same.
 */

import { daemonSockPath, getDaemonTier } from "../daemon/client.js";
import { effectiveTier, readEntitlementCache } from "./entitlements.js";

/** The tier snapshot a proxy acts on. */
export interface TierSnapshot {
  plan: string;
  source: "fresh" | "grace" | "free_fallback" | "none";
  features: Record<string, boolean>;
  /** When in grace: ISO date to reconnect by. */
  reconnect_by?: string;
}

/**
 * Resolve the current tier with no network call: try the daemon first, then
 * fall back to a direct cache read. Always resolves (never rejects) — the
 * worst case is the free plan.
 */
export async function resolveTier(
  now: number = Date.now()
): Promise<TierSnapshot> {
  try {
    const fromDaemon = await getDaemonTier(daemonSockPath());
    if (fromDaemon) return fromDaemon;
  } catch {
    // Daemon not running / unreachable — fall through to the file read.
  }
  return tierFromCache(now);
}

/** Direct cache read + verify (the no-daemon fallback). Pure + offline. */
export function tierFromCache(now: number = Date.now()): TierSnapshot {
  const tier = effectiveTier(now);
  const features = featuresForTier(tier.source, now);
  return {
    plan: tier.plan,
    source: tier.source,
    features,
    reconnect_by: tier.reconnect_by,
  };
}

/**
 * The features map to expose for a tier. Fresh/grace read the verified
 * claims; otherwise no paid features. Kept here (not imported from gate.ts)
 * so this module has no dependency cycle with the gate helper.
 */
function featuresForTier(
  source: TierSnapshot["source"],
  _now: number
): Record<string, boolean> {
  if (source === "fresh" || source === "grace") {
    const cache = readEntitlementCache();
    return cache?.claims?.features ?? {};
  }
  return {};
}
