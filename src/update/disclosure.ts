/**
 * unerr auto-update — first-run disclosure (informed default-on).
 *
 * Auto-update ships default-on (`update.mode = auto`). Shipping a default-on
 * behaviour WITHOUT telling the user is the "silent opt-out" pattern that
 * erodes trust; the fix is to disclose it exactly once, passively, the first
 * time unerr is set up on a machine — then never again. The one-time flag is
 * `update.json:disclosed_at` (machine-wide, same store the rest of the update
 * subsystem uses), so install + first-run wizard share one source of truth.
 *
 * Pure body + a thin once-gate. Best-effort: a read/write failure never blocks
 * onboarding (HR-B) — the worst case is the notice shows again next setup.
 */

import { type UpdatePolicy, updatePolicy } from "./update-config.js";
import {
  type UpdateState,
  readUpdateState,
  writeUpdateState,
} from "./update-state.js";

export interface DisclosureDeps {
  state?: UpdateState;
  policy?: UpdatePolicy;
  readState?: () => UpdateState;
  writeState?: (patch: Partial<UpdateState>) => void;
  /** Timestamp stamped on the flag. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * The disclosure body — plain text lines (no ANSI), so each surface (the
 * install command's coloured output, the wizard's clack note) renders them in
 * its own style without re-stating the message. Imperative off-switch with the
 * exact command, per the CLAUDE.md nudge rules.
 */
export function buildDisclosureLines(): string[] {
  return [
    "Auto-update is on — unerr installs patch and minor updates automatically.",
    "It applies only when no editor is connected, health-checks the new build, and rolls back on failure.",
    "Major versions ask first. Change it any time in the unerr dashboard → Settings → Auto-update.",
  ];
}

/**
 * Emit the disclosure once per machine, then stamp `disclosed_at` so it never
 * repeats. No-op (returns false without emitting) when already disclosed or
 * when the policy is `off` (the user already disabled auto-update, so there is
 * nothing to disclose). `emit` receives one plain line at a time.
 */
export function discloseAutoUpdateOnce(
  emit: (line: string) => void,
  deps: DisclosureDeps = {}
): boolean {
  const state = deps.state ?? (deps.readState ?? readUpdateState)();
  if (state.disclosed_at) return false;
  const policy = deps.policy ?? updatePolicy();
  if (policy === "off") return false;

  for (const line of buildDisclosureLines()) emit(line);
  (deps.writeState ?? writeUpdateState)({
    disclosed_at: deps.now ?? Date.now(),
  });
  return true;
}
