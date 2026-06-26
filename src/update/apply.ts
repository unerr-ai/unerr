/**
 * unerr auto-update — U5: the careful apply + rollback path.
 *
 * Runs ONLY inside `unerrd` (the single per-machine writer, serialized by the
 * spawn-lock) off the idle-sweep tick, and ONLY through a stack of gates that
 * make a bad apply impossible (AUTO_UPDATE_STRATEGY.md §4 + §7):
 *
 *   1. semver boundary  — patch/minor only; a major is notify-only, never auto.
 *                         On the `beta` channel a prerelease candidate is
 *                         auto-eligible (beta→beta, beta→stable); `stable` never.
 *   2. policy           — config must resolve to `auto` (§6/§8).
 *   3. install manager  — must be `self_upgradable`: an npm/pnpm-global with a
 *                         writable root, or a `binary` install (curl|bash native
 *                         binary, swapped in place via self-replace). Everything
 *                         else — incl. npm/pnpm on Windows (running-.exe lock) —
 *                         is notify-only (§3, the central risk).
 *   4. idempotency      — never re-install a version already applied (awaiting
 *                         restart) or one that previously failed its health check.
 *   5. quiet            — no IDE connected (apply in the quiet window, §4).
 *   6. collision        — no foreign npm/pnpm/yarn/brew install in flight (§7).
 *
 * Then: run the manager's pinned install → health-check the new binary → on pass
 * pin last-known-good + record the applied transition; on FAIL roll back to the
 * last-known-good and record the rollback (U3 surfaces it). The running daemon
 * keeps serving the old version throughout; convergence to the new version
 * happens via the U4 handshake on the next bridge connect, or the 30-min
 * idle-exit — never a forced mid-session restart (HR-B: never break local).
 *
 * Pure orchestration + fully injectable I/O (install runner, health check,
 * state store, quiet + collision probes), so every branch is tested without a
 * real install. Never throws.
 */

import { UNERR_VERSION } from "../version.js";
import {
  type CollisionResult,
  isPackageManagerBusy,
} from "./collision-guard.js";
import {
  type InstallClassification,
  classifyInstall,
} from "./install-manager.js";
import { classifyUpdate } from "./semver.js";
import {
  type UpdatePolicy,
  resolveChannel,
  updatePolicy,
} from "./update-config.js";
import {
  type UpdateState,
  readUpdateState,
  writeUpdateState,
} from "./update-state.js";
import {
  type InstallRunResult,
  acquireBinary,
  healthCheckBinary,
} from "./upgrade-flow.js";

// The install/replace/health-check primitives live once in upgrade-flow.ts and
// are shared with the manual `unerr upgrade` command (no duplicate upgrade logic).
export type { InstallRunResult };

export type ApplyOutcome =
  | { status: "skipped"; reason: string }
  | { status: "applied"; from: string; to: string }
  | { status: "rolled_back"; from: string; to: string; restored: boolean }
  | { status: "failed"; reason: string };

export interface ApplyDeps {
  /** The running version. Defaults to `UNERR_VERSION`. */
  current?: string;
  /** The candidate version. Defaults to the persisted `latest_version`. */
  latest?: string;
  /**
   * Release channel — `beta` makes prerelease candidates auto-eligible (Gate 1).
   * Defaults to the local `update.channel` setting (else `stable`).
   */
  channel?: "stable" | "beta";
  policy?: UpdatePolicy;
  classification?: InstallClassification;
  /** True when no IDE is connected — safe to apply. Defaults to always-quiet. */
  isQuiet?: () => boolean;
  /** Foreign-package-manager probe. Defaults to `isPackageManagerBusy`. */
  isBusy?: () => CollisionResult;
  /** Run a `npm/pnpm install -g` command to completion. */
  runInstall?: (cmd: string) => Promise<InstallRunResult>;
  /** Replace the running native binary in place (the `binary` install path). */
  selfReplaceImpl?: (version: string) => Promise<InstallRunResult>;
  /** Verify the freshly-installed binary reports `expected`. */
  healthCheck?: (expected: string) => Promise<boolean>;
  readState?: () => UpdateState;
  writeState?: (patch: Partial<UpdateState>) => void;
  /** Timestamp for recorded transitions. Defaults to `Date.now()`. */
  now?: number;
}

/** First line of `output`, capped — keep failure reasons short for the log/state. */
function brief(output: string, max = 200): string {
  return (output.split("\n")[0] ?? "").slice(0, max);
}

/**
 * Attempt one auto-apply. Returns a structured outcome; the daemon logs it and
 * the persisted state drives U3 surfacing. Every early `skipped` is a deliberate
 * gate, not a failure.
 */
export async function applyUpdate(deps: ApplyDeps = {}): Promise<ApplyOutcome> {
  const current = deps.current ?? UNERR_VERSION;
  const state = (deps.readState ?? readUpdateState)();
  const latest = deps.latest ?? state.latest_version;
  if (!latest) return { status: "skipped", reason: "no latest version known" };

  // Gate 1 — semver boundary. On the `beta` channel a prerelease candidate is
  // auto-eligible (beta→beta, beta→stable); on `stable` it never is.
  const channel = deps.channel ?? resolveChannel();
  const kind = classifyUpdate(current, latest, {
    allowPrerelease: channel === "beta",
  });
  if (kind === "none")
    return { status: "skipped", reason: "already current or newer" };
  if (kind === "major")
    return { status: "skipped", reason: "major version is notify-only" };

  // Gate 2 — policy.
  const policy = deps.policy ?? updatePolicy();
  if (policy !== "auto")
    return { status: "skipped", reason: `update policy is ${policy}` };

  // Gate 3 — install-manager confidence.
  const cls = deps.classification ?? classifyInstall();
  if (cls.mode !== "self_upgradable")
    return {
      status: "skipped",
      reason: cls.reason ?? "install is notify-only",
    };

  // Gate 4 — idempotency: don't re-install an already-applied or known-bad version.
  if (state.last_applied?.to === latest)
    return {
      status: "skipped",
      reason: `already applied ${latest}; awaiting daemon restart`,
    };
  if (state.last_rollback?.to === latest)
    return {
      status: "skipped",
      reason: `${latest} previously failed its health check; staying on ${current}`,
    };

  // Gate 5 — quiet window (no IDE connected).
  if (deps.isQuiet && !deps.isQuiet())
    return {
      status: "skipped",
      reason: "an IDE session is active — deferring",
    };

  // Gate 6 — foreign package-manager collision.
  const busy = (deps.isBusy ?? (() => isPackageManagerBusy()))();
  if (busy.busy)
    return { status: "skipped", reason: busy.reason ?? "package manager busy" };

  const acquire = (version: string) =>
    acquireBinary(cls, version, {
      runInstall: deps.runInstall,
      selfReplaceImpl: deps.selfReplaceImpl,
    });
  const healthCheck = deps.healthCheck ?? healthCheckBinary;
  const writeState = deps.writeState ?? writeUpdateState;
  const at = deps.now ?? Date.now();

  // Stage the apply.
  writeState({ pending_version: latest });
  const install = await acquire(latest);
  if (!install.ok) {
    // Nothing was swapped under us — drop the pending marker, stay on current.
    writeState({ pending_version: undefined });
    return {
      status: "failed",
      reason: `install failed: ${brief(install.output)}`,
    };
  }

  // Health-check the freshly-installed binary before trusting it.
  if (await healthCheck(latest)) {
    writeState({
      current_version: current,
      last_applied: { from: current, to: latest, at },
      last_good_version: latest,
      latest_kind: kind,
      pending_version: undefined,
    });
    return { status: "applied", from: current, to: latest };
  }

  // Health-check failed → roll back to the last-known-good (or the version we
  // were running) and record it so U3 surfaces a loud rollback line.
  const good = state.last_good_version ?? current;
  const restore = await acquire(good);
  writeState({
    last_rollback: { from: good, to: latest, at },
    pending_version: undefined,
  });
  return {
    status: "rolled_back",
    from: good,
    to: latest,
    restored: restore.ok,
  };
}
