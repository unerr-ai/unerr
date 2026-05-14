/**
 * Persistent Memory Effectiveness Tracker.
 *
 * Surfaces the "was this signal load-bearing?" question for the /reasoning
 * dashboard. Tracks fact/convention/resume/negative-warning injections as
 * open windows, then evaluates each window's verdict on turn close.
 *
 * Verdicts (emitted as TokenFlow events, mechanism: "persistent_memory"):
 *   reinforced  – same signal re-surfaced, no correction observed
 *   acted_on    – entity edited within window, no rollback / circuit-breaker
 *   ignored     – window closed without any observable downstream activity
 *   corrected   – circuit-breaker / drift / blast-radius fired for same entity
 *   caught      – (negative-fact only) anti-pattern warned, no recurrence
 *
 * Fired events also emit (with verdict:"fired") so the dashboard can count
 * raw surface volume separately from outcome.
 */

import type { TokenFlowWriter } from "./token-flow.js";

export type PersistentSignalKind =
  | "fact_injected"
  | "fact_recalled"
  | "fact_recorded"
  | "convention_injected"
  | "resume_injected"
  | "negative_warned";

export type PersistentVerdict =
  | "fired"
  | "reinforced"
  | "acted_on"
  | "ignored"
  | "corrected"
  | "caught";

interface OpenSignal {
  kind: PersistentSignalKind;
  signal_id: string;
  entity_key: string | null;
  session_id: string;
  fired_turn: number;
  fired_at_ms: number;
  reinforcements: number;
  corrections: number;
  edits: number;
}

export interface PersistenceEffectivenessOptions {
  /** Turn-window K — verdict closes once current turn ≥ fired_turn + K. Default 5. */
  windowTurns?: number;
  /** Token estimate per signal (used so the events show up in token-flow charts). */
  tokensPerSignal?: number;
}

export class PersistenceEffectivenessTracker {
  private readonly tokenFlow: TokenFlowWriter;
  private readonly windowTurns: number;
  private readonly tokensPerSignal: number;
  private readonly open = new Map<string, OpenSignal>();

  constructor(
    tokenFlow: TokenFlowWriter,
    options: PersistenceEffectivenessOptions = {},
  ) {
    this.tokenFlow = tokenFlow;
    this.windowTurns = options.windowTurns ?? 5;
    this.tokensPerSignal = options.tokensPerSignal ?? 60;
  }

  /**
   * Record that a persistent-memory signal was injected/surfaced.
   * Emits a "fired" verdict event immediately AND opens a window for later
   * verdict resolution. Re-firing the same (kind, signal_id) within an open
   * window counts as a reinforcement, not a new fired event.
   */
  recordSignalFired(p: {
    kind: PersistentSignalKind;
    signal_id: string;
    entity_key?: string | null;
    turn: number;
    session_id?: string;
  }): void {
    const sessionId = p.session_id ?? this.tokenFlow.sessionId;
    const key = `${p.kind}:${p.signal_id}`;
    const existing = this.open.get(key);
    if (existing) {
      existing.reinforcements++;
      return;
    }

    this.open.set(key, {
      kind: p.kind,
      signal_id: p.signal_id,
      entity_key: p.entity_key ?? null,
      session_id: sessionId,
      fired_turn: p.turn,
      fired_at_ms: Date.now(),
      reinforcements: 0,
      corrections: 0,
      edits: 0,
    });

    this.emit({
      verdict: "fired",
      kind: p.kind,
      signal_id: p.signal_id,
      entity_key: p.entity_key ?? null,
      session_id: sessionId,
      turn: p.turn,
      reinforcements: 0,
      corrections: 0,
      edits: 0,
    });
  }

  /**
   * Observed correction for an entity (circuit-breaker, drift, blast-radius
   * warning, convention-violation auto-fire). Counts against any open signal
   * scoped to the same entity_key.
   */
  recordCorrection(entityKey: string | null, type: string): void {
    if (!entityKey) return;
    for (const s of this.open.values()) {
      if (s.entity_key === entityKey) {
        s.corrections++;
      }
    }
    // type captured for future detail enrichment
    void type;
  }

  /**
   * Observed Edit/Write on an entity. Counts toward "acted_on" verdict for
   * any open signal scoped to the same entity_key.
   */
  recordEdit(entityKey: string | null): void {
    if (!entityKey) return;
    for (const s of this.open.values()) {
      if (s.entity_key === entityKey) {
        s.edits++;
      }
    }
  }

  /**
   * Evaluate all open signals whose window has closed (current_turn - fired_turn >= windowTurns).
   * Emits one verdict event per closed signal.
   */
  closeWindow(currentTurn: number): void {
    for (const [key, s] of this.open) {
      if (currentTurn - s.fired_turn < this.windowTurns) continue;
      this.emitVerdict(s);
      this.open.delete(key);
    }
  }

  /**
   * Close every open window — called at session end. Forces a verdict for
   * everything still open regardless of turn distance.
   */
  closeAll(currentTurn: number): void {
    for (const [key, s] of this.open) {
      this.emitVerdict(s, currentTurn);
      this.open.delete(key);
    }
  }

  /** Number of signals still open (for testing / introspection). */
  openCount(): number {
    return this.open.size;
  }

  private emitVerdict(s: OpenSignal, _currentTurn?: number): void {
    const verdict = this.classify(s);
    this.emit({
      verdict,
      kind: s.kind,
      signal_id: s.signal_id,
      entity_key: s.entity_key,
      session_id: s.session_id,
      turn: s.fired_turn,
      reinforcements: s.reinforcements,
      corrections: s.corrections,
      edits: s.edits,
    });
  }

  private classify(s: OpenSignal): PersistentVerdict {
    if (s.corrections > 0) return "corrected";
    if (s.kind === "negative_warned") {
      // For negative facts the "no recurrence" case is the win — caught.
      return "caught";
    }
    if (s.edits > 0) return "acted_on";
    if (s.reinforcements > 0) return "reinforced";
    return "ignored";
  }

  private emit(p: {
    verdict: PersistentVerdict;
    kind: PersistentSignalKind;
    signal_id: string;
    entity_key: string | null;
    session_id: string;
    turn: number;
    reinforcements: number;
    corrections: number;
    edits: number;
  }): void {
    this.tokenFlow.record({
      session_id: p.session_id,
      turn: p.turn,
      mechanism: "persistent_memory",
      tool: null,
      tokens_without: 0,
      tokens_with: this.tokensPerSignal,
      tokens_saved: 0,
      detail: {
        kind: p.kind,
        verdict: p.verdict,
        signal_id: p.signal_id,
        entity_key: p.entity_key,
        reinforcements: p.reinforcements,
        corrections: p.corrections,
        edits: p.edits,
      },
    });
  }
}
