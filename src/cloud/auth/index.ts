/**
 * unerr cloud — auth facade.
 *
 * This is the only module under `src/cloud/auth/` that code outside
 * `src/cloud/` may import from. It re-exports exactly the identity,
 * sign-in, and credential symbols that external callers use today —
 * nothing else, no logic of its own.
 *
 * Rule for code INSIDE `src/cloud/`: always import the concrete module
 * directly (e.g. `../auth/credentials.js`), never this facade or a sibling
 * folder's facade. Routing an internal import through a facade creates a
 * module-init cycle between `auth/` and `plan/` (`auth-state.ts` needs
 * `plan/tier-query.js`, `plan/entitlements.ts` needs `auth/credentials.js`)
 * — importing the facade instead of the concrete file pulls in every other
 * export in the folder, including ones that import back into `plan/`.
 */

export { clearAuthEvents } from "./auth-events.js";
export type { AuthState } from "./auth-state.js";
export { authState } from "./auth-state.js";
export type { AuthSignal } from "./auth-surface.js";
export { authSurfaceSignal } from "./auth-surface.js";
export type { Credentials } from "./credentials.js";
export {
  deleteCredentials,
  deleteEntitlementsCache,
  deleteTeamConventionsCache,
  isLoggedIn,
  readCredentialMetadata,
  readCredentials,
  teamConventionsPath,
  writeCredentials,
} from "./credentials.js";
export { runDeviceFlow } from "./device-flow.js";
export {
  isInternalEntryShape,
  loginBlocked,
  loginGateNotice,
} from "./login-gate.js";
export { recordLogin, recordLogout } from "./login-ledger.js";
export { handleRevokedToken, loginStateLine } from "./login-state.js";
