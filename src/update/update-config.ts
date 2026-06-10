/**
 * unerr auto-update — the resolved policy (local config + env + tier claim).
 *
 * Three states (mirrors rustup's enable/disable/check-only; named for unerr):
 *  - `auto`   → detect + auto-apply minor/patch + notify for major/notify-only.
 *  - `notify` → detect + notify only; never auto-applies.
 *  - `off`    → fully disabled: no detection, no notify, no apply.
 *
 * Precedence (AUTO_UPDATE_STRATEGY.md §7 + §8): a server-side entitlement pin
 * (enterprise change-control) wins over everything; then the `UNERR_NO_AUTO_
 * UPDATE` env opt-out (downgrades `auto`→`notify`, never weakens an explicit
 * `off`); then the local `update.mode` setting; else the `auto` default.
 *
 * Pure + injectable, never throws.
 */

import { readEntitlementCache } from "../cloud/entitlements.js";
import { loadSettings } from "../config/settings.js";

export type UpdatePolicy = "auto" | "notify" | "off";

export interface UpdatePolicyDeps {
  /** The local `update.mode` setting. Defaults to `loadSettings()`. */
  configMode?: UpdatePolicy;
  env?: NodeJS.ProcessEnv;
  /**
   * The server entitlement update channel, when the signed claim carries one
   * (U6 server). `pinned` means an org pins versions — auto-apply is governed
   * by the pin, so locally we never *auto* on our own; we surface (notify).
   */
  serverChannel?: "stable" | "pinned" | undefined;
}

/** Read the local `update.mode` setting (default `auto`). Never throws. */
function localMode(): UpdatePolicy {
  try {
    return loadSettings().update.mode;
  } catch {
    return "auto";
  }
}

function envOptOut(env: NodeJS.ProcessEnv): boolean {
  const v = env.UNERR_NO_AUTO_UPDATE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Read the org's update channel from the VERIFIED entitlement claim, when one
 * is present (U6 enterprise control, §8). An additive claim key — absent on
 * free/older tokens, so the common path returns undefined. Never throws.
 */
function serverUpdateChannel(): "stable" | "pinned" | undefined {
  try {
    const ch = readEntitlementCache()?.claims?.update_channel;
    return ch === "pinned" || ch === "stable" ? ch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective update policy. A server `pinned` channel forces
 * `notify` (the daemon converges to the pin under U5/U6, never auto-chases
 * npm); the env opt-out downgrades `auto`→`notify`; an explicit local `off`
 * is never weakened.
 */
export function updatePolicy(deps: UpdatePolicyDeps = {}): UpdatePolicy {
  const env = deps.env ?? process.env;
  const mode = deps.configMode ?? localMode();

  if (mode === "off") return "off";

  // Enterprise pin: don't auto-chase npm; surface only (U6 governs convergence).
  const channel = deps.serverChannel ?? serverUpdateChannel();
  if (channel === "pinned") return "notify";

  if (envOptOut(env)) return "notify";

  return mode;
}
