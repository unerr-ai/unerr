/**
 * Intent Correlator — builds intent chains linking related tool calls.
 *
 * Maintains `pending_correlations.json` — intents that produced file changes
 * (via `sync_local_diff`) but haven't been committed yet. Each pending
 * correlation records the prompt, changed files, affected entities, and the
 * full tool chain that led to the change.
 *
 * Lifecycle:
 *   1. Tool calls flow through ShadowLedger → each gets an entry with correlation_id
 *   2. When sync_local_diff is called → IntentCorrelator creates a pending correlation
 *   3. On git commit (Sprint 5) → pending correlations are associated with commit SHA
 *   4. On push (Sprint 5) → committed entries flushed to local ledger
 *
 * All logging to stderr.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LedgerEntry, ShadowLedger } from "./shadow-ledger.js";

export interface PendingCorrelation {
  /** The root intent ID of the chain */
  rootIntentId: string;
  /** User prompt / description (from sync_local_diff args) */
  prompt: string;
  /** Files changed in this sync */
  files: string[];
  /** Entity keys affected */
  entities: string[];
  /** Ordered list of tool names in the chain */
  toolChain: string[];
  /** When this correlation was created */
  createdAt: string;
  /** Commit SHA if associated (set by commit watcher in Sprint 5) */
  commitSha?: string;
}

export class IntentCorrelator {
  private ledgerDir: string;
  private pendingPath: string;
  private pending: PendingCorrelation[] = [];

  constructor(unerrDir: string) {
    this.ledgerDir = join(unerrDir, "ledger");
    this.pendingPath = join(this.ledgerDir, "pending_correlations.json");

    if (!existsSync(this.ledgerDir)) {
      mkdirSync(this.ledgerDir, { recursive: true });
    }

    this.load();
  }

  /**
   * Called when sync_local_diff is invoked. Creates a pending correlation
   * from the active tool chain in the ledger.
   */
  onSyncLocalDiff(
    ledger: ShadowLedger,
    args: Record<string, unknown>
  ): PendingCorrelation | null {
    const rootId = ledger.getCurrentRootId();
    if (!rootId) return null;

    // Extract data from sync_local_diff args
    const prompt = (args.prompt as string) ?? (args.message as string) ?? "";
    const filesChanged = extractFiles(args);
    const entitiesAffected = extractEntities(args);

    // Build the tool chain from ledger buffer
    const recentEntries = ledger.getRecentEntries(50);
    const toolChain = buildToolChain(recentEntries, rootId);

    const correlation: PendingCorrelation = {
      rootIntentId: rootId,
      prompt,
      files: filesChanged,
      entities: entitiesAffected,
      toolChain,
      createdAt: new Date().toISOString(),
    };

    this.pending.push(correlation);
    this.save();

    return correlation;
  }

  /**
   * Get all pending correlations (not yet committed).
   */
  getPending(): PendingCorrelation[] {
    return this.pending.filter((c) => !c.commitSha);
  }

  /**
   * Get all pending correlations (including committed but not flushed).
   */
  getAll(): PendingCorrelation[] {
    return [...this.pending];
  }

  /**
   * Get the count of pending correlations.
   */
  getPendingCount(): number {
    return this.pending.filter((c) => !c.commitSha).length;
  }

  /**
   * Associate pending correlations with a commit SHA.
   * Called by the commit watcher when HEAD changes.
   * Only associates correlations whose files appear in the commit diff.
   */
  associateCommit(commitSha: string, committedFiles: string[]): number {
    let associated = 0;
    const committedSet = new Set(committedFiles);

    for (const correlation of this.pending) {
      if (correlation.commitSha) continue; // Already committed

      // Check if any of the correlation's files are in the commit
      const hasOverlap = correlation.files.some((f) => committedSet.has(f));
      if (hasOverlap) {
        correlation.commitSha = commitSha;
        associated++;
      }
    }

    if (associated > 0) {
      this.save();
    }

    return associated;
  }

  /**
   * Get committed but not-yet-flushed correlations (for Sprint 5 push).
   */
  getCommittedUnflushed(): PendingCorrelation[] {
    return this.pending.filter((c) => c.commitSha != null);
  }

  /**
   * Remove correlations that have been flushed.
   * Called after successful flush in Sprint 5.
   */
  removeFlushed(rootIntentIds: string[]): void {
    const flushedSet = new Set(rootIntentIds);
    this.pending = this.pending.filter((c) => !flushedSet.has(c.rootIntentId));
    this.save();
  }

  /**
   * Clear all pending correlations (e.g., on branch switch).
   */
  clear(): void {
    this.pending = [];
    this.save();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.pendingPath)) return;

    try {
      const raw = readFileSync(this.pendingPath, "utf-8");
      const parsed = JSON.parse(raw) as PendingCorrelation[];
      if (Array.isArray(parsed)) {
        this.pending = parsed;
      }
    } catch {
      // Corrupted file — start fresh
      this.pending = [];
    }
  }

  private save(): void {
    try {
      const tmpPath = `${this.pendingPath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.pending, null, 2), "utf-8");
      renameSync(tmpPath, this.pendingPath);
    } catch (err: unknown) {
      process.stderr.write(
        `[unerr:correlator] WARN: Failed to save pending correlations: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
}

/**
 * Extract changed file paths from sync_local_diff args.
 */
function extractFiles(args: Record<string, unknown>): string[] {
  // Structured format: { files: [{ path, content }] }
  const files = args.files as Array<{ path: string }> | undefined;
  if (files && Array.isArray(files)) {
    return files.map((f) => f.path).filter(Boolean);
  }

  // Diff format: parse git diff for file paths
  const diff = args.diff as string | undefined;
  if (diff) {
    const paths = new Set<string>();
    const matches = diff.matchAll(/^(?:---|\+\+\+)\s+[ab]\/(.+)$/gm);
    for (const m of matches) {
      if (m[1]) paths.add(m[1]);
    }
    return Array.from(paths);
  }

  // filesChanged from args directly
  const filesChanged = args.filesChanged as string[] | undefined;
  if (filesChanged && Array.isArray(filesChanged)) {
    return filesChanged;
  }

  return [];
}

/**
 * Extract affected entity keys from sync_local_diff args.
 */
function extractEntities(args: Record<string, unknown>): string[] {
  const entities = args.entitiesAffected as string[] | undefined;
  if (entities && Array.isArray(entities)) {
    return entities;
  }
  return [];
}

/**
 * Build the tool chain for a correlation by following the intent chain
 * from root to the current sync_local_diff call.
 */
function buildToolChain(entries: LedgerEntry[], rootId: string): string[] {
  const chain: string[] = [];

  for (const entry of entries) {
    // Include the root entry itself
    if (entry.id === rootId) {
      chain.push(entry.tool);
    }
    // Include correlated entries
    else if (entry.correlation_id === rootId) {
      chain.push(entry.tool);
    }
  }

  return chain;
}
