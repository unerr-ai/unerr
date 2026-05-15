/**
 * File Hash State Manager — tracks per-file content SHAs for state-aware skipping.
 *
 * Manages `.unerr/state/file_hashes.json` with the skip decision tree:
 *   - Content SHA unchanged + HEAD SHA unchanged → SKIP
 *   - Content SHA unchanged + HEAD SHA changed   → SKIP scan, UPDATE head_sha
 *   - Content SHA changed                        → PROCESS
 *
 * Uses atomic write (write to .tmp, rename) for crash safety.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface FileHashEntry {
  /** SHA-256 of the file's content */
  contentSha: string;
  /** Git HEAD SHA when this entry was last processed */
  headSha: string;
  /** Timestamp of last processing */
  processedAt: string;
}

export type SkipDecision = "skip" | "process";

export interface FileHashState {
  files: Record<string, FileHashEntry>;
}

const STATE_FILE = "file_hashes.json";

export class FileHashManager {
  private stateDir: string;
  private statePath: string;
  private state: FileHashState;

  constructor(unerrDir: string) {
    this.stateDir = join(unerrDir, "state");
    this.statePath = join(this.stateDir, STATE_FILE);
    this.state = this.load();
  }

  /**
   * Determine if a file should be processed or skipped.
   */
  shouldProcess(
    filePath: string,
    contentSha: string,
    headSha: string
  ): SkipDecision {
    const entry = this.state.files[filePath];
    if (!entry) return "process";

    if (entry.contentSha !== contentSha) {
      // Content changed → must process
      return "process";
    }

    if (entry.headSha !== headSha) {
      // Content same but HEAD moved (e.g., commit or rebase) → skip but update headSha
      entry.headSha = headSha;
      entry.processedAt = new Date().toISOString();
      // Defer save — caller should call save() after batch
    }

    return "skip";
  }

  /**
   * Mark a file as processed with the given content and HEAD SHAs.
   */
  markProcessed(filePath: string, contentSha: string, headSha: string): void {
    this.state.files[filePath] = {
      contentSha,
      headSha,
      processedAt: new Date().toISOString(),
    };
  }

  /**
   * Remove tracking for a specific file.
   */
  remove(filePath: string): void {
    delete this.state.files[filePath];
  }

  /**
   * Clear all file hash state.
   */
  clearAll(): void {
    this.state.files = {};
    this.save();
  }

  /**
   * Persist state to disk atomically (write .tmp → rename).
   */
  save(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
    const tmpPath = `${this.statePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf-8");
    renameSync(tmpPath, this.statePath);
  }

  /**
   * Get the number of tracked files.
   */
  get trackedCount(): number {
    return Object.keys(this.state.files).length;
  }

  /**
   * Get the full state (for debugging / `unerr debug`).
   */
  getState(): Readonly<FileHashState> {
    return this.state;
  }

  /**
   * Restore state from a snapshot (e.g., branch switch restore).
   * Replaces current in-memory state without persisting to disk.
   */
  restoreState(snapshot: FileHashState): void {
    this.state = { files: { ...snapshot.files } };
  }

  private load(): FileHashState {
    if (!existsSync(this.statePath)) {
      return { files: {} };
    }
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      return JSON.parse(raw) as FileHashState;
    } catch {
      return { files: {} };
    }
  }
}

/**
 * Compute SHA-256 hex digest of file content.
 */
export function contentSha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
