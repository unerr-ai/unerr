/**
 * Delegation gate — routes a task to a cheaper model when two conditions both
 * hold: (1) the host supports model delegation (`supportsDelegation` —
 * claude-code / codex only), and (2) the prompt names a delegable task class
 * (`classifyDelegable`). One call so the `unerr-delegate` skill and any runtime
 * consult the same decision.
 *
 * @sem domain=delegation role=gate
 */

import { supportsDelegation } from "../config/agent-registry.js";
import type { IdeType } from "../utils/detect.js";
import {
  type DelegableClass,
  type DelegableVerdict,
  classifyDelegable,
} from "./delegable-task.js";

export interface DelegationDecision {
  /** True only when host support and a delegable class both hold. */
  readonly delegate: boolean;
  /** The delegable class detected (or "none"). */
  readonly class: DelegableClass;
  /** One-line, human-readable justification for telemetry/debugging. */
  readonly reason: string;
}

export interface DelegationGateOptions {
  readonly agentId: IdeType;
  readonly prompt: string;
}

/**
 * Decide whether to delegate this task to a cheaper model. Returns `delegate:false`
 * with a specific reason whenever either condition fails, so callers can surface
 * why a task stayed with the senior.
 */
export function shouldDelegate(
  opts: DelegationGateOptions
): DelegationDecision {
  if (!supportsDelegation(opts.agentId)) {
    return {
      delegate: false,
      class: "none",
      reason: `${opts.agentId} has no delegation path`,
    };
  }
  const verdict: DelegableVerdict = classifyDelegable(opts.prompt);
  if (!verdict.delegable) {
    return { delegate: false, class: "none", reason: verdict.reason };
  }
  return { delegate: true, class: verdict.class, reason: verdict.reason };
}

export interface DelegationIntent {
  /** The delegable class (never "none"). */
  readonly class: Exclude<DelegableClass, "none">;
  /** True when the handoff was a many-site sweep (vs a single-entity edit). */
  readonly sweep: boolean;
}

/** The delegable classes a delegation intent can name, longest-first so a
 *  substring match never shadows a more specific class. */
const INTENT_CLASSES: ReadonlyArray<Exclude<DelegableClass, "none">> = [
  "mechanical_refactor",
  "lint_format",
  "tests",
  "docs",
  "recon",
];

/**
 * Parse a delegation telemetry signal out of an `unerr-save: intent` marker. The
 * `unerr-delegate` skill emits `intent delegate <class>[ sweep]: <task>`, so a
 * delegation is recognised only when the text begins with `delegate` AND names a
 * delegable class. Returns null for any non-delegation intent. Pure + total —
 * never throws; this is the deterministic emit point for the `delegated_edit` /
 * `delegated_sweep` behavior_events (Lever C C6).
 */
export function parseDelegationIntent(text: string): DelegationIntent | null {
  const lower = (text ?? "").trim().toLowerCase();
  if (!lower.startsWith("delegate")) return null;
  const cls = INTENT_CLASSES.find((c) => lower.includes(c));
  if (!cls) return null;
  return { class: cls, sweep: /\bsweep\b/.test(lower) };
}
