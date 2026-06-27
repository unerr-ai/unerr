/**
 * unerr auto-update — U3: surfacing (never silent).
 *
 * Renders the persisted update state into the same three channels the login
 * doc uses, so an applied/available/rolled-back update is never a silent
 * change (AUTO_UPDATE_STRATEGY.md §6):
 *  - `updateSignal()` → the in-band `ur|fct`/`ur|act` line the proxy appends
 *    (deduped once per session per event), naming the EXACT manager command.
 *  - `updateStatusPanel()` → the structured payload for `unerr status` + the
 *    local UI (current/latest/channel/last-checked/pending/applied/rolled-back).
 *  - `updateStatusLine()` → a one-line resting summary.
 *
 * Every line obeys the CLAUDE.md nudge rules (imperative + exact command, no
 * hedge verbs, no deictic pronouns, real version numbers). Pure + injectable.
 */

import { UNERR_VERSION } from "../version.js";
import {
  type InstallClassification,
  classifyInstall,
  upgradeCommand,
} from "./install-manager.js";
import { type ReleaseKind, classifyUpdate } from "./semver.js";
import {
  type UpdatePolicy,
  resolveChannel,
  updatePolicy,
} from "./update-config.js";
import { type UpdateState, readUpdateState } from "./update-state.js";

// Releases are published to the PUBLIC unerr repo (unerr-cli is private,
// so its own release pages aren't visible to end users).
const REPO_URL = "https://github.com/unerr-ai/unerr";

/** GitHub release-notes URL for a version (the `v`-tagged release). */
export function releaseNotesUrl(version: string): string {
  return `${REPO_URL}/releases/tag/v${version}`;
}

export interface UpdateSignal {
  tag: "act" | "fct";
  content: string;
  dedupKey: string;
  /** The version this signal is about (drives the persistent available-line throttle). */
  version?: string;
}

/** Default throttle for the notify-only "available" line: surface at most once/day. */
export const DEFAULT_AVAILABLE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Daily throttle decision for the notify-only "available" line. The in-band
 * signal is session-deduped, but a notify-only install (Homebrew/Volta) or
 * policy `notify` would otherwise re-surface the same "available" line every
 * new IDE session. True when it should surface now: never surfaced, a different
 * version than last time (a new release resets the throttle), or >= the
 * interval since the last surface. Pure.
 */
export function shouldSurfaceAvailable(
  state: UpdateState,
  version: string,
  now: number,
  intervalMs: number = DEFAULT_AVAILABLE_THROTTLE_MS
): boolean {
  if (state.available_notified_version !== version) return true;
  if (state.available_notified_at == null) return true;
  return now - state.available_notified_at >= intervalMs;
}

export interface UpdateSurfaceDeps {
  state?: UpdateState;
  current?: string;
  policy?: UpdatePolicy;
  channel?: "stable" | "beta";
  classification?: InstallClassification;
}

/** Resolve the shared inputs once, honouring injected overrides. */
function resolve(deps: UpdateSurfaceDeps) {
  const channel = deps.channel ?? resolveChannel();
  return {
    state: deps.state ?? readUpdateState(),
    current: deps.current ?? UNERR_VERSION,
    policy: deps.policy ?? updatePolicy(),
    channel,
    /** On `beta`, a prerelease `latest_version` is a real, surfaceable update. */
    allowPrerelease: channel === "beta",
  };
}

/**
 * The in-band line for the current update state, or null when there's nothing
 * to say (up to date, policy `off`, or an update that WILL auto-apply — whose
 * result surfaces as an `applied` line next session instead). Priority:
 * rollback (loud) → available-notify (loud) → applied (quiet).
 */
export function updateSignal(
  deps: UpdateSurfaceDeps = {}
): UpdateSignal | null {
  const { state, current, policy, allowPrerelease } = resolve(deps);
  if (policy === "off") return null;

  // 1. Rollback — a release failed its health check and was reverted. Loud.
  if (state.last_rollback && state.last_rollback.from === current) {
    const r = state.last_rollback;
    return {
      tag: "act",
      content: `unerr ${r.to} failed its health check and was rolled back to ${r.from} — staying on ${r.from}; release notes: ${releaseNotesUrl(r.from)}`,
      dedupKey: `rollback:${r.to}`,
      version: r.to,
    };
  }

  // 2. A newer version we will NOT auto-apply (major, notify-only install, or
  //    policy `notify`) → name the exact command. Loud, actionable.
  const latest = state.latest_version;
  if (latest) {
    const kind = classifyUpdate(current, latest, { allowPrerelease });
    if (kind !== "none") {
      const cls = deps.classification ?? classifyInstall();
      const wouldAutoApply =
        policy === "auto" &&
        cls.mode === "self_upgradable" &&
        (kind === "patch" || kind === "minor");
      if (!wouldAutoApply) {
        const cmd = upgradeCommand(cls.manager, latest);
        return {
          tag: "act",
          content: `run \`${cmd}\` — unerr ${latest} available (${kind}; release notes: ${releaseNotesUrl(latest)})`,
          dedupKey: `available:${latest}`,
          version: latest,
        };
      }
    }
  }

  // 3. An auto-upgrade landed and we're now running it — report once. Quiet.
  if (state.last_applied && state.last_applied.to === current) {
    const a = state.last_applied;
    const kind = classifyUpdate(a.from, a.to);
    return {
      tag: "fct",
      content: `unerr auto-updated ${a.from} → ${a.to} (${kind}) — release notes: ${releaseNotesUrl(a.to)}`,
      dedupKey: `applied:${a.to}`,
      version: a.to,
    };
  }

  return null;
}

/** The coarse update state, for the status panel + UI badge. */
export type UpdateStatusKind =
  | "disabled"
  | "up-to-date"
  | "available"
  | "pending"
  | "rolled-back";

export interface UpdateStatusPanel {
  current: string;
  latest: string | null;
  kind: ReleaseKind;
  status: UpdateStatusKind;
  policy: UpdatePolicy;
  manager: InstallClassification["manager"];
  mode: InstallClassification["mode"];
  /** The exact upgrade command for the detected manager (null when up to date). */
  upgradeCommand: string | null;
  /** Epoch ms of the last registry check, or null when never checked. */
  lastCheckedAt: number | null;
  pendingVersion: string | null;
}

/** Structured update status for `unerr status` + the dashboard UI. */
export function updateStatusPanel(
  deps: UpdateSurfaceDeps = {}
): UpdateStatusPanel {
  const { state, current, policy, allowPrerelease } = resolve(deps);
  const cls = deps.classification ?? classifyInstall();
  const latest = state.latest_version ?? null;
  const kind = latest
    ? classifyUpdate(current, latest, { allowPrerelease })
    : "none";

  let status: UpdateStatusKind;
  if (policy === "off") status = "disabled";
  else if (state.last_rollback && state.last_rollback.from === current)
    status = "rolled-back";
  else if (state.pending_version && state.pending_version !== current)
    status = "pending";
  else if (kind !== "none") status = "available";
  else status = "up-to-date";

  return {
    current,
    latest,
    kind,
    status,
    policy,
    manager: cls.manager,
    mode: cls.mode,
    upgradeCommand:
      kind !== "none" ? upgradeCommand(cls.manager, latest ?? undefined) : null,
    lastCheckedAt: state.last_checked_at ?? null,
    pendingVersion: state.pending_version ?? null,
  };
}

/** A one-line resting summary for `unerr status`. */
export function updateStatusLine(deps: UpdateSurfaceDeps = {}): string {
  const p = updateStatusPanel(deps);
  switch (p.status) {
    case "disabled":
      return `unerr ${p.current} — auto-update disabled`;
    case "rolled-back":
      return `unerr ${p.current} — last update rolled back (health check failed)`;
    case "pending":
      return `unerr ${p.current} — ${p.pendingVersion} staged, applies on next restart`;
    case "available":
      return `unerr ${p.current} — ${p.latest} available (${p.kind}); ${p.upgradeCommand}`;
    case "up-to-date":
      return `unerr ${p.current} — up to date`;
  }
}
