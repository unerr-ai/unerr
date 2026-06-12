/**
 * unerr auto-update — persisted state.
 *
 * One small JSON file at `~/.unerr/state/update.json` (honours `UNERR_HOME`),
 * the single record the update subsystem reads/writes across phases:
 *  - U1 detection writes the throttle timestamp + last-seen latest version.
 *  - U3 surfacing reads it to render `unerr status` / the in-band line.
 *  - U5 apply writes the applied/rolled-back history + the pinned
 *    last-known-good version used for rollback.
 *
 * Non-secret (it's a version number + timestamps), so no 0600 requirement —
 * but every function is best-effort and never throws: a missing/corrupt file
 * reads as an empty record, and a failed write is swallowed. Auto-update state
 * must never break a local code path (HR-B).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../daemon/registry.js";
import type { ReleaseKind } from "./semver.js";

/** The applied/rolled-back transition record (epoch ms timestamps). */
export interface VersionTransition {
  from: string;
  to: string;
  at: number;
  /** Present on a rollback — why the new version was reverted. */
  reason?: string;
}

/**
 * The durable update record. All fields optional — an absent file means
 * "never checked, never applied" (a fresh machine).
 */
export interface UpdateState {
  /** Epoch ms of the last registry check (drives the throttle). */
  last_checked_at?: number;
  /** The unerr version running when the last check ran. */
  current_version?: string;
  /** The latest version seen on the registry at the last check. */
  latest_version?: string;
  /** How `latest_version` classified against `current_version`. */
  latest_kind?: ReleaseKind;
  /** The most recent successful auto-apply. */
  last_applied?: VersionTransition;
  /** The most recent rollback (health-check failed → reverted). */
  last_rollback?: VersionTransition;
  /** The known-good version to revert to if a fresh apply fails its check. */
  last_good_version?: string;
  /** A staged upgrade applied on disk, awaiting the next spawn to take effect. */
  pending_version?: string;
  /** Epoch ms the first-run auto-update disclosure was shown (once per machine). */
  disclosed_at?: number;
  /** Epoch ms the notify-only "available" line was last surfaced (daily throttle). */
  available_notified_at?: number;
  /** The version the last "available" line named (resets the throttle on a new release). */
  available_notified_version?: string;
}

/** `~/.unerr/state/update.json` (honours UNERR_HOME). */
export function updateStatePath(): string {
  return join(globalDir(), "state", "update.json");
}

/** Read the update record. Returns an empty record on any error/absence. */
export function readUpdateState(): UpdateState {
  const path = updateStatePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UpdateState;
  } catch {
    return {};
  }
}

/** Merge-write a partial patch into the update record. Best-effort. */
export function writeUpdateState(patch: Partial<UpdateState>): void {
  try {
    const dir = join(globalDir(), "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = { ...readUpdateState(), ...patch };
    writeFileSync(updateStatePath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* update state is non-critical — never break a caller on a write failure */
  }
}

/**
 * True when an auto-update already landed on disk that the `running` process
 * has NOT adopted yet — i.e. `last_applied.to` differs from the running
 * version. The daemon reads this each idle sweep to decide whether to recycle
 * idle per-repo proxies early so their next spawn picks up the new version.
 */
export function fleetUpgradePending(
  state: UpdateState,
  running: string
): boolean {
  return !!state.last_applied && state.last_applied.to !== running;
}
