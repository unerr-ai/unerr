/**
 * unerr cloud — plan facade.
 *
 * This is the only module under `src/cloud/plan/` that code outside
 * `src/cloud/` may import from. It re-exports exactly the entitlement,
 * tier, and repo-cap symbols that external callers use today — nothing
 * else, no logic of its own.
 *
 * Rule for code INSIDE `src/cloud/`: always import the concrete module
 * directly (e.g. `../plan/entitlements.js`), never this facade or a
 * sibling folder's facade. Routing an internal import through a facade
 * creates a module-init cycle between `auth/` and `plan/`
 * (`auth/auth-state.ts` needs `plan/tier-query.js`, `plan/entitlements.ts`
 * needs `auth/credentials.js`) — importing the facade instead of the
 * concrete file pulls in every other export in the folder, including ones
 * that import back into `auth/`.
 */

export {
  canPushTelemetry,
  effectiveTier,
  isTelemetryDisabledByConfig,
  isTelemetryDisabledByEnv,
  readEntitlementCache,
  refreshEntitlements,
} from "./entitlements.js";
export { startEntitlementRefresh } from "./refresh-job.js";
export { RepoCapError, checkRegisterRepo } from "./repo-cap.js";
export type { TierLimits } from "./tier-model.js";
export { FREE_TIER_LIMITS, UNLIMITED, repoLimit } from "./tier-model.js";
export { currentRepoLimit, tierFromCache } from "./tier-query.js";
