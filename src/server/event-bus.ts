/**
 * Layer 7: Process-wide event bus for dashboard SSE transport.
 *
 * Bridges tool_call, drift, violation, circuit_breaker, and intent payloads to
 * the SSE stream. The stream also emits session_stats and ping (not from the
 * buffer). Circular buffer: 100 events for reconnect backfill.
 */

export interface BusEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

type BusListener = (event: BusEvent) => void;

const BUFFER_SIZE = 100;

class EventBus {
  private listeners = new Set<BusListener>();
  private buffer: BusEvent[] = [];
  private bufferIdx = 0;
  private bufferFull = false;

  emit(type: string, data: unknown): void {
    const event: BusEvent = { type, data, timestamp: Date.now() };

    // Write to circular buffer
    this.buffer[this.bufferIdx] = event;
    this.bufferIdx = (this.bufferIdx + 1) % BUFFER_SIZE;
    if (this.bufferIdx === 0) this.bufferFull = true;

    // Notify all listeners
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let a listener crash the emitter
      }
    }
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Return recent events for SSE backfill (oldest first).
   */
  getRecentEvents(limit = 20): BusEvent[] {
    const total = this.bufferFull ? BUFFER_SIZE : this.bufferIdx;
    if (total === 0) return [];

    const events: BusEvent[] = [];
    const start = this.bufferFull ? this.bufferIdx : 0;

    for (let i = 0; i < total; i++) {
      const idx = (start + i) % BUFFER_SIZE;
      const event = this.buffer[idx];
      if (event) events.push(event);
    }

    return events.slice(-limit);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Singleton instance — shared across the entire proxy process. */
export const eventBus = new EventBus();
