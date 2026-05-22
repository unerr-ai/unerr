/**
 * Pending Confirmation Registry — Phase 2 Sprint 6.
 *
 * When `unerr_remember` captures a fact with ambiguity_flag (0.5 ≤ conf <
 * 0.7), the next user turn should resolve the ambiguity. Until then the
 * fact is in a "pending confirmation" state. This module is the in-memory
 * registry that tracks those pending captures and emits a
 * `confirmation_expired` behaviour event when a pending entry ages out
 * without a resolution turn.
 *
 * Scope (intentional):
 *   - In-memory only. No CozoDB row, no JSONL. A pending entry only lives
 *     for one session — if the process restarts, anything still pending
 *     is treated as abandoned (no event emitted on shutdown — restart
 *     events are noise, not signal).
 *   - One pending entry per `fact_id`. Re-capturing the same fact_id with
 *     a fresh ambiguity flag refreshes the entry (new expiry).
 *   - Per-session isolation: the sweep iterates the full map but each
 *     entry carries its session_id so consumers can filter.
 *
 * Why an event (not just a quiet expiry):
 *   - `confirmation_expired` is one of the named events on the four-surface
 *     model (Phase 1). The dashboard logbook + footer summary already
 *     know how to render it via `PHRASING` in `tracking/named-events.ts`.
 *   - Treating expiry as a first-class event lets the agent see "this
 *     fact was never confirmed" surface as a real counter, not silent
 *     drift.
 */

import type { BehaviorEventWriter } from "../tracking/behavior-events.js";

/** Default TTL for a pending confirmation. 30 minutes matches the
 *  process-manager idle window — past this point the user is unlikely
 *  to return to the same context. */
export const DEFAULT_CONFIRMATION_TTL_MS = 30 * 60 * 1000;

/** Sweep cadence. Cheap (Map iteration) — fine to run every minute. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export interface PendingConfirmation {
  readonly fact_id: string;
  readonly session_id: string;
  readonly subject: string;
  readonly scope: string;
  readonly content_preview: string;
  readonly confidence: number;
  readonly turn_registered: number;
  readonly expires_at: number;
}

export interface PendingConfirmationOptions {
  readonly ttlMs?: number;
  readonly sweepIntervalMs?: number;
  /** Injectable now() — tests can advance time deterministically. */
  readonly now?: () => number;
}

export class PendingConfirmationRegistry {
  private readonly entries = new Map<string, PendingConfirmation>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly behaviorEvents: BehaviorEventWriter | null;

  constructor(
    behaviorEvents: BehaviorEventWriter | null,
    opts: PendingConfirmationOptions = {}
  ) {
    this.behaviorEvents = behaviorEvents;
    this.ttlMs = opts.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Start the periodic sweep. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // Don't keep the event loop alive just for the sweep.
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  /** Stop the sweep. Does NOT clear entries — call `clear()` for that. */
  stop(): void {
    if (this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Register a pending confirmation. Replaces any prior entry for the
   *  same `fact_id` with a fresh expiry. */
  register(input: {
    fact_id: string;
    session_id: string;
    subject: string;
    scope: string;
    content: string;
    confidence: number;
    turn: number;
  }): PendingConfirmation {
    const entry: PendingConfirmation = {
      fact_id: input.fact_id,
      session_id: input.session_id,
      subject: input.subject,
      scope: input.scope,
      content_preview: input.content.slice(0, 80),
      confidence: input.confidence,
      turn_registered: input.turn,
      expires_at: this.now() + this.ttlMs,
    };
    this.entries.set(input.fact_id, entry);
    return entry;
  }

  /** Mark a pending confirmation as resolved. Returns the removed entry,
   *  or undefined if no such fact_id was pending. */
  resolve(fact_id: string): PendingConfirmation | undefined {
    const entry = this.entries.get(fact_id);
    if (!entry) return undefined;
    this.entries.delete(fact_id);
    return entry;
  }

  /** Snapshot of pending entries, optionally filtered by session. */
  list(sessionId?: string): PendingConfirmation[] {
    const out: PendingConfirmation[] = [];
    for (const entry of this.entries.values()) {
      if (sessionId && entry.session_id !== sessionId) continue;
      out.push(entry);
    }
    return out;
  }

  /** Whether `fact_id` is currently pending. */
  isPending(fact_id: string): boolean {
    return this.entries.has(fact_id);
  }

  /** Drop all entries without emitting events. Tests-only. */
  clear(): void {
    this.entries.clear();
  }

  /** Run one expiry pass. Returns the entries that expired this pass.
   *  Each expiry emits a `confirmation_expired` behaviour event. */
  sweep(): PendingConfirmation[] {
    const now = this.now();
    const expired: PendingConfirmation[] = [];
    for (const [fact_id, entry] of this.entries) {
      if (entry.expires_at <= now) {
        this.entries.delete(fact_id);
        expired.push(entry);
      }
    }
    for (const entry of expired) {
      this.behaviorEvents?.record({
        session_id: entry.session_id,
        turn: entry.turn_registered,
        type: "confirmation_expired",
        tool: "unerr_remember",
        entity_key: entry.subject,
        response_bytes: null,
        detail: {
          fact_id: entry.fact_id,
          scope: entry.scope,
          confidence: entry.confidence,
          content_preview: entry.content_preview,
        },
      });
    }
    return expired;
  }
}
