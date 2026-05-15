/**
 * Sprint 10.6: Ledger Circuit Breaker — hallucination loop detection.
 *
 * Detects when the AI enters a fix-break-fix-break cycle:
 * >4 consecutive broken entries on the same entity within 10 minutes.
 * Attaches a circuit_breaker payload to the internal `meta` carrier, which
 * `buildSignalPrefix()` drains into a `ur|hlt` prefix line on the response.
 *
 * Design authority: Phase 5.5 §1.2.8b (Ledger Circuit Breaker)
 */

/** stderr logger */
const _log = {
  info: (msg: string) =>
    process.stderr.write(`[unerr:circuit-breaker] ${msg}\n`),
  warn: (msg: string) =>
    process.stderr.write(`[unerr:circuit-breaker] WARN: ${msg}\n`),
};

/** Threshold: consecutive failed modifications to trigger halt. */
const CONSECUTIVE_THRESHOLD = 4;

/** Window: 10 minutes in milliseconds. */
const WINDOW_MS = 10 * 60 * 1000;

export interface CircuitBreakerMeta {
  /** Whether the circuit breaker has been triggered */
  triggered: boolean;
  /** Entity that is stuck in a loop */
  entity: string;
  /** Number of consecutive failed attempts */
  attempts: number;
  /** Human-readable message for the agent */
  message: string;
}

interface EntityAttempt {
  /** Timestamp of the attempt */
  timestamp: number;
  /** Whether rules/checks found violations */
  hadViolations: boolean;
}

export class LedgerCircuitBreaker {
  /**
   * Per-entity tracking of recent modification attempts.
   * Key: entity name or entity key.
   */
  private entityAttempts = new Map<string, EntityAttempt[]>();

  /**
   * Entities currently halted. Cleared when entity changes or user resets.
   */
  private haltedEntities = new Set<string>();

  /**
   * Record a sync_local_diff that touched an entity.
   * Call this after rule evaluation on sync.
   */
  recordAttempt(entity: string, hadViolations: boolean): void {
    const attempts = this.entityAttempts.get(entity) ?? [];
    attempts.push({ timestamp: Date.now(), hadViolations });
    this.entityAttempts.set(entity, attempts);

    // Prune old attempts outside the window
    this.pruneOldAttempts(entity);
  }

  /**
   * Check if any entity has tripped the circuit breaker.
   * Returns metadata to inject into _meta, or null if no trip.
   */
  check(entities: string[]): CircuitBreakerMeta | null {
    for (const entity of entities) {
      if (this.haltedEntities.has(entity)) {
        const attempts = this.entityAttempts.get(entity) ?? [];
        return {
          triggered: true,
          entity,
          attempts: attempts.length,
          message: formatHaltMessage(entity, attempts.length),
        };
      }

      const attempts = this.entityAttempts.get(entity) ?? [];
      if (attempts.length < CONSECUTIVE_THRESHOLD) continue;

      // Check if last N attempts all had violations within the window
      const now = Date.now();
      const recentAttempts = attempts.filter(
        (a) => now - a.timestamp < WINDOW_MS
      );

      if (recentAttempts.length < CONSECUTIVE_THRESHOLD) continue;

      // Check if the last CONSECUTIVE_THRESHOLD attempts all had violations
      const lastN = recentAttempts.slice(-CONSECUTIVE_THRESHOLD);
      const allHadViolations = lastN.every((a) => a.hadViolations);

      if (allHadViolations) {
        this.haltedEntities.add(entity);
        _log.warn(
          `Circuit breaker tripped for entity: ${entity} (${lastN.length} consecutive failures)`
        );
        return {
          triggered: true,
          entity,
          attempts: lastN.length,
          message: formatHaltMessage(entity, lastN.length),
        };
      }
    }

    return null;
  }

  /**
   * Reset the circuit breaker for a specific entity.
   * Called when the entity changes externally or user provides new instruction.
   */
  reset(entity: string): void {
    this.haltedEntities.delete(entity);
    this.entityAttempts.delete(entity);
    _log.info(`Circuit breaker reset for: ${entity}`);
  }

  /**
   * Reset all circuit breakers.
   */
  resetAll(): void {
    this.haltedEntities.clear();
    this.entityAttempts.clear();
    _log.info("All circuit breakers reset");
  }

  /**
   * Get list of currently halted entities.
   */
  getHaltedEntities(): string[] {
    return [...this.haltedEntities];
  }

  /**
   * Check if a specific entity is halted.
   */
  isHalted(entity: string): boolean {
    return this.haltedEntities.has(entity);
  }

  /**
   * Generate _context injection for the response envelope.
   * Returns null if no circuit breaker is triggered for the given entities.
   */
  toContextInjection(entities: string[]): Record<string, unknown> | null {
    const meta = this.check(entities);
    if (!meta) return null;
    return {
      "dev.unerr/circuit_breaker": {
        triggered: meta.triggered,
        entity: meta.entity,
        attempts: meta.attempts,
        message: meta.message,
        action:
          "Review previous attempts before retrying. Consider a different approach.",
      },
    };
  }

  private pruneOldAttempts(entity: string): void {
    const attempts = this.entityAttempts.get(entity);
    if (!attempts) return;

    const cutoff = Date.now() - WINDOW_MS;
    const pruned = attempts.filter((a) => a.timestamp > cutoff);

    if (pruned.length === 0) {
      this.entityAttempts.delete(entity);
      this.haltedEntities.delete(entity);
    } else {
      this.entityAttempts.set(entity, pruned);
    }
  }
}

/**
 * S9.4: Format halt message — clear, actionable, includes attempt count.
 */
export function formatHaltMessage(entity: string, attempts: number): string {
  return `Stop. You've tried modifying ${entity} ${attempts} times with violations each time. Each attempt produced rule violations within the last 10 minutes. Consider a fundamentally different approach or ask the user for guidance.`;
}
