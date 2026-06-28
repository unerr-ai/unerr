/**
 * unerr cloud — Tier-3 auth transition notifier.
 *
 * The daemon's entitlement refresh job calls `maybeNotifyAuthTransition()`
 * after every refresh. It fires at most ONE best-effort OS notification per
 * transition into a "lost access" state, using a persisted latch
 * (`auth-events.notified_state`) so a degrade/revoke is announced once — never
 * re-fired on the 12h tick while the machine sits in that state, and surviving
 * daemon restarts.
 *
 * Policy (.internal/archive/LOGIN_UX_STRATEGY.md §9 decision 4):
 *  - `revoked`       → notify by default (the high-signal, definitive loss).
 *  - `degraded_free` → notify only when `notifyGrace` is enabled (off by
 *    default; an offline laptop shouldn't get a toast every grace window).
 *  - healthy states (`active`/`stale_refreshing`/`logged_out`) reset the latch
 *    so the NEXT degrade notifies cleanly.
 *  - `grace_expiring` is a no-op here (it's a Tier-1/Tier-2 warning, not a
 *    definitive loss) and deliberately leaves the latch untouched.
 *
 * Every dependency is injectable so the policy is unit-testable without a real
 * OS notifier, filesystem, or settings file. Never throws (HR-B).
 */

import { loadSettings } from "../config/settings.js";
import { readNotifiedState, setNotifiedState } from "./auth-events.js";
import { type AuthStateName, authState } from "./auth-state.js";
import { osNotify } from "./os-notify.js";

/** States that reset the latch — the machine is healthy / deliberately free. */
const HEALTHY: ReadonlySet<AuthStateName> = new Set<AuthStateName>([
  "active",
  "stale_refreshing",
  "logged_out",
]);

/** The toast copy per notify-worthy state. Every line names `unerr login` and
 *  states local features keep working (the cross-tier invariant). */
const MESSAGES: Partial<
  Record<AuthStateName, { title: string; body: string }>
> = {
  revoked: {
    title: "unerr — this machine was disconnected",
    body: "Your team removed this machine. Run `unerr login` to reconnect. Local features keep working.",
  },
  degraded_free: {
    title: "unerr — Pro features paused",
    body: "Your plan's entitlement expired. Run `unerr login` to restore Pro. Local features keep working.",
  },
};

/** Resolve whether a `degraded_free` transition should notify: env var wins,
 *  else the `auth.notifyGrace` setting (default off). Never throws. */
function notifyGraceEnabled(): boolean {
  const env = process.env.UNERR_NOTIFY_GRACE;
  if (env != null) {
    const v = env.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  try {
    return loadSettings().auth.notifyGrace === true;
  } catch {
    return false;
  }
}

/** Injectable seams (all default to the real implementations). */
export interface NotifyDeps {
  /** Current auth state name. Defaults to `authState().state`. */
  getState?: () => AuthStateName;
  /** Read the persisted latch. */
  readLatch?: () => string | undefined;
  /** Write/reset the persisted latch. */
  writeLatch?: (state: string | undefined) => void;
  /** Fire the OS notification. */
  notify?: (title: string, body: string) => void;
  /** Whether `degraded_free` transitions notify. */
  notifyGrace?: boolean;
}

/**
 * Fire at most one OS notification for a transition into `revoked` (always) or
 * `degraded_free` (when grace notifications are enabled), deduped via the
 * persisted latch. Resets the latch on a return to a healthy state. Idempotent
 * within a state — calling repeatedly while latched does nothing. Never throws.
 */
export function maybeNotifyAuthTransition(deps: NotifyDeps = {}): void {
  try {
    const state = (deps.getState ?? (() => authState().state))();
    const readLatch = deps.readLatch ?? readNotifiedState;
    const writeLatch = deps.writeLatch ?? setNotifiedState;
    const last = readLatch();

    // Healthy again → clear the latch so the next degrade re-notifies.
    if (HEALTHY.has(state)) {
      if (last !== undefined) writeLatch(undefined);
      return;
    }

    // grace_expiring (or any non-notify-worthy state) — leave the latch as-is.
    if (!(state in MESSAGES)) return;

    // Already announced this exact state — don't re-fire on the next tick.
    if (state === last) return;

    const grace = deps.notifyGrace ?? notifyGraceEnabled();
    const allowed = state === "revoked" || (state === "degraded_free" && grace);
    if (allowed) {
      const msg = MESSAGES[state];
      if (msg) (deps.notify ?? osNotify)(msg.title, msg.body);
    }
    // Latch regardless of whether grace gating suppressed the toast — the
    // transition has been consumed; we don't re-evaluate it every 12h.
    writeLatch(state);
  } catch {
    /* Tier-3 is best-effort — never break the refresh job */
  }
}
