/**
 * Session Context — tracks per-session state for intelligent context injection.
 *
 * Used by QueryRouter to decide when to inject blast radius, conventions,
 * corrections, and risk information into tool responses.
 */

import type { SessionEvents } from "../proxy/session-stats.js";
import type { SignalShowStore } from "./signal-show-store.js";

export interface EntityHistoryEntry {
  blast_radius: number;
  risk: string;
  queriedAt: number;
}

export class SessionContext {
  private toolCallCount = 0;
  private greeted = false;
  private injectedBlastRadius = new Set<string>();
  /**
   * Convention / fact reinforcement windows: track WHEN each key was last
   * shown (tool-call index + wall-clock ms) so we can re-surface after a
   * stale window instead of going silent for the rest of the session.
   *
   * Stale = 10+ unrelated tool calls since last show, OR 30+ min wall-clock.
   * Tunable via STALE_CALL_GAP / STALE_TIME_MS constants below.
   */
  private injectedConventions = new Map<
    string,
    { atCall: number; atMs: number }
  >();
  private injectedRisk = new Set<string>();
  private injectedCorrections = new Set<string>();
  private injectedFacts = new Map<string, { atCall: number; atMs: number }>();
  private readonly STALE_CALL_GAP = 10;
  private readonly STALE_TIME_MS = 30 * 60 * 1000;
  private entityHistory = new Map<string, EntityHistoryEntry>();
  private lastFiredThreshold = 0;
  /**
   * Tier-3 rotational signal decay: how many times each unique signal has
   * been emitted in the body prefix this session. Used by signal-scorer.rank()
   * to deprioritize already-shown signals (`adjusted_score = base / (1 + shows * 0.5)`),
   * so anti-pattern facts surface fresh information instead of repeating.
   * Key: stable signal id (sha256(content).slice(0,16) or fact_id).
   *
   * In-memory fallback used when no SignalShowStore has been attached
   * (tests, --mcp during timeline.db boot). When the store is present its
   * effective count is preferred so rotation survives restarts and is
   * coordinated across parallel sessions in the same repo.
   */
  private signalShowCount = new Map<string, number>();
  private showStore: SignalShowStore | null = null;

  recordToolCall(): void {
    this.toolCallCount++;
  }

  getToolCallCount(): number {
    return this.toolCallCount;
  }

  isFirstCall(): boolean {
    return !this.greeted && this.toolCallCount <= 1;
  }

  markGreeted(): void {
    this.greeted = true;
  }

  /**
   * Attach the persistent rotation store. Once attached, getSignalShowCount
   * returns the time-decayed cross-session count and recordSignalShown writes
   * through to timeline.db on the next flush tick.
   */
  setSignalShowStore(store: SignalShowStore | null): void {
    this.showStore = store;
  }

  // ── Tier-3 rotational signal decay ────────────────────────────────────
  /** Record that a signal was emitted in a prefix line (called by ranker). */
  recordSignalShown(signalId: string, scope = ""): void {
    if (!signalId) return;
    this.signalShowCount.set(
      signalId,
      (this.signalShowCount.get(signalId) ?? 0) + 1
    );
    this.showStore?.recordShown(signalId, scope);
  }

  /** How many times this signal has been emitted this session (or effective decayed count if persisted). */
  getSignalShowCount(signalId: string): number {
    if (!signalId) return 0;
    if (this.showStore) return this.showStore.getEffectiveShowCount(signalId);
    return this.signalShowCount.get(signalId) ?? 0;
  }

  /** Last-shown timestamp (ms since epoch) across all sessions; 0 if never shown. */
  getSignalLastShownMs(signalId: string): number {
    if (!signalId) return 0;
    return this.showStore?.getLastShownMs(signalId) ?? 0;
  }

  /** Reset rotation state — useful for tests or explicit "fresh start" intents. */
  resetSignalRotation(): void {
    this.signalShowCount.clear();
  }

  hasHistory(entityKey: string): boolean {
    return this.entityHistory.has(entityKey);
  }

  getHistory(entityKey: string): EntityHistoryEntry | undefined {
    return this.entityHistory.get(entityKey);
  }

  /**
   * Entity keys recently queried this session (Map insertion order — newest
   * last). Returns the trailing slice up to `max` so the recall_facts ranker
   * can give a small boost to facts whose subject matches active context.
   */
  getRecentSubjects(max = 10): Set<string> {
    const keys = Array.from(this.entityHistory.keys());
    return new Set(keys.slice(-max));
  }

  recordEntityHistory(
    entityKey: string,
    blastRadius: number,
    risk: string
  ): void {
    // Only record on first call — do not overwrite
    if (this.entityHistory.has(entityKey)) return;
    this.entityHistory.set(entityKey, {
      blast_radius: blastRadius,
      risk,
      queriedAt: Date.now(),
    });
  }

  shouldInjectBlastRadius(entityKey: string): boolean {
    if (this.injectedBlastRadius.has(entityKey)) return false;
    this.injectedBlastRadius.add(entityKey);
    return true;
  }

  shouldInjectCorrection(
    entityKey: string,
    _errorType?: string | string[]
  ): boolean {
    if (this.injectedCorrections.has(entityKey)) return false;
    this.injectedCorrections.add(entityKey);
    return true;
  }

  shouldInjectConvention(entityKey: string | string[]): boolean {
    const key = Array.isArray(entityKey) ? entityKey.join(",") : entityKey;
    return this.isStale(this.injectedConventions.get(key));
  }

  recordConventions(conventions: string | string[]): void {
    // Set-once semantics: stamp on FIRST show only. Refreshing on every
    // re-show defeats the stale-window predicate (the gap can never
    // accumulate when each show resets atCall to current). Once a key
    // becomes stale, isStale returns true, the caller surfaces it again,
    // and only then does recordConventions overwrite the stamp.
    const items = Array.isArray(conventions) ? conventions : [conventions];
    const stamp = { atCall: this.toolCallCount, atMs: Date.now() };
    for (const item of items) {
      const existing = this.injectedConventions.get(item);
      if (!existing || this.isStale(existing)) {
        this.injectedConventions.set(item, stamp);
      }
    }
  }

  shouldInjectFact(factId: string): boolean {
    return this.isStale(this.injectedFacts.get(factId));
  }

  recordFacts(factIds: string[]): void {
    // Set-once semantics — same reasoning as recordConventions above.
    const stamp = { atCall: this.toolCallCount, atMs: Date.now() };
    for (const id of factIds) {
      const existing = this.injectedFacts.get(id);
      if (!existing || this.isStale(existing)) {
        this.injectedFacts.set(id, stamp);
      }
    }
  }

  /**
   * "Should re-surface" predicate: true when never shown, or when the gap
   * since last show exceeds either threshold (call-count or wall-clock).
   * Both thresholds matter — pure call-count misses long idle gaps, pure
   * time misses rapid-fire sessions.
   */
  private isStale(last: { atCall: number; atMs: number } | undefined): boolean {
    if (!last) return true;
    if (this.toolCallCount - last.atCall >= this.STALE_CALL_GAP) return true;
    if (Date.now() - last.atMs >= this.STALE_TIME_MS) return true;
    return false;
  }

  shouldInjectRisk(entityKey: string): boolean {
    if (this.injectedRisk.has(entityKey)) return false;
    return true;
  }

  recordRisk(entityKey: string): void {
    this.injectedRisk.add(entityKey);
  }

  /**
   * Value counter — surfaces "unerr has caught N issues this session" every 3rd caught event.
   * Conditions: toolCallCount > 10, caught > 0, caught % 3 === 0, fires once per threshold.
   */
  getValueCounter(events: SessionEvents): string | undefined {
    if (this.toolCallCount <= 10) return undefined;

    const caught =
      events.conventionViolationsCaught +
      events.chokepointWarningsIssued +
      events.circularDepsDetected;

    if (caught === 0) return undefined;
    if (caught % 3 !== 0) return undefined;
    if (caught === this.lastFiredThreshold) return undefined;

    this.lastFiredThreshold = caught;
    return `(unerr has caught ${caught} issues this session)`;
  }

  recordQuery(entityKey: string): void {
    // Mark as having had blast radius injected (dedup future calls)
    this.injectedBlastRadius.add(entityKey);
  }

  get entitiesQueried(): number {
    return this.injectedBlastRadius.size;
  }

  get conventionsSurfaced(): number {
    return this.injectedConventions.size;
  }

  get risksSurfaced(): number {
    return this.injectedRisk.size;
  }

  reset(): void {
    this.toolCallCount = 0;
    this.greeted = false;
    this.injectedBlastRadius.clear();
    this.injectedConventions.clear();
    this.injectedRisk.clear();
    this.injectedCorrections.clear();
    this.entityHistory.clear();
    this.lastFiredThreshold = 0;
  }
}
