/**
 * unerr cloud — the auth state machine (single source of truth).
 *
 * Every surface that tells the user "what's happening with your login" — the
 * in-band `ur|act` proxy line, `unerr status` / `whoami` / `doctor`, the
 * dashboard badge, the revoked OS notification — must agree. They agree
 * because they all read THIS one derivation and nothing else.
 *
 * The hard problem (per `.internal/LOGIN_UX_STRATEGY.md`) is that the gating
 * primitive `effectiveTier()` only knows "what plan, right now?" — it collapses
 * "never logged in", "chose free", and "team revoked me" all to the same `free`
 * answer, and it can't say WHY a plan lapsed. Surfacing has to draw exactly
 * those distinctions: stay silent for a deliberate free user, be loud for a
 * revoked one. So `authState()` composes three local, offline inputs:
 *
 *   1. `tierFromCache()`  — the verified plan + features (which itself composes
 *      `effectiveTier()`; we build ON it, never fork it — one gating truth).
 *   2. `readAuthEvents()` — durable provenance that survives the revocation
 *      credential wipe: a revoked marker + the last refresh result.
 *   3. `readCredentialMetadata()` — keychain-free login presence + org/machine.
 *
 * Pure, offline, never throws, never prompts a keychain. Safe to call on a
 * proxy tool-call hot path.
 */

import { readAuthEvents } from "./auth-events.js";
import { readCredentialMetadata } from "./credentials.js";
import { tierFromCache } from "./tier-query.js";

/** The six auth states a surface renders. */
export type AuthStateName =
  /** No login on this machine, and none was ever lost. Stay silent. */
  | "logged_out"
  /** Verified, fresh entitlement. The happy path. */
  | "active"
  /** In grace, refresh expected/healthy — plan still honored, no alarm. */
  | "stale_refreshing"
  /** In grace, but the last refresh FAILED — plan will lapse. Warn (toned). */
  | "grace_expiring"
  /** Grace fully expired (or no cache) while a login exists — dropped to free. */
  | "degraded_free"
  /** Team revoked this machine. Credentials wiped; loud, one-time. */
  | "revoked";

/** Why a plan is lapsing / lapsed — drives the surfacing TONE, not the state. */
export type AuthReason = "offline" | "unauthorized" | "revoked";

/** The one auth snapshot every surface renders from. */
export interface AuthState {
  state: AuthStateName;
  /** The gating plan a caller should act on (always `free` outside fresh/grace). */
  plan: string;
  /** Verified paid features for the current plan; empty outside fresh/grace. */
  features: Record<string, boolean>;
  /**
   * True when this machine HAD a login (still present, or lost to revocation).
   * The single bit that separates `degraded_free`/`revoked` (loud) from
   * `logged_out` (silent) — a deliberate-free user must never be nagged.
   */
  was_authenticated: boolean;
  /** When in grace: ISO date by which to reconnect. */
  reconnect_by?: string;
  /** Present for `grace_expiring` (offline|unauthorized) and `revoked`. */
  reason?: AuthReason;
  organization_id?: string;
  machine_name?: string;
}

/**
 * Derive the current auth state from local state only. Precedence is
 * deliberate — revocation provenance outranks the cache, because revocation
 * wipes the cache and we must still say "revoked", not "logged out".
 */
export function authState(now: number = Date.now()): AuthState {
  const events = readAuthEvents();
  const meta = readCredentialMetadata();
  const tier = tierFromCache(now);

  const was_authenticated = meta !== null || events.revoked_at != null;

  const base = {
    plan: tier.plan,
    features: tier.features,
    was_authenticated,
    reconnect_by: tier.reconnect_by,
    organization_id: meta?.organization_id || undefined,
    machine_name: meta?.machine_name || undefined,
  };

  // 1. Revoked — strongest signal. The credential + cache are already wiped,
  //    so the durable marker is the only thing that distinguishes this from a
  //    clean logged-out machine. Cleared by a successful login/refresh.
  if (events.revoked_at != null) {
    return {
      ...base,
      state: "revoked",
      plan: "free",
      features: {},
      reason: "revoked",
    };
  }

  // 2. Verified-fresh entitlement — the happy path.
  if (tier.source === "fresh") {
    return { ...base, state: "active" };
  }

  // 3. In grace — the plan is still honored, but a refresh is overdue. The
  //    last refresh result sets the tone: a network failure is the machine's
  //    fault (quiet, "you're offline"); an auth failure is the account's
  //    (loud, "your access changed"). An ok/absent/unknown result means the
  //    refresh simply hasn't run yet — passive, no alarm.
  if (tier.source === "grace") {
    const result = events.last_refresh?.result;
    if (result === "network") {
      return { ...base, state: "grace_expiring", reason: "offline" };
    }
    if (result === "auth_error" || result === "bad_token") {
      return { ...base, state: "grace_expiring", reason: "unauthorized" };
    }
    return { ...base, state: "stale_refreshing" };
  }

  // 4. free_fallback / none — no honored plan. A login that exists (or was
  //    revoked, handled above) means we DROPPED from a paid plan: say so.
  //    Otherwise it's a clean logged-out machine: stay silent.
  if (was_authenticated) {
    return { ...base, state: "degraded_free", plan: "free", features: {} };
  }
  return { ...base, state: "logged_out", plan: "free", features: {} };
}
