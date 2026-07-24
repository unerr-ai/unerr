/**
 * Consolidated savings-activation events (Issue 8) — ONE place to record what
 * every lever (Issues 1–7) saved, prevented, routed, or leaked. New capabilities
 * call {@link emitSavingsEvent} with a new `kind`; they do NOT add a behavior_event
 * type, a table, or a drainer. Each event is written as a single
 * `type:"savings_event"` behavior_event whose `detail.kind` names the lever and
 * `detail.category` buckets it, so the existing spine carries it unchanged:
 *
 *   emitSavingsEvent → behavior_events → NamedEvent phrasing → drainer → cloud.
 *
 * The drainer already validates each row against `@unerr-ai/contracts`; the
 * `SavingsEvent` contract record is the additive wire shape (landed per the
 * cross-repo change order — contract repo first, then the submodule bump).
 *
 */

import type { BehaviorEventInput } from "./behavior-events.js";

/** The four buckets every savings event falls into. */
export type SavingsEventCategory =
  | "savings" // tokens / round-trips / files avoided
  | "prevention" // a worse path was blocked
  | "routing" // a decision was taken (which model / repo / route)
  | "leak"; // the gap we want to drive to zero

/**
 * The fixed savings-event vocabulary — every lever's event from Issues 1–7. Add a
 * new member here (and one row in {@link KIND_CATEGORY}) when a capability needs a
 * new event; nothing else changes.
 */
export type SavingsEventKind =
  // ── savings ──────────────────────────────────────────────────────────
  | "batch_call_saved_roundtrips" // Issue 4b: N targets in 1 call
  | "bulk_edit_oneshot" // Issue 4a: one command/script replaced an N-file loop
  | "bulk_edit_cheap_loop" // Issue 4a: fell to a worker loop (still off the master)
  | "search_code_context_inlined" // Issue 2: match carried context → no follow-up read
  | "search_code_regex_served" // Issue 2: a literal/regex content search ran in-tool (grep replaced)
  | "delegated_to_junior" // Issue 5: sub-task ran on a cheaper tier
  | "worker_batch_parallel" // Issue 5: N workers spawned for one group
  | "recon_in_cheap_subagent" // Issue 5: read-only recon on a worker model
  | "cross_repo_routed" // Issue 1: a sibling-repo call served by the graph
  | "injection_suppressed" // Issue 6/7: a redundant injection was withheld
  // ── prevention ───────────────────────────────────────────────────────
  | "grep_redirected_to_search_code" // Issue 2: grep nudged/denied → search_code
  | "full_file_read_denied" // a wasteful full-file Read was denied
  | "nudge_flipped_to_builtin" // Issue 2: unerr degraded → use built-in tools
  // ── routing ──────────────────────────────────────────────────────────
  | "harness_subagent_model" // Issue 5/D2: which model a spawned sub-agent used
  | "conversation_routed" // Issue 7: policy chose a non-default route
  | "cross_repo_yielded_free" // Issue 1: sibling not Pro → yielded to the agent
  | "cross_repo_yielded_unregistered" // Issue 1: sibling not registered → yielded
  // ── leak ─────────────────────────────────────────────────────────────
  | "code_grep_unredirected" // Issue 2: a code grep leaked to bash
  | "reread_due_to_budget" // Issue 4b/D3: read-small-then-re-read waste
  | "one_shot_refire_detected"; // Issue 6: a one-shot nudge re-fired

/** kind → category. Exhaustive: a missing kind is a compile error. */
export const KIND_CATEGORY: Record<SavingsEventKind, SavingsEventCategory> = {
  batch_call_saved_roundtrips: "savings",
  bulk_edit_oneshot: "savings",
  bulk_edit_cheap_loop: "savings",
  search_code_context_inlined: "savings",
  search_code_regex_served: "savings",
  delegated_to_junior: "savings",
  worker_batch_parallel: "savings",
  recon_in_cheap_subagent: "savings",
  cross_repo_routed: "savings",
  injection_suppressed: "savings",
  grep_redirected_to_search_code: "prevention",
  full_file_read_denied: "prevention",
  nudge_flipped_to_builtin: "prevention",
  harness_subagent_model: "routing",
  conversation_routed: "routing",
  cross_repo_yielded_free: "routing",
  cross_repo_yielded_unregistered: "routing",
  code_grep_unredirected: "leak",
  reread_due_to_budget: "leak",
  one_shot_refire_detected: "leak",
};

/** Quantified savings + context carried on the event. All optional. */
export interface SavingsEventPayload {
  /** Estimated tokens avoided (reuse `calculateTokenSavings` at the call site). */
  readonly tokens_saved?: number;
  /** Round-trips avoided (N targets in one call → N−1). */
  readonly roundtrips_saved?: number;
  /** Files a one-shot edit/read covered instead of N separate ops. */
  readonly files_saved?: number;
  /** The model/tier a delegated or routed step used. */
  readonly model?: string;
  readonly tier?: "senior" | "worker" | "junior";
  /** The tool the event relates to (search_code, file_edit, …). */
  readonly tool?: string;
  /** Free-form extra context (kept small — it is JSON-stringified into detail). */
  readonly note?: string;
}

/** The minimal writer surface emitSavingsEvent needs (the BehaviorEventWriter). */
export interface SavingsEventSink {
  record(input: BehaviorEventInput): void;
}

/**
 * Record one savings-activation event through the existing behavior-event spine.
 * Maps the `kind` to its category, stamps the payload into `detail`, and writes a
 * single `type:"savings_event"` row. Best-effort — `record` itself never throws,
 * and a null/absent sink is a silent no-op so a missing writer never breaks a hot
 * path. Returns true when a row was emitted.
 */
export function emitSavingsEvent(
  sink: SavingsEventSink | null | undefined,
  kind: SavingsEventKind,
  opts: { session_id: string; turn?: number } & SavingsEventPayload
): boolean {
  if (!sink) return false;
  const { session_id, turn, tool, ...rest } = opts;
  const input: BehaviorEventInput = {
    session_id,
    type: "savings_event",
    tool: tool ?? null,
    entity_key: null,
    response_bytes: null,
    detail: { kind, category: KIND_CATEGORY[kind], ...rest },
    ...(turn !== undefined ? { turn } : {}),
  };
  try {
    sink.record(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire the Issue-5 delegation savings family from one parsed `delegate <class>`
 * marker. A single delegation lights up several dormant kinds at once so the
 * activation audit can SEE delegation firing instead of inferring it:
 *   - `harness_subagent_model` (routing) — which tier ran the sub-task.
 *   - `delegated_to_junior` (savings) — a sub-task ran off the master, on a
 *     cheaper tier.
 *   - `recon_in_cheap_subagent` — only for a read-only recon handoff.
 *   - `worker_batch_parallel` — only when the handoff was a parallel sweep.
 * Best-effort: each emit is a silent no-op on a null sink. Returns the count of
 * rows actually emitted. The tier is resolved by the caller (see
 * `tierForDelegationClass`) so this stays agnostic of the class taxonomy.
 */
export function emitDelegationSavings(
  sink: SavingsEventSink | null | undefined,
  opts: {
    session_id: string;
    turn?: number;
    delegable_class: string;
    sweep: boolean;
    tier: "worker" | "junior";
    /** The tool/source this delegation came through. Defaults to the
     *  `mark_intent` marker path (Claude Code); the cross-agent shell-exec
     *  meter passes `<host> exec` so the dashboard can tell the two apart. */
    tool?: string;
  }
): number {
  const { session_id, turn, delegable_class, sweep, tier } = opts;
  const base: { session_id: string; turn?: number; tool: string } = {
    session_id,
    tool: opts.tool ?? "mark_intent",
    ...(turn !== undefined ? { turn } : {}),
  };
  let emitted = 0;
  if (
    emitSavingsEvent(sink, "harness_subagent_model", {
      ...base,
      note: `tier=${tier} class=${delegable_class}`,
    })
  )
    emitted += 1;
  if (
    emitSavingsEvent(sink, "delegated_to_junior", {
      ...base,
      note: `${delegable_class} → ${tier} tier`,
    })
  )
    emitted += 1;
  if (
    delegable_class === "recon" &&
    emitSavingsEvent(sink, "recon_in_cheap_subagent", {
      ...base,
      note: "read-only recon on worker model",
    })
  )
    emitted += 1;
  if (
    sweep &&
    emitSavingsEvent(sink, "worker_batch_parallel", {
      ...base,
      note: "parallel workers for one group",
    })
  )
    emitted += 1;
  return emitted;
}

/**
 * Wire the Issue-4a bulk-edit savings from one parsed `bulk-edit` marker. A
 * `oneshot` rung (one command/script replaced an N-file loop) emits
 * `bulk_edit_oneshot`; a `cheap_loop` rung (the edit fell to a worker loop, but
 * stayed off the senior) emits `bulk_edit_cheap_loop`. `files` (when > 0) is
 * stamped as `files_saved` so the dashboard can sum the N-file work that did NOT
 * cost N senior round-trips. Best-effort — a null sink is a silent no-op.
 * Returns true when a row was emitted.
 */
export function emitBulkEditSavings(
  sink: SavingsEventSink | null | undefined,
  opts: {
    session_id: string;
    turn?: number;
    mode: "oneshot" | "cheap_loop";
    files: number;
  }
): boolean {
  const kind: SavingsEventKind =
    opts.mode === "oneshot" ? "bulk_edit_oneshot" : "bulk_edit_cheap_loop";
  return emitSavingsEvent(sink, kind, {
    session_id: opts.session_id,
    ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
    tool: "mark_intent",
    ...(opts.files > 0 ? { files_saved: opts.files } : {}),
    note:
      opts.mode === "oneshot"
        ? "one command/script replaced an N-file loop"
        : "worker loop (still off the senior)",
  });
}

/**
 * Wire the Issue-4b batch-call saving from one parsed `batch-call` marker: N
 * independent targets fetched in one call (or one parallel message) instead of N
 * round-trips. `roundtrips_saved` is N−1 (the round-trips that did NOT happen).
 * Best-effort — a null sink is a silent no-op. Returns true when a row emitted.
 */
export function emitBatchCallSavings(
  sink: SavingsEventSink | null | undefined,
  opts: { session_id: string; turn?: number; targets: number }
): boolean {
  return emitSavingsEvent(sink, "batch_call_saved_roundtrips", {
    session_id: opts.session_id,
    ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
    tool: "mark_intent",
    roundtrips_saved: Math.max(0, opts.targets - 1),
    note: `${opts.targets} targets in one call`,
  });
}
