/**
 * Signal Reinforcer (ST-5).
 *
 * Reinforce / contradict derived timeline signals (hot files, loops, co-changes,
 * conventions) in `timeline.db`. Never touches `facts.db` — Layer 9 reinforcement
 * stays on its own path.
 *
 * Confidence clamps to [0, 1]. Reinforcement history is unbounded in storage but
 * the API + UI surface only the most recent 10 events. Stale signals (no
 * reinforcement in `staleAfterMs`) are evicted by `pruneStaleSignals`.
 */

import { randomUUID } from "node:crypto";
import type { CozoTimelineStore, SignalRow } from "./timeline-store.js";

export interface ReinforceOptions {
  /** Reference timestamp (ms). Defaults to Date.now. */
  nowMs?: number;
}

export interface PruneOptions {
  /** Signals last seen older than this are removed. Default 14 d. */
  staleAfterMs?: number;
  /** Reference "now" timestamp. Defaults to Date.now. */
  nowMs?: number;
}

const DEFAULT_STALE_MS = 14 * 24 * 60 * 60_000;

export type SignalIdentity =
  | { signal_id: string }
  | { type: string; scope: string; content?: string };

/**
 * Reinforce (or contradict) a signal. Identity is either an explicit
 * `signal_id` or a `(type, scope)` natural key — the function upserts a row
 * if it doesn't exist yet, then appends a reinforcement event.
 */
export async function reinforceSignal(
  store: CozoTimelineStore,
  identity: SignalIdentity,
  delta: number,
  source: string,
  opts: ReinforceOptions = {}
): Promise<SignalRow> {
  const now = opts.nowMs ?? Date.now();

  const signal = await resolveSignal(store, identity);
  if (!signal) {
    const created: SignalRow = {
      signal_id: "signal_id" in identity ? identity.signal_id : randomUUID(),
      type: "type" in identity ? identity.type : "unknown",
      scope: "scope" in identity ? identity.scope : "",
      content: "type" in identity ? (identity.content ?? "") : "",
      confidence: clamp01(0.5 + delta),
      first_seen_at: now,
      last_seen_at: now,
    };
    await store.upsertSignal(created);
    await store.appendReinforcement(created.signal_id, now, delta, source);
    return created;
  }

  signal.confidence = clamp01(signal.confidence + delta);
  signal.last_seen_at = now;
  await store.upsertSignal(signal);
  await store.appendReinforcement(signal.signal_id, now, delta, source);
  return signal;
}

async function resolveSignal(
  store: CozoTimelineStore,
  identity: SignalIdentity
): Promise<SignalRow | null> {
  if ("signal_id" in identity) {
    return store.getSignal(identity.signal_id);
  }
  const all = await store.listSignals({ type: identity.type, limit: 500 });
  return all.find((s) => s.scope === identity.scope) ?? null;
}

export async function pruneStaleSignals(
  store: CozoTimelineStore,
  opts: PruneOptions = {}
): Promise<number> {
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - (opts.staleAfterMs ?? DEFAULT_STALE_MS);
  return store.deleteSignalsBefore(cutoff);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
