/**
 * Turn Segmenter — assigns ledger entries to logical "turns" (one user→agent
 * round-trip). Embedded inside ShadowLedger.record(); does not write or read
 * files. Pure in-memory state, isolated per session.
 *
 * Boundary detection (in priority order):
 *  1. `closeTurn(sessionId)` — called by Stop hooks (Claude Code) or session
 *     shutdown. Anchors an exact boundary. Next observed entry opens a new
 *     turn with confidence "first_call".
 *  2. Idle gap > IDLE_GAP_MS between consecutive entries on the same session
 *     closes the previous turn and opens a new one with confidence "idle_gap".
 *  3. The very first entry on a session opens turn 1 with confidence
 *     "first_call".
 *
 * Subscribers get notified on every turn close via onTurnClose(listener).
 * The timeline subsystem uses this to upsert turn rollups into timeline.db
 * — but the segmenter itself has no dependency on that subsystem and is safe
 * to use standalone (e.g., in tests, or when UNERR_TIMELINE_V2=0).
 */

import { randomBytes } from "node:crypto";

export type TurnConfidence = "first_call" | "idle_gap" | "stop_hook";

export interface TurnCloseEvent {
  turn_id: string;
  session_id: string;
  /** Timestamp of the last entry in the closed turn (ms epoch). */
  closed_at: number;
  reason: "idle_gap" | "stop_hook" | "session_end";
}

export type TurnCloseListener = (event: TurnCloseEvent) => void;

/** Minimal shape the segmenter mutates. Compatible with LedgerEntry. */
export interface TurnTaggable {
  session_id: string;
  ts: string;
  turn_id?: string;
  turn_confidence?: TurnConfidence;
}

const DEFAULT_IDLE_GAP_MS = 20_000;

interface SessionTurnState {
  currentTurnId: string | null;
  lastEntryTs: number;
  /** Confidence label for the CURRENT turn. Carried by every entry in it. */
  openedBy: TurnConfidence;
}

export interface TurnSegmenterOptions {
  /** Idle threshold above which a new turn is opened. Default 20 s. */
  idleGapMs?: number;
}

export class TurnSegmenter {
  private state = new Map<string, SessionTurnState>();
  private listeners: TurnCloseListener[] = [];
  private readonly idleGapMs: number;

  constructor(options: TurnSegmenterOptions = {}) {
    this.idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  }

  /**
   * Subscribe to turn-close events. Returns an unsubscribe function.
   */
  onTurnClose(listener: TurnCloseListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Observe an entry and stamp it with turn_id + turn_confidence in place.
   * May emit a close event for the previous turn if an idle gap is detected.
   */
  observe(entry: TurnTaggable): void {
    const ts = Date.parse(entry.ts);
    const s = this.state.get(entry.session_id) ?? this.initState();

    if (s.currentTurnId === null) {
      // Opening a new turn — openedBy is whatever the prior closeTurn or
      // initState set ("first_call" for the very first or after stop_hook).
      s.currentTurnId = generateTurnId();
    } else if (
      Number.isFinite(ts) &&
      ts - s.lastEntryTs > this.idleGapMs &&
      s.lastEntryTs > 0
    ) {
      this.emitClose({
        turn_id: s.currentTurnId,
        session_id: entry.session_id,
        closed_at: s.lastEntryTs,
        reason: "idle_gap",
      });
      s.currentTurnId = generateTurnId();
      s.openedBy = "idle_gap";
    }

    entry.turn_id = s.currentTurnId;
    entry.turn_confidence = s.openedBy;
    if (Number.isFinite(ts)) s.lastEntryTs = ts;
    this.state.set(entry.session_id, s);
  }

  /**
   * Anchor an exact turn boundary. The next observed entry will open a new
   * turn with confidence "first_call" (the boundary is known precisely).
   * Idempotent — calling with no active turn is a no-op.
   */
  closeTurn(
    sessionId: string,
    reason: "stop_hook" | "session_end" = "stop_hook"
  ): void {
    const s = this.state.get(sessionId);
    if (!s || s.currentTurnId === null) return;
    this.emitClose({
      turn_id: s.currentTurnId,
      session_id: sessionId,
      closed_at: s.lastEntryTs,
      reason,
    });
    s.currentTurnId = null;
    s.openedBy = "first_call";
    this.state.set(sessionId, s);
  }

  /**
   * Inspect the current turn id for a session. Returns null if no turn is open.
   * Intended for diagnostics / tests.
   */
  getCurrentTurnId(sessionId: string): string | null {
    return this.state.get(sessionId)?.currentTurnId ?? null;
  }

  /**
   * Drop all state. For tests and clean shutdown.
   */
  reset(): void {
    this.state.clear();
  }

  private initState(): SessionTurnState {
    return {
      currentTurnId: null,
      lastEntryTs: 0,
      openedBy: "first_call",
    };
  }

  private emitClose(event: TurnCloseEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err: unknown) {
        process.stderr.write(
          `[unerr:turn-segmenter] WARN: listener error: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }
}

function generateTurnId(): string {
  return randomBytes(6).toString("hex");
}
