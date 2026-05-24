/**
 * Health checker for downstream MCP servers.
 *
 * Periodically pings each connected server with a `ping` request.
 * After 3 consecutive failures, marks the server as unhealthy and
 * triggers a restart via the ConnectionManager.
 *
 * Health check interval is configurable per-server (default 30s).
 * The checker stops on shutdown and cleans up all timers.
 */

import type { ConnectionManager } from "./connection-manager.js";
import type { SchemaCache } from "./schema-cache.js";

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

let nextPingId = 3_000_000;

export interface HealthStatus {
  readonly serverId: string;
  readonly healthy: boolean;
  readonly consecutiveFailures: number;
  readonly lastCheckAt: number | null;
  readonly lastSuccessAt: number | null;
}

export class HealthChecker {
  private readonly connectionManager: ConnectionManager;
  private readonly schemaCache: SchemaCache;
  private readonly intervalMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly state = new Map<
    string,
    {
      consecutiveFailures: number;
      lastCheckAt: number | null;
      lastSuccessAt: number | null;
    }
  >();
  private stopped = false;

  constructor(
    connectionManager: ConnectionManager,
    schemaCache: SchemaCache,
    intervalMs = DEFAULT_INTERVAL_MS
  ) {
    this.connectionManager = connectionManager;
    this.schemaCache = schemaCache;
    this.intervalMs = intervalMs;
  }

  /**
   * Start periodic health checks for a set of servers.
   */
  start(serverIds: readonly string[]): void {
    this.stopped = false;
    for (const id of serverIds) {
      if (this.timers.has(id)) continue;
      this.state.set(id, {
        consecutiveFailures: 0,
        lastCheckAt: null,
        lastSuccessAt: null,
      });
      const timer = setInterval(() => void this.check(id), this.intervalMs);
      this.timers.set(id, timer);
    }
  }

  /**
   * Stop all health checks.
   */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /**
   * Run a single health check for one server.
   */
  async check(serverId: string): Promise<boolean> {
    if (this.stopped) return false;

    const serverState = this.state.get(serverId);
    if (!serverState) return false;

    const server = this.connectionManager.getServer(serverId);
    if (!server || server.status !== "connected") {
      serverState.consecutiveFailures++;
      serverState.lastCheckAt = Date.now();

      if (serverState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.handleUnhealthy(serverId);
      }
      return false;
    }

    try {
      await this.connectionManager.send(serverId, {
        jsonrpc: "2.0",
        id: nextPingId++,
        method: "ping",
      });

      serverState.consecutiveFailures = 0;
      serverState.lastCheckAt = Date.now();
      serverState.lastSuccessAt = Date.now();
      return true;
    } catch {
      serverState.consecutiveFailures++;
      serverState.lastCheckAt = Date.now();

      if (serverState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.handleUnhealthy(serverId);
      }
      return false;
    }
  }

  /**
   * Get health status for all monitored servers.
   */
  getHealthStatuses(): readonly HealthStatus[] {
    return Array.from(this.state.entries()).map(([id, s]) => ({
      serverId: id,
      healthy: s.consecutiveFailures < MAX_CONSECUTIVE_FAILURES,
      consecutiveFailures: s.consecutiveFailures,
      lastCheckAt: s.lastCheckAt,
      lastSuccessAt: s.lastSuccessAt,
    }));
  }

  /**
   * Get health status for a single server.
   */
  getHealth(serverId: string): HealthStatus | undefined {
    const s = this.state.get(serverId);
    if (!s) return undefined;
    return {
      serverId,
      healthy: s.consecutiveFailures < MAX_CONSECUTIVE_FAILURES,
      consecutiveFailures: s.consecutiveFailures,
      lastCheckAt: s.lastCheckAt,
      lastSuccessAt: s.lastSuccessAt,
    };
  }

  private async handleUnhealthy(serverId: string): Promise<void> {
    const restarted = await this.connectionManager.restart(serverId);
    if (restarted) {
      const serverState = this.state.get(serverId);
      if (serverState) {
        serverState.consecutiveFailures = 0;
      }
      this.schemaCache.invalidate(serverId);
    }
  }
}
