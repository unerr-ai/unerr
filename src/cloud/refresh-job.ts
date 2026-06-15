/**
 * unerr cloud — the entitlement refresh job.
 *
 * Lives in `src/cloud/` (the auditable cloud surface); the daemon
 * (`src/entrypoints/daemon.ts`) just calls `startEntitlementRefresh()` on
 * boot and `runEntitlementRefreshOnce()` after a successful login. All the
 * "when do we talk to the cloud" logic stays here.
 *
 * Schedule (integration plan §3.3):
 *  - once immediately on daemon start (and once right after `unerr login`),
 *  - then every 12 hours with ±1h jitter, via an unref'd setTimeout chain so
 *    the timer never keeps the process alive on its own.
 *
 * Failure handling (HR-B — local work never breaks):
 *  - not logged in           → skip silently, but keep the timer ticking so
 *    a later `unerr login` is picked up without a daemon restart.
 *  - offline / network error → silent; the signed cache covers it.
 *  - 401 revoked_token       → wipe credentials + cache (handleRevokedToken),
 *    then STOP the timer (nothing to refresh until the next login).
 */

import { recordRefreshOutcome } from "./auth-events.js";
import { maybeNotifyAuthTransition } from "./auth-notify.js";
import { CloudClient } from "./client.js";
import { syncConventions } from "./conventions-sync.js";
import { readCredentials } from "./credentials.js";
import { refreshEntitlements } from "./entitlements.js";
import { handleRevokedToken } from "./login-state.js";
import { runRecallSyncOnce } from "./recall-sync.js";

/** Base interval between refreshes: 12 hours. */
export const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Jitter spread: ±1 hour, so a fleet of laptops doesn't sync up. */
export const REFRESH_JITTER_MS = 60 * 60 * 1000;

/** Optional quiet logger (defaults to no-op). Never receives the token. */
export type RefreshLogger = (msg: string) => void;

export interface RefreshJobDeps {
  /** Build a client from current credentials. Overridable in tests. */
  makeClient?: (apiUrl: string, token: string) => CloudClient;
  /** setTimeout, overridable for fake timers. Must return a handle. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** clearTimeout, overridable for fake timers. */
  clearTimer?: (handle: unknown) => void;
  /** Random in [0,1) for jitter. Overridable in tests. */
  random?: () => number;
  /** Quiet log sink. */
  log?: RefreshLogger;
  /**
   * Fire the Tier-3 auth-transition notification. Defaults to the real
   * `maybeNotifyAuthTransition`; overridable in tests to assert it runs after
   * the refresh has settled credentials/cache/provenance.
   */
  notifyTransition?: () => void;
}

/**
 * Run one refresh attempt. Returns the outcome so callers (login, tests) can
 * react. Skips silently with `"skipped"` when not logged in.
 */
export async function runEntitlementRefreshOnce(
  deps: RefreshJobDeps = {}
): Promise<{ status: "skipped" | "revoked" | "done"; plan?: string }> {
  const notifyTransition =
    deps.notifyTransition ?? (() => maybeNotifyAuthTransition());

  const creds = readCredentials();
  if (!creds) {
    // Not logged in (incl. just after logout). Reconcile the notification
    // latch — a return to the healthy `logged_out` state clears it so a future
    // degrade re-notifies — then report skipped.
    notifyTransition();
    return { status: "skipped" };
  }

  const makeClient =
    deps.makeClient ?? ((apiUrl, token) => new CloudClient({ apiUrl, token }));
  const client = makeClient(creds.api_url, creds.token);

  const outcome = await refreshEntitlements(client);

  // Persist the result so `authState()` can tone the grace warning — a
  // `network` failure reads "you're offline" (quiet), an `auth_error` reads
  // "your access changed" (loud). An `ok` here also clears any revoked marker.
  recordRefreshOutcome(outcome.result);

  // Single exit: classify into a result, then fire the Tier-3 transition
  // notification ONCE, after every credential/cache/provenance mutation has
  // settled (so `authState()` reads the post-refresh truth — notably after
  // `handleRevokedToken` wipes a revoked machine).
  let result: { status: "skipped" | "revoked" | "done"; plan?: string } = {
    status: "done",
  };

  switch (outcome.result) {
    case "revoked":
      // The team disconnected this machine — wipe everything quietly.
      handleRevokedToken();
      deps.log?.("entitlements: machine revoked — credentials cleared");
      result = { status: "revoked" };
      break;
    case "ok": {
      deps.log?.(`entitlements: refreshed (plan ${outcome.plan})`);
      // Same run: pull the team-conventions doc now that entitlements
      // refreshed. The sync gates itself (skips silently when the plan
      // lacks conventions_sync) and covers offline with the stored doc, so
      // a failure here never affects the entitlement outcome. A revoked
      // token surfaced here still self-wipes via handleRevokedToken.
      const conv = await syncConventions(client).catch(
        () => ({ result: "error", message: "sync threw" }) as const
      );
      if (conv.result === "updated") {
        deps.log?.(`conventions: updated to version ${conv.version}`);
        result = { status: "done", plan: outcome.plan };
      } else if (conv.result === "revoked") {
        deps.log?.("conventions: machine revoked — credentials cleared");
        result = { status: "revoked" };
      } else {
        if (conv.result === "error") {
          deps.log?.(`conventions: sync failed — ${conv.message}`);
        }
        result = { status: "done", plan: outcome.plan };
      }
      // Same run: fetch the user's due recall prompts (C5) and persist them
      // to the local store so `unerr status` can surface them offline. Gates
      // itself on `canSyncRecall()` inside `runRecallSyncOnce` (free /
      // logged-out → zero network), covers offline silently, and never throws
      // into the refresh outcome — wrapped exactly like `syncConventions`.
      {
        const recall = await runRecallSyncOnce({
          makeClient: deps.makeClient,
        }).catch(() => ({ result: "error", message: "recall threw" }) as const);
        if (recall.result === "ok") {
          deps.log?.(`recall: ${recall.prompts.length} due prompt(s)`);
        } else if (recall.result === "error") {
          deps.log?.(`recall: fetch failed — ${recall.message}`);
        }
      }
      break;
    }
    case "bad_token":
      deps.log?.("entitlements: server token failed verification — kept cache");
      break;
    case "network":
      // Offline — the cache covers it. Stay silent.
      break;
    case "auth_error":
      deps.log?.("entitlements: saved login no longer valid");
      break;
    case "error":
      deps.log?.(`entitlements: refresh failed — ${outcome.message}`);
      break;
  }

  notifyTransition();
  return result;
}

/** A running refresh job; call `stop()` to cancel the timer. */
export interface RefreshJobHandle {
  stop: () => void;
}

/**
 * Start the refresh job: run once now, then re-arm a jittered timer after
 * each run. The timer is unref'd so it never keeps the daemon alive by
 * itself. A `revoked` outcome stops the chain.
 */
export function startEntitlementRefresh(
  deps: RefreshJobDeps = {}
): RefreshJobHandle {
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    });
  const clearTimer =
    deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const random = deps.random ?? Math.random;

  let stopped = false;
  let handle: { unref?: () => void } | null = null;

  const arm = (): void => {
    if (stopped) return;
    // 12h ± up to 1h.
    const jitter = (random() * 2 - 1) * REFRESH_JITTER_MS;
    const delay = Math.max(0, REFRESH_INTERVAL_MS + jitter);
    handle = setTimer(() => {
      void tick();
    }, delay);
    handle?.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let result: { status: "skipped" | "revoked" | "done" };
    try {
      result = await runEntitlementRefreshOnce(deps);
    } catch (err) {
      // Defensive: a refresh must never crash the daemon.
      deps.log?.(`entitlements: refresh error — ${(err as Error).message}`);
      result = { status: "done" };
    }
    if (stopped) return;
    if (result.status === "revoked") {
      stop();
      return;
    }
    // "skipped" (not logged in) still re-arms: a later login is picked up.
    arm();
  };

  const stop = (): void => {
    stopped = true;
    if (handle) clearTimer(handle);
    handle = null;
  };

  // Kick off the first run immediately (no jitter on the very first one).
  void tick();

  return { stop };
}
