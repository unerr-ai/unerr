/**
 * Sprint 10.7: Code Quality Signals — Durability Score + Developer Correction Tracking.
 *
 * Two signals:
 *   1. Code Durability Score: how long AI-generated code survives before modification.
 *   2. Developer Corrections: detects when humans edit AI-generated lines.
 *
 * Computed on drift events. Stored locally, stored locally.
 *
 * Design authority: Phase 5.5 §1.6.1 (Code Durability Score), §1.6.2 (Developer Correction Tracking)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry } from "./shadow-ledger.js";

/** stderr logger */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:quality] ${msg}\n`),
};

/** Durability score thresholds (hours). */
const FRAGILE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // <24h = fragile
const MODERATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7d = moderate
const DURABLE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30d = durable

/** Human origin threshold: >60s after last sync = human timing. */
const HUMAN_TIMING_MS = 60_000;

export interface DurabilityScore {
  /** Entity key */
  entityKey: string;
  /** Entity name */
  entityName: string;
  /** Score: 0.0 (fragile) to 1.0 (durable) */
  score: number;
  /** Time the AI code has survived (ms) */
  survivalMs: number;
  /** When the entity was first created/modified by AI */
  aiCreatedAt: string;
  /** Last computed timestamp */
  computedAt: string;
}

export interface DeveloperCorrection {
  /** Entity key */
  entityKey: string;
  /** Entity name */
  entityName: string;
  /** Time between AI write and human correction (ms) */
  correctionLatencyMs: number;
  /** Original AI prompt (from ledger entry) */
  originalPrompt: string;
  /** Number of lines changed in the correction */
  linesChanged: number;
  /** Timestamp of the correction */
  correctedAt: string;
}

export interface QualitySignals {
  /** Durability scores per entity */
  durabilityScores: Record<string, DurabilityScore>;
  /** Recent developer corrections */
  corrections: DeveloperCorrection[];
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Compute durability score from survival time.
 */
function computeDurabilityFromAge(survivalMs: number): number {
  if (survivalMs < FRAGILE_THRESHOLD_MS) {
    // 0.0 - 0.3 range
    return 0.1 + (survivalMs / FRAGILE_THRESHOLD_MS) * 0.2;
  }
  if (survivalMs < MODERATE_THRESHOLD_MS) {
    // 0.3 - 0.7 range
    return (
      0.3 +
      ((survivalMs - FRAGILE_THRESHOLD_MS) /
        (MODERATE_THRESHOLD_MS - FRAGILE_THRESHOLD_MS)) *
        0.4
    );
  }
  if (survivalMs < DURABLE_THRESHOLD_MS) {
    // 0.7 - 0.9 range
    return (
      0.7 +
      ((survivalMs - MODERATE_THRESHOLD_MS) /
        (DURABLE_THRESHOLD_MS - MODERATE_THRESHOLD_MS)) *
        0.2
    );
  }
  return 0.9;
}

export class QualitySignalTracker {
  private signalsPath: string;
  private signals: QualitySignals;
  /** Maximum corrections to retain in memory/disk. */
  private static readonly MAX_CORRECTIONS = 200;

  constructor(unerrDir: string) {
    this.signalsPath = join(unerrDir, "state", "quality_signals.json");
    this.signals = this.load();
  }

  /**
   * Record a drift event for an entity.
   * Called by DriftTracker when an entity is modified.
   *
   * @param entityKey Entity key
   * @param entityName Entity name
   * @param origin "ai" | "human" | "mixed" from DriftTracker attribution
   * @param lastSyncTimestamp Timestamp of last sync_local_diff
   * @param ledgerEntries Recent ledger entries for AI creation lookup
   */
  onEntityModified(
    entityKey: string,
    entityName: string,
    origin: string,
    lastSyncTimestamp: number,
    ledgerEntries: LedgerEntry[],
  ): void {
    const now = Date.now();

    // Check if this entity was previously created/modified by AI
    const aiEntry = this.findAiCreationEntry(
      entityKey,
      entityName,
      ledgerEntries,
    );

    if (aiEntry) {
      const aiCreatedAt = new Date(aiEntry.ts).getTime();
      const survivalMs = now - aiCreatedAt;

      // Update durability score
      this.signals.durabilityScores[entityKey] = {
        entityKey,
        entityName,
        score: computeDurabilityFromAge(survivalMs),
        survivalMs,
        aiCreatedAt: aiEntry.ts,
        computedAt: new Date().toISOString(),
      };

      // Check for developer correction (human modifying AI code)
      if (origin === "human" && lastSyncTimestamp > 0) {
        const timeSinceSync = now - lastSyncTimestamp;
        if (timeSinceSync > HUMAN_TIMING_MS) {
          this.signals.corrections.push({
            entityKey,
            entityName,
            correctionLatencyMs: timeSinceSync,
            originalPrompt: this.extractPrompt(aiEntry),
            linesChanged: 0, // Updated by caller if available
            correctedAt: new Date().toISOString(),
          });

          // Cap corrections list
          if (
            this.signals.corrections.length >
            QualitySignalTracker.MAX_CORRECTIONS
          ) {
            this.signals.corrections = this.signals.corrections.slice(
              -QualitySignalTracker.MAX_CORRECTIONS,
            );
          }
        }
      }
    }

    this.signals.updatedAt = new Date().toISOString();
  }

  /**
   * Get current quality signals for ledger flush.
   */
  getSignals(): QualitySignals {
    return { ...this.signals };
  }

  /**
   * Get durability scores for specific entities.
   */
  getDurabilityScores(entityKeys: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const key of entityKeys) {
      const score = this.signals.durabilityScores[key];
      if (score) {
        result[key] = score.score;
      }
    }
    return result;
  }

  /**
   * Get average durability score across all tracked entities.
   */
  getAverageDurability(): number {
    const scores = Object.values(this.signals.durabilityScores);
    if (scores.length === 0) return 0;
    const sum = scores.reduce((acc, s) => acc + s.score, 0);
    return sum / scores.length;
  }

  /**
   * Get recent corrections (for status display).
   */
  getRecentCorrections(limit = 10): DeveloperCorrection[] {
    return this.signals.corrections.slice(-limit);
  }

  /**
   * Persist signals to disk.
   */
  save(): void {
    try {
      const dir = join(this.signalsPath, "..");
      if (!existsSync(dir)) {
        const { mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        this.signalsPath,
        JSON.stringify(this.signals, null, 2),
        "utf-8",
      );
    } catch {
      // Non-critical — signals persist best-effort
    }
  }

  /**
   * Find the ledger entry where AI created/modified this entity.
   */
  private findAiCreationEntry(
    entityKey: string,
    entityName: string,
    entries: LedgerEntry[],
  ): LedgerEntry | null {
    // Look for sync_local_diff entries that mention this entity
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || entry.tool !== "sync_local_diff") continue;

      const args = entry.args_summary;
      // Check if the diff mentions this entity name
      const diff = (args.diff as string) ?? "";
      if (diff.includes(entityName) || diff.includes(entityKey)) {
        return entry;
      }

      // Check structured files for entity reference
      const files = args.files as
        | Array<{ path: string; entities?: string[] }>
        | undefined;
      if (files) {
        for (const file of files) {
          if (
            file.entities?.includes(entityName) ||
            file.entities?.includes(entityKey)
          ) {
            return entry;
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract the prompt text from a ledger entry.
   */
  private extractPrompt(entry: LedgerEntry): string {
    const prompt = (entry.args_summary.prompt as string) ?? "";
    return prompt.slice(0, 200); // Truncate for storage
  }

  /**
   * Load signals from disk.
   */
  private load(): QualitySignals {
    if (!existsSync(this.signalsPath)) {
      return {
        durabilityScores: {},
        corrections: [],
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      return JSON.parse(
        readFileSync(this.signalsPath, "utf-8"),
      ) as QualitySignals;
    } catch {
      return {
        durabilityScores: {},
        corrections: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }
}
