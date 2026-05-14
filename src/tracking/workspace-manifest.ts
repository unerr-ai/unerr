/**
 * Workspace Manifest — Causal Bridge between intents and commits.
 *
 * Maintains `.unerr/manifest.json` — a structured record linking AI intent
 * chains to git commits. This file is the single source of truth for
 * attributing "why" a change was made (AI-assisted or human-only).
 *
 * Flow:
 *   1. Shadow Ledger records every tool call with correlation IDs
 *   2. Intent Correlator groups related calls into pending correlations
 *   3. Commit Watcher associates pending correlations with commit SHAs
 *   4. Workspace Manifest snapshots committed correlations into attribution records
 *   5. On push/PR → manifest is persisted locally for PR badges + attribution
 *
 * File: .unerr/manifest.json
 *
 * All logging to stderr (stdout reserved for MCP).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingCorrelation } from "./intent-correlator.js";

// ── Types ────────────────────────────────────────────────────────────

export interface AttributionRecord {
  /** Root intent ID from Shadow Ledger */
  intentId: string;
  /** Git commit SHA this intent produced */
  commitSha: string;
  /** Branch name */
  branch: string;
  /** Session ID of the CLI proxy that recorded this */
  sessionId: string;
  /** User prompt / description */
  prompt: string;
  /** Ordered tool chain: ["search_code", "get_callers", "sync_local_diff"] */
  toolChain: string[];
  /** Entity keys affected by this change */
  entitiesAffected: string[];
  /** Files changed */
  filesChanged: string[];
  /** When the correlation was created (ISO) */
  correlatedAt: string;
  /** When the commit was made (ISO) */
  committedAt: string;
  /** Whether this record has been persisted */
  flushed: boolean;
}

export interface OrphanedIntent {
  intentId: string;
  prompt: string;
  toolChain: string[];
  filesAffected: string[];
  detectedAt: string;
  originalAt: string;
}

export interface WorkspaceManifestData {
  version: 1;
  repoId: string;
  /** Attribution records — append-only within a session */
  records: AttributionRecord[];
  /** Last flush timestamp (ISO) */
  lastFlushedAt: string | null;
  /** Number of records persisted */
  totalFlushed: number;
  /** Intents that were never associated with a commit */
  orphanedIntents?: OrphanedIntent[];
}

// ── Manifest Manager ────────────────────────────────────────────────

export class WorkspaceManifest {
  private manifestPath: string;
  private data: WorkspaceManifestData;

  constructor(
    private unerrDir: string,
    private repoId: string,
    private sessionId: string,
  ) {
    this.manifestPath = join(unerrDir, "manifest.json");
    this.data = this.load();
  }

  /**
   * Record a committed correlation as an attribution.
   * Called by CommitWatcher when it associates a pending correlation with a commit.
   */
  recordAttribution(correlation: PendingCorrelation, branch: string): void {
    if (!correlation.commitSha) return; // Only committed correlations

    const record: AttributionRecord = {
      intentId: correlation.rootIntentId,
      commitSha: correlation.commitSha,
      branch,
      sessionId: this.sessionId,
      prompt: correlation.prompt,
      toolChain: correlation.toolChain,
      entitiesAffected: correlation.entities,
      filesChanged: correlation.files,
      correlatedAt: correlation.createdAt,
      committedAt: new Date().toISOString(),
      flushed: false,
    };

    this.data.records.push(record);
    this.save();
  }

  /**
   * Get unflushed attribution records.
   */
  getUnflushedRecords(): AttributionRecord[] {
    return this.data.records.filter((r) => !r.flushed);
  }

  /**
   * Mark records as flushed after successful processing.
   */
  markFlushed(intentIds: string[]): void {
    const idSet = new Set(intentIds);
    for (const record of this.data.records) {
      if (idSet.has(record.intentId)) {
        record.flushed = true;
      }
    }
    this.data.lastFlushedAt = new Date().toISOString();
    this.data.totalFlushed += intentIds.length;
    this.save();

    // Prune old flushed records (keep last 50)
    this.pruneOldRecords();
  }

  /**
   * Get manifest stats for display.
   */
  getStats(): {
    total: number;
    unflushed: number;
    orphanedIntents: number;
    lastFlushedAt: string | null;
  } {
    return {
      total: this.data.records.length,
      unflushed: this.data.records.filter((r) => !r.flushed).length,
      orphanedIntents: this.data.orphanedIntents?.length ?? 0,
      lastFlushedAt: this.data.lastFlushedAt,
    };
  }

  /**
   * Record an orphaned intent — a pending correlation that was never committed.
   * Called when the proxy detects stale correlations (e.g., session shutdown
   * with pending correlations older than the correlation window).
   */
  recordOrphanedIntents(
    intents: Array<{
      rootIntentId: string;
      prompt: string;
      toolChain: string[];
      files: string[];
      createdAt: string;
    }>,
  ): void {
    if (intents.length === 0) return;

    if (!this.data.orphanedIntents) {
      this.data.orphanedIntents = [];
    }

    for (const intent of intents) {
      this.data.orphanedIntents.push({
        intentId: intent.rootIntentId,
        prompt: intent.prompt,
        toolChain: intent.toolChain,
        filesAffected: intent.files,
        detectedAt: new Date().toISOString(),
        originalAt: intent.createdAt,
      });
    }

    // Keep only the last 100 orphaned intents
    if (this.data.orphanedIntents.length > 100) {
      this.data.orphanedIntents = this.data.orphanedIntents.slice(-100);
    }

    this.save();
  }

  /**
   * Get orphaned intents for display in workspace views.
   */
  getOrphanedIntents(): Array<{
    intentId: string;
    prompt: string;
    toolChain: string[];
    filesAffected: string[];
    detectedAt: string;
    originalAt: string;
  }> {
    return this.data.orphanedIntents ?? [];
  }

  // ── Internal ─────────────────────────────────────────────────────

  private load(): WorkspaceManifestData {
    if (!existsSync(this.manifestPath)) {
      return {
        version: 1,
        repoId: this.repoId,
        records: [],
        lastFlushedAt: null,
        totalFlushed: 0,
      };
    }

    try {
      const raw = readFileSync(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as WorkspaceManifestData;
      // Validate it's for this repo
      if (parsed.repoId !== this.repoId) {
        return {
          version: 1,
          repoId: this.repoId,
          records: [],
          lastFlushedAt: null,
          totalFlushed: 0,
        };
      }
      return parsed;
    } catch {
      return {
        version: 1,
        repoId: this.repoId,
        records: [],
        lastFlushedAt: null,
        totalFlushed: 0,
      };
    }
  }

  private save(): void {
    if (!existsSync(this.unerrDir)) {
      mkdirSync(this.unerrDir, { recursive: true });
    }
    writeFileSync(
      this.manifestPath,
      JSON.stringify(this.data, null, 2),
      "utf-8",
    );
  }

  private pruneOldRecords(): void {
    const flushed = this.data.records.filter((r) => r.flushed);
    if (flushed.length <= 50) return;

    // Keep only unflushed + last 50 flushed
    const unflushed = this.data.records.filter((r) => !r.flushed);
    const recentFlushed = flushed.slice(-50);
    this.data.records = [...recentFlushed, ...unflushed];
    this.save();
  }
}
