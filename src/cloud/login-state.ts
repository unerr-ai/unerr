/**
 * unerr cloud — shared login-state helpers.
 *
 * Used by `unerr whoami`, and by the one-line login summaries in
 * `unerr status` / `unerr doctor`. Keeps the "are we connected, and how do
 * we say so in plain English" logic in one place inside `src/cloud/`.
 */

import { markRevoked } from "./auth-events.js";
import { authState } from "./auth-state.js";
import { authStateLine } from "./auth-surface.js";
import {
  deleteCredentials,
  deleteEntitlementsCache,
  deleteTeamConventionsCache,
} from "./credentials.js";

/**
 * The one consistent line shown whenever the team revokes this machine.
 * Every cloud call path (client, refresh job, conventions sync, commands)
 * funnels a `401 revoked_token` through `handleRevokedToken`, which returns
 * exactly this — so the user always sees the same words (Sprint I4.4).
 */
export const REVOKED_MESSAGE =
  "This machine was disconnected by your team — run unerr login to reconnect.";

/**
 * Handle a `401 revoked_token` from any authenticated call: the team
 * disconnected this machine in the web app. Wipe ALL local cloud state —
 * credentials, the entitlement cache, and the synced team-conventions doc —
 * so the CLI quietly falls back to logged-out. Returns the one consistent
 * plain-language message for the caller to show.
 */
export function handleRevokedToken(): string {
  deleteCredentials();
  deleteEntitlementsCache();
  deleteTeamConventionsCache();
  // Persist a durable revoked marker BEFORE returning — it outlives the wipe
  // above, so `authState()` can still say "revoked" (loud) instead of
  // "logged_out" (silent). Cleared on the next successful login/refresh.
  markRevoked();
  return REVOKED_MESSAGE;
}

/**
 * The plain-language one-liner for `status` / `doctor` / `whoami` (Tier-2
 * passive surface, A4). Makes no network call — it derives from the local
 * auth state machine, so it's fast, offline, and consistent with the in-band
 * signal. Every state has a resting description (logged_out, active, grace,
 * degraded_free, revoked); the rendering lives in `authStateLine` (one place).
 */
export function loginStateLine(): string {
  return authStateLine(authState());
}
