/**
 * Circuit breaker for the MCP gateway.
 *
 * If the gateway itself encounters a critical failure (unhandled exception,
 * all child servers down, resource exhaustion), the circuit breaker trips
 * and the gateway falls back to full-passthrough mode within 200ms.
 *
 * In passthrough mode, the proxy simply relays JSON-RPC frames between
 * the IDE and the child servers without applying any curation, masking,
 * or telemetry. This ensures the developer never loses tool access due
 * to a gateway bug.
 *
 * States:
 *   - closed: normal operation (gateway curating)
 *   - open: passthrough mode (gateway failed, raw relay)
 *   - half-open: testing recovery (one request goes through gateway logic)
 *
 * The breaker auto-attempts recovery every 30s in open state.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerEvents {
  onStateChange?: (state: CircuitState) => void;
  onTrip?: (reason: string) => void;
  onRecover?: () => void;
}

const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const TRIP_LATENCY_BUDGET_MS = 200;

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private failureCount = 0;
  private readonly failureThreshold: number;
  private readonly recoveryIntervalMs: number;
  private readonly events: CircuitBreakerEvents;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTripReason: string | null = null;
  private lastTripAt: number | null = null;

  constructor(
    events: CircuitBreakerEvents = {},
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
  ) {
    this.events = events;
    this.failureThreshold = failureThreshold;
    this.recoveryIntervalMs = recoveryIntervalMs;
  }

  get state(): CircuitState {
    return this._state;
  }

  get isPassthrough(): boolean {
    return this._state === "open";
  }

  get tripReason(): string | null {
    return this.lastTripReason;
  }

  /**
   * Record a gateway-level failure. Trips the breaker if threshold exceeded.
   */
  recordFailure(reason: string): void {
    this.failureCount++;
    if (this._state === "half-open") {
      this.trip(reason);
    } else if (this.failureCount >= this.failureThreshold && this._state === "closed") {
      this.trip(reason);
    }
  }

  /**
   * Record a successful gateway operation. Resets failure count.
   * In half-open state, transitions back to closed.
   */
  recordSuccess(): void {
    this.failureCount = 0;
    if (this._state === "half-open") {
      this.close();
    }
  }

  /**
   * Manually trip the circuit breaker. Used for critical failures
   * that should immediately enter passthrough.
   */
  trip(reason: string): void {
    const start = performance.now();
    this.lastTripReason = reason;
    this.lastTripAt = Date.now();
    this._state = "open";
    this.events.onTrip?.(reason);
    this.events.onStateChange?.("open");
    this.scheduleRecovery();

    const elapsed = performance.now() - start;
    if (elapsed > TRIP_LATENCY_BUDGET_MS) {
      process.stderr.write(
        `[circuit-breaker] WARNING: trip took ${elapsed.toFixed(1)}ms (budget: ${TRIP_LATENCY_BUDGET_MS}ms)\n`,
      );
    }
  }

  /**
   * Attempt recovery: move to half-open for a single test request.
   */
  attemptRecovery(): void {
    if (this._state !== "open") return;
    this._state = "half-open";
    this.events.onStateChange?.("half-open");
  }

  /**
   * Execute a function with circuit-breaker protection.
   * If the breaker is open, returns the fallback immediately.
   * If half-open, allows one test call.
   */
  async execute<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this._state === "open") {
      return fallback();
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure((err as Error).message);
      if (this.isPassthrough) {
        return fallback();
      }
      throw err;
    }
  }

  /**
   * Get diagnostic snapshot.
   */
  getSnapshot(): {
    state: CircuitState;
    failureCount: number;
    tripReason: string | null;
    tripAt: number | null;
  } {
    return {
      state: this._state,
      failureCount: this.failureCount,
      tripReason: this.lastTripReason,
      tripAt: this.lastTripAt,
    };
  }

  /**
   * Shutdown — clear timers.
   */
  shutdown(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private close(): void {
    this._state = "closed";
    this.failureCount = 0;
    this.lastTripReason = null;
    this.lastTripAt = null;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.events.onRecover?.();
    this.events.onStateChange?.("closed");
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }
    this.recoveryTimer = setTimeout(() => {
      this.attemptRecovery();
    }, this.recoveryIntervalMs);
  }
}
