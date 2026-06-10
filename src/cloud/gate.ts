/**
 * unerr cloud — the single feature-gate helper.
 *
 * Every paid code path calls `gate("<feature>")` and acts on the result —
 * the CLI-side mirror of the server's one-helper `requireOrgMember` rule
 * (integration plan §5). Free/local features NEVER call this: the local
 * product works with no account at all (HR-B).
 *
 * The decision is fully offline: it reads the verified entitlement cache via
 * `effectiveTier()`, then checks the plan's `features` map. It never makes a
 * network call and never blocks — a denied feature returns a plain-language
 * explanation the caller can show before doing the free thing.
 */

import { type EffectiveTier, effectiveTier } from "./entitlements.js";
import { readEntitlementCache } from "./entitlements.js";

/** The outcome of a gate check. Always returns — never throws, never blocks. */
export interface GateResult {
  /** True only when the current plan includes the feature. */
  allowed: boolean;
  /** A short machine-readable reason (for logs / branching, not for users). */
  reason:
    | "allowed"
    | "grace"
    | "not_logged_in"
    | "plan_lacks_feature"
    | "grace_expired";
  /** A plain-language line to show the user. Empty when allowed and fresh. */
  message: string;
}

/**
 * Decide whether a paid feature is available right now.
 *
 * `featureKey` matches a key in the plan's `features` map (e.g.
 * `"conventions_sync"`). Pass `now` only in tests.
 */
export function gate(featureKey: string, now: number = Date.now()): GateResult {
  const tier = effectiveTier(now);
  const features = currentFeatures(tier, now);
  const has = features[featureKey] === true;

  if (has && tier.source === "fresh") {
    return { allowed: true, reason: "allowed", message: "" };
  }

  if (has && tier.source === "grace") {
    const by = tier.reconnect_by ? friendlyDate(tier.reconnect_by) : "soon";
    return {
      allowed: true,
      reason: "grace",
      message: `Running on a cached plan — reconnect by ${by} to keep your team's features. Run unerr login.`,
    };
  }

  // Not allowed. Explain why, in plain language, and point at the fix.
  if (tier.source === "none" || tier.source === "free_fallback") {
    // Could be "never logged in" or "grace expired" — distinguish for a
    // clearer message using whether we have any cached login at all.
    const cache = readEntitlementCache();
    if (tier.source === "free_fallback" || cache) {
      return {
        allowed: false,
        reason: "grace_expired",
        message:
          "This needs your team's plan, and the cached plan has run out. Run unerr login to reconnect.",
      };
    }
    return {
      allowed: false,
      reason: "not_logged_in",
      message: "This needs your team's plan — run unerr login to connect.",
    };
  }

  // Logged in on a plan that simply doesn't include this feature.
  return {
    allowed: false,
    reason: "plan_lacks_feature",
    message:
      "Your team's current plan doesn't include this. See your plan options in the unerr web app.",
  };
}

/**
 * The features map for the effective tier. Fresh/grace use the verified
 * claims' features; free fallback exposes no paid features.
 */
function currentFeatures(
  tier: EffectiveTier,
  _now: number
): Record<string, boolean> {
  if (tier.source === "fresh" || tier.source === "grace") {
    const cache = readEntitlementCache();
    return cache?.claims?.features ?? {};
  }
  return {};
}

/** Render an ISO timestamp as a plain date like "June 14, 2026". */
function friendlyDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
