/**
 * Notification emitter for the MCP gateway.
 *
 * Sends `notifications/tools/list_changed` to the connected client when
 * the visible tool set changes (tools unlocked during a session).
 *
 * Features:
 *   - Throttle: min 250ms between notifications (coalesce rapid unlocks)
 *   - Stale-list detection: if client doesn't refetch within 5s after
 *     notification, log a warning; if persistent (3 consecutive misses),
 *     demote to static mode for the session
 *   - Transport-agnostic: emits via a callback (stdio write / SSE push)
 */

import type { JsonRpcNotification } from "./client/transport.js";

const THROTTLE_MS = 250;
const STALE_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_STALE = 3;

export type NotificationSender = (notification: JsonRpcNotification) => void;

export interface NotificationEmitterEvents {
  onDemotedToStatic?: () => void;
  onStaleDetected?: (consecutiveCount: number) => void;
}

export class NotificationEmitter {
  private readonly send: NotificationSender;
  private readonly events: NotificationEmitterEvents;
  private lastEmitAt = 0;
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveStale = 0;
  private _demoted = false;
  private _pendingNotification = false;
  private _totalEmitted = 0;
  private _totalStale = 0;

  constructor(send: NotificationSender, events: NotificationEmitterEvents = {}) {
    this.send = send;
    this.events = events;
  }

  /**
   * Whether the client has been demoted to static mode due to
   * persistent failure to refetch after notifications.
   */
  get isDemoted(): boolean {
    return this._demoted;
  }

  get totalEmitted(): number {
    return this._totalEmitted;
  }

  get totalStale(): number {
    return this._totalStale;
  }

  /**
   * Emit a `tools/list_changed` notification, respecting throttle.
   *
   * If called within the throttle window, the notification is queued
   * and flushed after the window expires (coalescing rapid unlocks).
   *
   * Returns false if demoted to static (no notification sent).
   */
  notify(): boolean {
    if (this._demoted) return false;

    const now = Date.now();
    const elapsed = now - this.lastEmitAt;

    if (elapsed >= THROTTLE_MS) {
      this.emitNow();
      return true;
    }

    if (!this.pendingFlush) {
      const delay = THROTTLE_MS - elapsed;
      this._pendingNotification = true;
      this.pendingFlush = setTimeout(() => {
        this.pendingFlush = null;
        if (this._pendingNotification) {
          this._pendingNotification = false;
          this.emitNow();
        }
      }, delay);
    }

    return true;
  }

  /**
   * Call when the client sends a `tools/list` request after a notification.
   * Resets the stale-detection timer and consecutive stale count.
   */
  markRefetch(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    this.consecutiveStale = 0;
  }

  /**
   * Forcefully flush any pending throttled notification.
   */
  flush(): void {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this._pendingNotification) {
      this._pendingNotification = false;
      this.emitNow();
    }
  }

  /**
   * Clean up timers on shutdown.
   */
  shutdown(): void {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private emitNow(): void {
    this.lastEmitAt = Date.now();
    this._totalEmitted++;

    this.send({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });

    this.startStaleTimer();
  }

  private startStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
    }

    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.consecutiveStale++;
      this._totalStale++;

      process.stderr.write(
        `  ⚠ Stale list: client did not refetch within ${STALE_TIMEOUT_MS}ms (consecutive: ${this.consecutiveStale})\n`,
      );

      this.events.onStaleDetected?.(this.consecutiveStale);

      if (this.consecutiveStale >= MAX_CONSECUTIVE_STALE) {
        this._demoted = true;
        process.stderr.write(
          `  ⚠ Client demoted to static mode after ${MAX_CONSECUTIVE_STALE} consecutive stale notifications\n`,
        );
        this.events.onDemotedToStatic?.();
      }
    }, STALE_TIMEOUT_MS);
  }
}
