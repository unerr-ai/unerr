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
 * Parse a delegation telemetry signal out of a delegation intent string. The
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

/** Bulk-edit outcome a marker can name (Issue 4a). `oneshot` = one command or
 *  script covered the whole set; `cheap_loop` = the edit fell to a worker loop
 *  but still ran off the senior. */
export type BulkEditMode = "oneshot" | "cheap_loop";

export interface BulkEditIntent {
  /** Which batching rung the agent landed on. */
  readonly mode: BulkEditMode;
  /** Files the bulk edit covered (0 when the marker omits the count). */
  readonly files: number;
}

/** First integer in the marker text — the file/target count when present. */
const FIRST_INT = /(\d+)/;

/**
 * Parse an Issue-4a bulk-edit signal out of a delegation intent string. The
 * batch-work skill emits `intent bulk-edit oneshot <N>: <task>` (one command /
 * script) or `intent bulk-edit cheap-loop <N>: <task>` (worker loop). Returns
 * null for any non-bulk-edit intent. When neither mode word is present but the
 * text is clearly a bulk edit, defaults to `oneshot` (the common best path).
 * Pure + total — never throws.
 */
export function parseBulkEditIntent(text: string): BulkEditIntent | null {
  const lower = (text ?? "").trim().toLowerCase();
  if (!/^bulk[-_ ]?edit\b/.test(lower)) return null;
  const oneshot = /\bone[-_ ]?shot\b/.test(lower);
  const cheap = /\b(cheap|worker|loop)\b/.test(lower);
  const mode: BulkEditMode = cheap && !oneshot ? "cheap_loop" : "oneshot";
  const m = lower.match(FIRST_INT);
  const files = m?.[1] ? Number.parseInt(m[1], 10) : 0;
  return { mode, files: Number.isFinite(files) ? files : 0 };
}

export interface BatchCallIntent {
  /** Targets fetched in one call (>= 2 — a single target saves nothing). */
  readonly targets: number;
}

/**
 * Parse an Issue-4b batch-call signal out of a delegation intent string. The
 * batch-work skill emits `intent batch-call <N>: <task>` when N independent
 * reads/edits were issued as one call (or one parallel message) instead of N
 * round-trips. Returns null when the text is not a batch-call or names fewer
 * than 2 targets (no saving). Pure + total — never throws.
 */
export function parseBatchCallIntent(text: string): BatchCallIntent | null {
  const lower = (text ?? "").trim().toLowerCase();
  if (!/^batch[-_ ]?call\b/.test(lower)) return null;
  const m = lower.match(FIRST_INT);
  const targets = m?.[1] ? Number.parseInt(m[1], 10) : 0;
  if (!Number.isFinite(targets) || targets < 2) return null;
  return { targets };
}

/**
 * The model tier a delegation runs on, below the senior. `worker` is the
 * `unerr-worker` sub-agent (Sonnet / gpt-5.4) — work that needs some judgement;
 * `junior` is the cheapest tier, the `unerr-junior` sub-agent (Haiku /
 * gpt-5.4-mini) — brainless work. The senior tier never appears here: by
 * definition a delegation marker means the senior did NOT keep the work.
 */
export type DelegationTier = "worker" | "junior";

/**
 * Route a delegable class to its model tier. Kept consistent with `selectTier`
 * (the authoritative router in junior-agent.ts): the scoped-write classes that
 * need a correctness check (tests, mechanical_refactor, codemod, caller_propagation,
 * typecheck_fix, scaffold, feature_impl, dependency_upgrade, migration_script) →
 * worker; every read-only / trivially-mechanical class (recon, research, qa_lookup,
 * inventory_audit, log_triage, repro, docs, lint_format, verify, command_run,
 * code_review, security_audit, git_ops, benchmark_run) → the cheapest junior tier.
 */
export function tierForDelegationClass(
  cls: Exclude<DelegableClass, "none">
): DelegationTier {
  switch (cls) {
    case "tests":
    case "mechanical_refactor":
    case "codemod":
    case "caller_propagation":
    case "typecheck_fix":
    case "scaffold":
    case "feature_impl":
    case "dependency_upgrade":
    case "migration_script":
      return "worker";
    default:
      return "junior";
  }
}
