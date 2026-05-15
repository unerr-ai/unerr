/**
 * Commit Watcher — detects git commits by polling HEAD SHA.
 *
 * Polls `git rev-parse HEAD` every 5s (same cadence as branch poller).
 * When HEAD SHA changes:
 *   1. Extracts changed files via `git diff --name-only {old}..{new}`
 *   2. Calls IntentCorrelator.associateCommit(commitSha, files)
 *   3. Optionally triggers a flush callback
 *
 * All logging to stderr. Timer is unref'd so it doesn't keep the process alive.
 */

import { getChangedFiles, getHeadSha } from "../utils/git.js";
import { createModuleLogger } from "../utils/logger.js";
import type { BranchContext } from "./branch-context.js";
import type { IntentCorrelator } from "./intent-correlator.js";
import { encodeIntentAsNote } from "./intent-encoder.js";

const log = createModuleLogger("commit");

const DEFAULT_POLL_MS = 5_000;

export interface CommitWatcherOptions {
  cwd?: string;
  pollIntervalMs?: number;
  sessionId?: string;
  onCommit?: (commitSha: string, files: string[], associated: number) => void;
}

export class CommitWatcher {
  private cwd: string;
  private pollIntervalMs: number;
  private correlator: IntentCorrelator;
  private onCommit?: CommitWatcherOptions["onCommit"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeadSha: string | null = null;
  private running = false;
  private sessionId: string;
  private branchContext: BranchContext | null = null;
  private driftSummaryFn:
    | (() => Promise<{ added: number; modified: number; deleted: number }>)
    | null = null;

  constructor(correlator: IntentCorrelator, opts: CommitWatcherOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.correlator = correlator;
    this.onCommit = opts.onCommit;
    this.sessionId = opts.sessionId ?? "";
  }

  /**
   * Set branch context for git note encoding.
   */
  setBranchContext(ctx: BranchContext): void {
    this.branchContext = ctx;
  }

  /**
   * Set drift summary provider for git note encoding.
   */
  setDriftSummaryFn(
    fn: () => Promise<{ added: number; modified: number; deleted: number }>
  ): void {
    this.driftSummaryFn = fn;
  }

  /**
   * Start polling for commits. Captures initial HEAD SHA on first call.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.lastHeadSha = await getHeadSha(this.cwd);

    this.timer = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);

    // Don't keep process alive just for commit watching
    this.timer.unref();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get the last known HEAD SHA (for testing/status).
   */
  getLastHeadSha(): string | null {
    return this.lastHeadSha;
  }

  /**
   * Force a poll cycle (useful for testing).
   */
  async poll(): Promise<void> {
    try {
      const currentHead = await getHeadSha(this.cwd);
      if (!currentHead) return;

      if (this.lastHeadSha && currentHead !== this.lastHeadSha) {
        const files = await getChangedFiles(
          this.cwd,
          this.lastHeadSha,
          currentHead
        );
        const associated = this.correlator.associateCommit(currentHead, files);

        if (associated > 0) {
          log.info(
            `Commit ${currentHead.slice(0, 8)}: associated ${associated} pending correlation(s)`
          );

          const committed = this.correlator
            .getCommittedUnflushed()
            .filter((c) => c.commitSha === currentHead);
          if (committed.length > 0 && this.sessionId) {
            const drift = this.driftSummaryFn
              ? await this.driftSummaryFn()
              : {
                  added: 0,
                  modified: 0,
                  deleted: 0,
                };
            encodeIntentAsNote(
              currentHead,
              committed,
              this.sessionId,
              this.branchContext,
              drift,
              this.cwd
            ).catch(() => {
              /* fire-and-forget */
            });
          }
        }

        this.onCommit?.(currentHead, files, associated);
      }

      this.lastHeadSha = currentHead;
    } catch {
      // Git errors are non-fatal — skip this cycle
    }
  }
}
