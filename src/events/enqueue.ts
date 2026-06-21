/**
 * L1 — `enqueue`, the single producer-side write interface for telemetry. A
 * producer hands it a `type` + `detail` (+ any per-event context); enqueue stamps
 * the shared identity envelope (§2 of the telemetry architecture) at emit and
 * appends one contract-shaped line to the repo's event store (L2). `unerrd`
 * drains that store to the cloud — the producer never opens a connection.
 *
 * Fire-and-forget and non-blocking: a telemetry write must never sit on or throw
 * into the agent's hot path. Zero native dependency and importable by BOTH the
 * per-repo proxy and the bridge — it pulls only node builtins, the L2 store, and
 * the contract's schema-version constant (no intelligence/tracking/cloud imports,
 * so `bridge-isolation.test.ts` stays green). Policy that is NOT envelope-stamping
 * — the `canSyncRecall` gate on full fact bodies, HR-2 anchor hashing — lives at
 * the producer call site, not here, to keep this module a leaf.
 *
 * // @sem domain=telemetry role=producer
 */
import { randomUUID } from "node:crypto";
import { INGEST_SCHEMA_VERSION } from "@unerr-ai/contracts/events";

import { type StoredEvent, appendEvent } from "./event-store.js";

/**
 * Ambient identity for one producer process, set once at boot. Per-event fields
 * (turn, tool_use_id, the type's detail) come on each {@link EmitInput}; these
 * are the values that hold for the whole process/session. `session_id` /
 * `native_session_id` / `branch` / `commit` are refreshed via
 * {@link updateEmitContext} as the session advances or the branch changes.
 */
export interface EmitContext {
  /** Repo root whose `.unerr/events/` store receives the line. */
  repoRoot: string;
  /** This writer's segment — `PROXY_SEGMENT` or `bridgeSegment(pid)`. */
  segment: string;
  /** The `source` envelope field, e.g. `"unerr-cli@0.3.4"`. */
  source: string;
  /** Salted repo id (a hash, never a path), or undefined outside a known repo. */
  repo?: string;
  /** Coding agent that owns the session (claude-code, cursor, …). */
  agent?: string;
  /** unerr's per-bridge session id (a UUID). */
  session_id?: string;
  /** The coding agent's own session id, when it exposes one. */
  native_session_id?: string;
  /** Current git branch (OTel vcs.ref.head.name), refreshed by the poller. */
  branch?: string;
  /** Current git HEAD sha (OTel vcs.ref.head.revision), refreshed by the poller. */
  commit?: string;
}

/**
 * One event a producer wants to send: the `type` discriminant, its `detail`
 * payload, plus any per-event identity finer than the ambient context (the exact
 * turn, the tool call it belongs to, or a `mode:"park"` spillover flag). Anything
 * omitted falls back to the {@link EmitContext}. `detail` is loosely typed here —
 * the per-type shape is validated against the contract at drain and server-side.
 */
export interface EmitInput {
  type: StoredEvent["type"];
  detail: Record<string, unknown>;
  /** Override the ambient session id for this one event (rare). */
  session_id?: string;
  /** Override the ambient native session id for this one event (rare). */
  native_session_id?: string;
  /** Turn index this event belongs to. */
  turn?: number;
  /** String turn id when the numeric index is not available. */
  turn_id?: string;
  /** The agent's id for the single tool call this event belongs to. */
  tool_use_id?: string;
  /** Override the ambient branch for this one event (rare). */
  branch?: string;
  /** Override the ambient commit for this one event (rare). */
  commit?: string;
  /** Spillover flag — set only when force-parking past the 7-day retry budget. */
  mode?: "park";
  /** Override the generated `event_id`. Pass a deterministic id (e.g. from
   *  `deterministicId`) so a row re-emitted across passes collapses server-side
   *  instead of duplicating. Defaults to a fresh `randomUUID`. */
  event_id?: string;
  /** Override the emit-time `ts` with the event's semantic time (e.g. the turn's
   *  start). Required ALONGSIDE a deterministic `event_id` for ReplacingMergeTree
   *  dedup, since `ts` is part of the sort key. Defaults to now(). */
  ts?: string;
}

/**
 * Stamp the identity envelope onto one {@link EmitInput} and return the full
 * contract-shaped event. Pure: generates a fresh `event_id` (the idempotency key)
 * and `ts` (emit time, ISO-8601 UTC), fills `schema_version`/`source`, and merges
 * ambient identity from `ctx` with any per-event overrides on `input`. Optional
 * fields are omitted entirely when unknown (the contract marks them optional, and
 * an absent key is cheaper on the wire than a null).
 */
export function stampEvent(ctx: EmitContext, input: EmitInput): StoredEvent {
  const session_id = input.session_id ?? ctx.session_id;
  const native_session_id = input.native_session_id ?? ctx.native_session_id;
  const branch = input.branch ?? ctx.branch;
  const commit = input.commit ?? ctx.commit;

  const event: Record<string, unknown> = {
    type: input.type,
    schema_version: INGEST_SCHEMA_VERSION,
    event_id: input.event_id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    source: ctx.source,
    detail: input.detail,
  };
  if (ctx.repo) event.repo = ctx.repo;
  if (ctx.agent) event.agent = ctx.agent;
  if (session_id) event.session_id = session_id;
  if (native_session_id) event.native_session_id = native_session_id;
  if (typeof input.turn === "number") event.turn = input.turn;
  if (input.turn_id) event.turn_id = input.turn_id;
  if (input.tool_use_id) event.tool_use_id = input.tool_use_id;
  if (branch) event.branch = branch;
  if (commit) event.commit = commit;
  if (input.mode) event.mode = input.mode;

  return event as StoredEvent;
}

/**
 * Stamp the envelope and append the event to the context's segment. The single
 * call a producer makes with an explicit context. Never throws (the L2 append
 * swallows I/O errors) — telemetry is best-effort.
 */
export function enqueue(ctx: EmitContext, input: EmitInput): void {
  appendEvent(ctx.repoRoot, ctx.segment, stampEvent(ctx, input));
}

// ── process-level configured context (so producers call zero-arg `emit`) ─────

let _ctx: EmitContext | null = null;

/**
 * Install the ambient {@link EmitContext} for this process. Called once at proxy
 * / bridge boot. Until it is called, {@link emit} is a no-op — a producer that
 * runs before configuration (or in a context with no repo) simply drops the
 * event rather than guessing identity.
 */
export function configureEmit(ctx: EmitContext): void {
  _ctx = ctx;
}

/**
 * Merge updated ambient identity into the configured context as the session
 * advances (a new session id, a branch switch). A no-op if `configureEmit` has
 * not run. Only the provided keys change.
 */
export function updateEmitContext(patch: Partial<EmitContext>): void {
  if (_ctx) _ctx = { ..._ctx, ...patch };
}

/** The current configured context, or null if `configureEmit` has not run. */
export function emitContext(): EmitContext | null {
  return _ctx;
}

/**
 * Enqueue an event using the process's configured context. The zero-argument
 * call site replacing every `MetricsStore.insert*`. A no-op when no context is
 * configured (standalone / pre-boot), so a producer never needs to null-check.
 */
export function emit(input: EmitInput): void {
  if (_ctx) enqueue(_ctx, input);
}

/** Reset the configured context. Test-only; production never un-configures. */
export function _resetEmitContextForTest(): void {
  _ctx = null;
}
