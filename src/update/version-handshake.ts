/**
 * unerr auto-update — U4: bridge↔daemon version skew policy.
 *
 * The bridge (`unerr --mcp`) is fresh-spawned by the IDE every session, so it
 * always runs the on-disk version. The daemon (`unerrd`) is long-lived, so
 * after a manual or auto upgrade it can still be running STALE in-memory code.
 * On connect the daemon reports its running version; this module decides what
 * the bridge does about any skew (.internal/archive/AUTO_UPDATE_STRATEGY.md §9 U4):
 *
 *  - `ok`       → versions match, the daemon is AHEAD, or a version is
 *                 unparseable — do nothing. We never downgrade a daemon from a
 *                 stale bridge, and never act on garbage.
 *  - `converge` → bridge is NEWER and same-major (the stale-daemon-after-upgrade
 *                 case). The protocol is compatible, so the bridge shuts the
 *                 stale daemon down; its existing discovery loop then re-spawns
 *                 a fresh daemon (and fresh per-repo children) on the new
 *                 on-disk version. Never breaks the session — worst case is a
 *                 brief reconnect.
 *  - `surface`  → bridge is NEWER but CROSS-major. A major may carry a breaking
 *                 protocol/state change, so we do NOT auto-restart mid-session;
 *                 the skew is surfaced for an explicit `unerr pm restart`.
 *
 * Pure + total — every input maps to a decision, never throws.
 */

import { compareCore, parseSemver } from "./semver.js";

export type SkewAction = "ok" | "converge" | "surface";

export interface SkewDecision {
  action: SkewAction;
  reason: string;
  bridge: string;
  daemon: string;
}

/**
 * Decide what the bridge does about a bridge/daemon version skew. `bridge` is
 * the running `unerr --mcp` version, `daemon` is the version the daemon
 * reported on the ensure handshake.
 */
export function classifyVersionSkew(
  bridge: string,
  daemon: string
): SkewDecision {
  const b = parseSemver(bridge);
  const d = parseSemver(daemon);
  if (!b || !d) {
    return {
      action: "ok",
      reason: "version unparseable — no skew action",
      bridge,
      daemon,
    };
  }

  const cmp = compareCore(b, d); // bridge vs daemon
  if (cmp === 0) {
    return { action: "ok", reason: "versions match", bridge, daemon };
  }
  if (cmp < 0) {
    // Bridge is OLDER than the daemon — the daemon is ahead. Never downgrade
    // the daemon from a stale bridge; the IDE respawns a fresh bridge anyway.
    return {
      action: "ok",
      reason: `daemon ${daemon} is ahead of bridge ${bridge} — no action`,
      bridge,
      daemon,
    };
  }

  // Bridge is NEWER than the daemon — the daemon is stale (post-upgrade).
  if (b.major === d.major) {
    return {
      action: "converge",
      reason: `daemon ${daemon} is stale; bridge ${bridge} is same-major — restart the daemon to converge`,
      bridge,
      daemon,
    };
  }
  return {
    action: "surface",
    reason: `daemon ${daemon} vs bridge ${bridge} is a cross-major skew — run \`unerr pm restart\``,
    bridge,
    daemon,
  };
}
