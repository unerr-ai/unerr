/**
 * Delegation gate — Lever C (TOKEN_ECONOMICS_AND_SAVINGS §11.2 C4).
 *
 * Ties the three independent conditions that must all hold before unerr routes a
 * task to a cheaper model: (1) the host supports model delegation
 * (`supportsDelegation` — claude-code / codex only), (2) the feature flag is on
 * for that host (master `UNERR_DELEGATION`, refined per-provider by
 * `UNERR_DELEGATION_CLAUDE` / `UNERR_DELEGATION_CODEX`), and (3) the prompt names a
 * delegable task class (`classifyDelegable`). One call so the `unerr-delegate`
 * skill and any runtime consult the same decision.
 *
 * @sem domain=delegation role=gate
 */

import { supportsDelegation } from "../config/agent-registry.js";
import { isEnabled, resolveFlag } from "../config/feature-flags.js";
import type { IdeType } from "../utils/detect.js";
import {
  type DelegableClass,
  type DelegableVerdict,
  classifyDelegable,
} from "./delegable-task.js";

export interface DelegationDecision {
  /** True only when host support, the flag, and a delegable class all hold. */
  readonly delegate: boolean;
  /** The delegable class detected (or "none"). */
  readonly class: DelegableClass;
  /** One-line, human-readable justification for telemetry/debugging. */
  readonly reason: string;
}

export interface DelegationGateOptions {
  readonly agentId: IdeType;
  readonly prompt: string;
  readonly repoPath?: string;
}

/**
 * The per-provider sub-key for an agent, or undefined when the agent has no
 * dedicated refinement key. claude-code reads `UNERR_DELEGATION_CLAUDE`; codex
 * reads `UNERR_DELEGATION_CODEX`.
 */
function providerSubKey(
  agentId: IdeType
): "UNERR_DELEGATION_CLAUDE" | "UNERR_DELEGATION_CODEX" | undefined {
  if (agentId === "claude-code") return "UNERR_DELEGATION_CLAUDE";
  if (agentId === "codex") return "UNERR_DELEGATION_CODEX";
  return undefined;
}

/**
 * Resolve whether delegation is flag-enabled for a host: the per-provider sub-key
 * wins when explicitly set (on OR off), otherwise it inherits the master
 * `UNERR_DELEGATION` flag. So `UNERR_DELEGATION=1` enables both hosts, and adding
 * `UNERR_DELEGATION_CODEX=0` disables codex while leaving claude-code on.
 */
export function delegationFlagEnabled(
  agentId: IdeType,
  repoPath: string = process.cwd()
): boolean {
  const subKey = providerSubKey(agentId);
  if (subKey) {
    const sub = resolveFlag(subKey, repoPath);
    if (sub !== undefined) return sub;
  }
  return isEnabled("UNERR_DELEGATION", repoPath);
}

/**
 * Decide whether to delegate this task to a cheaper model. Returns `delegate:false`
 * with a specific reason whenever any of the three conditions fails, so callers can
 * surface why a task stayed with the senior.
 */
export function shouldDelegate(
  opts: DelegationGateOptions
): DelegationDecision {
  const repoPath = opts.repoPath ?? process.cwd();

  if (!supportsDelegation(opts.agentId)) {
    return {
      delegate: false,
      class: "none",
      reason: `${opts.agentId} has no delegation path`,
    };
  }
  if (!delegationFlagEnabled(opts.agentId, repoPath)) {
    return {
      delegate: false,
      class: "none",
      reason: "delegation flag off for this host",
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
