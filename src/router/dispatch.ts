/**
 * Dispatchers — coalesces unlocks and orchestrates intent-driven masking.
 *
 * Two dispatchers cooperate:
 *
 * 1. `UnlockDispatcher` (P1-4) — coalesces per-response tool unlocks
 *    into a single `tools/list_changed` notification.
 *
 * 2. `IntentDispatcher` (P2-2) — runs the intent scorer on every turn,
 *    feeds results to FamilyMaskEngine, detects intent shifts, and
 *    ensures monotonic-add exposure (new families get exposed, none
 *    get re-masked).
 *
 * Flow (UnlockDispatcher):
 *   1. Tool call response includes unlock signals → recordUnlock(toolName)
 *   2. After response is sent, flushUnlocks() processes batch
 *   3. ExposureTracker updated (monotonic add)
 *   4. If NEW tools exposed, NotificationEmitter fires once
 *
 * Flow (IntentDispatcher):
 *   1. After each tool call, evaluateIntent() runs the scorer
 *   2. Scorer output fed to FamilyMaskEngine.recompute()
 *   3. If new families exposed (intent shift), emitter fires
 *   4. Mask decisions recorded for telemetry
 */

import type { FamilyMaskEngine, MaskSnapshot } from "../router/family-mask.js";
import {
  type ScorerInput,
  type ScorerOutput,
  scoreIntent,
} from "../router/intent/scorer.js";
import type { IntentTraceWriter } from "../router/intent/traces.js";
import type { NotificationEmitter } from "./notifications.js";
import type { ExposureTracker } from "./tools-list.js";

export interface UnlockRecord {
  readonly prefixedName: string;
  readonly reason: string;
  readonly timestamp: number;
}

export class UnlockDispatcher {
  private readonly exposureTracker: ExposureTracker;
  private readonly emitter: NotificationEmitter;
  private pendingUnlocks: UnlockRecord[] = [];
  private readonly history: UnlockRecord[] = [];

  constructor(exposureTracker: ExposureTracker, emitter: NotificationEmitter) {
    this.exposureTracker = exposureTracker;
    this.emitter = emitter;
  }

  recordUnlock(prefixedName: string, reason: string): void {
    this.pendingUnlocks.push({
      prefixedName,
      reason,
      timestamp: Date.now(),
    });
  }

  recordUnlocks(
    unlocks: readonly { prefixedName: string; reason: string }[]
  ): void {
    for (const u of unlocks) {
      this.recordUnlock(u.prefixedName, u.reason);
    }
  }

  flushUnlocks(): readonly string[] {
    if (this.pendingUnlocks.length === 0) return [];

    const names = this.pendingUnlocks.map((u) => u.prefixedName);
    const newlyExposed = this.exposureTracker.exposeMany(names);

    for (const record of this.pendingUnlocks) {
      this.history.push(record);
    }
    this.pendingUnlocks = [];

    if (newlyExposed.length > 0 && !this.emitter.isDemoted) {
      this.emitter.notify();
    }

    return newlyExposed;
  }

  get pendingCount(): number {
    return this.pendingUnlocks.length;
  }

  getHistory(): readonly UnlockRecord[] {
    return this.history;
  }

  wasUnlocked(prefixedName: string): boolean {
    return this.exposureTracker.isExposed(prefixedName);
  }
}

// ── Intent Dispatcher (P2-2) ────────────────────────────────────────────────

export interface IntentEvaluation {
  readonly scorerOutput: ScorerOutput;
  readonly maskSnapshot: MaskSnapshot;
  readonly intentShifted: boolean;
  readonly newlyExposedFamilies: readonly string[];
  readonly turnNumber: number;
}

export class IntentDispatcher {
  private readonly maskEngine: FamilyMaskEngine;
  private readonly emitter: NotificationEmitter | null;
  private readonly traceWriter: IntentTraceWriter | null;
  private readonly sessionId: string;
  private previousExposed = new Set<string>();
  private evaluationCount = 0;
  private readonly evaluations: IntentEvaluation[] = [];

  constructor(opts: {
    maskEngine: FamilyMaskEngine;
    emitter?: NotificationEmitter;
    traceWriter?: IntentTraceWriter;
    sessionId: string;
  }) {
    this.maskEngine = opts.maskEngine;
    this.emitter = opts.emitter ?? null;
    this.traceWriter = opts.traceWriter ?? null;
    this.sessionId = opts.sessionId;
  }

  /**
   * Evaluate intent and update mask state. Called after each tool call.
   * Returns the evaluation result including whether intent shifted.
   *
   * Monotonic-add: new families get exposed, but previously-exposed
   * families are never re-masked (handled by FamilyMaskEngine).
   */
  evaluateIntent(input: ScorerInput, turnNumber: number): IntentEvaluation {
    const scorerOutput = scoreIntent(input);
    const maskSnapshot = this.maskEngine.recompute(
      scorerOutput.exposedFamilies,
      turnNumber
    );

    const newlyExposed: string[] = [];
    for (const family of maskSnapshot.exposedFamilies) {
      if (!this.previousExposed.has(family)) {
        newlyExposed.push(family);
      }
    }

    const intentShifted = newlyExposed.length > 0 && this.evaluationCount > 0;

    if (intentShifted && this.emitter && !this.emitter.isDemoted) {
      this.emitter.notify();
    }

    this.previousExposed = new Set(maskSnapshot.exposedFamilies);
    this.evaluationCount++;

    if (this.traceWriter) {
      this.traceWriter.record(this.sessionId, turnNumber, scorerOutput);
    }

    const evaluation: IntentEvaluation = {
      scorerOutput,
      maskSnapshot,
      intentShifted,
      newlyExposedFamilies: newlyExposed,
      turnNumber,
    };

    this.evaluations.push(evaluation);
    return evaluation;
  }

  /**
   * Check if a family is currently masked.
   */
  isFamilyMasked(family: string): boolean {
    return this.maskEngine.isMasked(family);
  }

  /**
   * Get the current mask snapshot without re-evaluating.
   */
  getCurrentSnapshot(): MaskSnapshot {
    return this.maskEngine.getCurrentSnapshot();
  }

  /**
   * Manual override: unmask a family for the session.
   */
  unmaskFamily(family: string): void {
    this.maskEngine.unmask(family);
  }

  /**
   * Get all evaluations for this session (for dashboard/telemetry).
   */
  getEvaluations(): readonly IntentEvaluation[] {
    return this.evaluations;
  }

  /**
   * Get the dominant families from the last evaluation.
   */
  getDominantFamilies(): readonly string[] {
    if (this.evaluations.length === 0) return [];
    const last = this.evaluations[this.evaluations.length - 1]!;
    return last.scorerOutput.scores
      .filter((s) => s.exposed && s.score > 0)
      .map((s) => s.family);
  }

  /**
   * Get reasons for the dominant families (for soft-refuse messages).
   */
  getDominantReasons(): readonly string[] {
    if (this.evaluations.length === 0) return [];
    const last = this.evaluations[this.evaluations.length - 1]!;
    return last.scorerOutput.scores
      .filter((s) => s.exposed && s.score > 0)
      .flatMap((s) => s.reasons);
  }
}
