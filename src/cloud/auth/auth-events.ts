/**
 * unerr cloud — durable auth provenance.
 *
 * The signed entitlement cache + credential file answer "what plan, right
 * now?" — but they are both WIPED on revocation (`handleRevokedToken`), so on
 * their own they cannot tell `revoked` (had Pro, team removed us) apart from
 * `logged_out` (never signed in), nor say WHY a refresh is failing (offline vs
 * the saved login no longer being valid). That distinction is what lets the
 * surfacing layer be loud about a lost plan and quiet about a chosen-free one
 * (see `.internal/archive/LOGIN_UX_STRATEGY.md` §4).
 *
 * This file persists exactly those two provenance facts, in one small 0600
 * JSON sibling of `credentials.json`, deliberately OUTSIDE the entitlement
 * cache so it survives the revocation wipe. Every function is best-effort and
 * never throws — auth provenance must never break a local code path (HR-B).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RefreshOutcome } from "../plan/entitlements.js";

/** 0600 — owner read/write only, same as the credential file. */
const FILE_MODE = 0o600;

/** The raw result of the last entitlement refresh attempt. */
export type RefreshResult = RefreshOutcome["result"];

/**
 * The durable provenance record. Both fields are optional — an absent file
 * means "never attempted, never revoked" (a clean logged-out machine).
 */
export interface AuthEvents {
  /** Epoch ms when the machine was last revoked by its team. */
  revoked_at?: number;
  /** The most recent refresh attempt's result + when it happened (epoch ms). */
  last_refresh?: { result: RefreshResult; at: number };
  /**
   * The auth state we last fired a Tier-3 OS notification for (or latched as
   * already-handled). The transition notifier uses it so a degrade/revoke is
   * announced exactly once, not re-fired on every 12h refresh tick. Resetting
   * it to undefined (on a return to a healthy state) lets a future degrade
   * re-notify. Stored as the `AuthStateName` string; kept here (not in
   * auth-state) so the storage layer stays a dependency-free leaf.
   */
  notified_state?: string;
}

/** `~/.unerr/auth-events.json` — sibling of credentials.json, mode 0600. */
export function authEventsPath(): string {
  return join(homedir(), ".unerr", "auth-events.json");
}

/** Ensure `~/.unerr` exists (0700) before writing into it. */
function ensureHomeDir(): void {
  const dir = dirname(authEventsPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Read the provenance record. Returns an empty record on any error/absence. */
export function readAuthEvents(): AuthEvents {
  const path = authEventsPath();
  if (!existsSync(path)) return {};
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== FILE_MODE) chmodSync(path, FILE_MODE);
  } catch {
    /* chmod can fail on some filesystems / Windows — never fail the read */
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AuthEvents;
  } catch {
    return {};
  }
}

/** Merge-write the provenance record, 0600. Best-effort, never throws. */
function writeAuthEvents(next: AuthEvents): void {
  try {
    ensureHomeDir();
    const body = JSON.stringify(next, null, 2);
    writeFileSync(authEventsPath(), `${body}\n`, { mode: FILE_MODE });
    try {
      chmodSync(authEventsPath(), FILE_MODE);
    } catch {
      /* mode reassert is best-effort */
    }
  } catch {
    /* provenance is non-critical — never break a caller on a write failure */
  }
}

/**
 * Record the outcome of a refresh attempt. A successful (`ok`) refresh also
 * clears any stale `revoked_at` — the machine is plainly connected again.
 */
export function recordRefreshOutcome(result: RefreshResult): void {
  const events = readAuthEvents();
  events.last_refresh = { result, at: Date.now() };
  if (result === "ok") events.revoked_at = undefined;
  writeAuthEvents(events);
}

/** Mark this machine as revoked (called from `handleRevokedToken`). */
export function markRevoked(now: number = Date.now()): void {
  const events = readAuthEvents();
  events.revoked_at = now;
  writeAuthEvents(events);
}

/**
 * Clear all provenance — used on `unerr login` (fresh start) and `unerr
 * logout` (intentional disconnect, so the next state is a clean `logged_out`,
 * never a lingering `revoked`). Also clears the notification latch, so the
 * first degrade after a fresh login notifies cleanly.
 */
export function clearAuthEvents(): void {
  writeAuthEvents({});
}

/** Read the auth state we last fired a Tier-3 notification for (or latched). */
export function readNotifiedState(): string | undefined {
  return readAuthEvents().notified_state;
}

/**
 * Latch the auth state we just notified for (or `undefined` to reset on a
 * return to health). Merge-write so the refresh/revoke provenance is kept.
 */
export function setNotifiedState(state: string | undefined): void {
  const events = readAuthEvents();
  events.notified_state = state;
  writeAuthEvents(events);
}
