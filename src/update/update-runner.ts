/**
 * unerr auto-update — the single orchestration entry the daemon calls.
 *
 * `unerrd`'s idle-sweep tick calls `runUpdateCycle()` fire-and-forget every
 * 60s. The call is the ONLY integration point between the process manager and
 * the update subsystem, so later phases extend the cycle WITHOUT touching the
 * daemon again:
 *  - U1: detection only — a throttled, offline-safe registry check that
 *    persists state. Fully silent.
 *  - U5 (now): after detection, gate on config + install-manager confidence +
 *    quiet + collision, then apply / health-check / rollback via `applyUpdate`.
 *
 * Never throws — a failed cycle must never break the idle sweep (HR-B).
 */

import { type ApplyOutcome, applyUpdate } from "./apply.js";
import { type UpdateCheckResult, checkForUpdate } from "./version-check.js";

export interface UpdateCycleDeps {
  /** The detection step. Defaults to the throttled `checkForUpdate`. */
  check?: () => Promise<UpdateCheckResult>;
  /** True when no IDE is connected — passed through to the apply gate. */
  isQuiet?: () => boolean;
  /** The apply step. Defaults to `applyUpdate`. */
  apply?: (latest: string) => Promise<ApplyOutcome>;
}

export interface UpdateCycleResult {
  check: UpdateCheckResult | null;
  apply: ApplyOutcome | null;
}

/**
 * Single-flight guard. The idle sweep fires `runUpdateCycle` every 60s but an
 * install can outlast that interval — without this, a second sweep could spawn
 * a concurrent `npm i -g`. Module-scoped because there is exactly one daemon
 * (the single per-machine writer), so one flag is the right granularity.
 */
let applying = false;

/**
 * Run one update cycle: detect (throttled), then — when an eligible update is
 * known and no apply is already in flight — attempt to apply it. Returns the
 * check + apply outcomes for callers/tests; the daemon ignores them.
 * Best-effort, never throws.
 */
export async function runUpdateCycle(
  deps: UpdateCycleDeps = {}
): Promise<UpdateCycleResult> {
  let check: UpdateCheckResult | null = null;
  try {
    check = await (deps.check ?? (() => checkForUpdate()))();
  } catch {
    // Detection failure is silent — the running version keeps working.
    return { check: null, apply: null };
  }

  // Apply only when detection surfaced a strictly-newer version. `applyUpdate`
  // re-checks every gate (semver/policy/manager/quiet/collision) itself, so this
  // is only the cheap "is there anything to even try?" pre-filter.
  if (!check || check.kind === "none" || !check.latest) {
    return { check, apply: null };
  }

  if (applying)
    return {
      check,
      apply: { status: "skipped", reason: "apply already in flight" },
    };
  applying = true;
  try {
    const run =
      deps.apply ??
      ((latest: string) => applyUpdate({ latest, isQuiet: deps.isQuiet }));
    return { check, apply: await run(check.latest) };
  } catch {
    return { check, apply: null };
  } finally {
    applying = false;
  }
}
