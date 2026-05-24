/**
 * Connection manager for N downstream MCP server connections.
 *
 * Responsibilities:
 *   - Spawn/connect transport per server config
 *   - Exponential-backoff restart on crash (max 5 restarts by default)
 *   - Per-server state tracking (connected, error, restarting)
 *   - Graceful shutdown of all children
 *
 * This is the single owner of all downstream transports.
 * SchemaCache, Forwarder, HealthChecker compose on top of it.
 */

import type { ProxiedServerConfig } from "../../config/router-config-writer.js";
import { HttpTransport } from "./http-transport.js";
import { SseTransport } from "./sse-transport.js";
import { StdioTransport } from "./stdio-transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  TransportState,
} from "./transport.js";

export type ServerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "restarting"
  | "stopped";

export interface ManagedServer {
  readonly config: ProxiedServerConfig;
  readonly transport: McpTransport;
  status: ServerStatus;
  restartCount: number;
  lastError: string | null;
  lastConnectedAt: number | null;
}

export interface ConnectionManagerEvents {
  onServerStateChange?: (serverId: string, status: ServerStatus) => void;
  onServerNotification?: (
    serverId: string,
    notification: JsonRpcNotification
  ) => void;
  onServerError?: (serverId: string, error: Error) => void;
}

const DEFAULT_MAX_RESTARTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function createTransport(
  config: ProxiedServerConfig,
  events: ConnectionManagerEvents
): McpTransport {
  const transportEvents = {
    onNotification: (n: JsonRpcNotification) =>
      events.onServerNotification?.(config.name, n),
    onStateChange: (_s: TransportState) => {},
    onError: (err: Error) => events.onServerError?.(config.name, err),
  };

  const transportType = config.type ?? "stdio";

  switch (transportType) {
    case "sse":
      return new SseTransport({
        serverId: config.name,
        url: config.command ?? "",
        events: transportEvents,
      });
    case "http":
      return new HttpTransport({
        serverId: config.name,
        url: config.command ?? "",
        events: transportEvents,
      });
    default:
      return new StdioTransport({
        serverId: config.name,
        command: config.command ?? "",
        args: config.args ?? [],
        env: config.env as Record<string, string> | undefined,
        events: transportEvents,
      });
  }
}

export class ConnectionManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly events: ConnectionManagerEvents;
  private readonly maxRestarts: number;
  private shutdownRequested = false;

  constructor(
    events: ConnectionManagerEvents = {},
    maxRestarts = DEFAULT_MAX_RESTARTS
  ) {
    this.events = events;
    this.maxRestarts = maxRestarts;
  }

  /**
   * Register and connect all configured servers.
   * Returns the list of server IDs that failed to connect.
   */
  async connectAll(
    configs: readonly ProxiedServerConfig[]
  ): Promise<readonly string[]> {
    const failures: string[] = [];

    const connectPromises = configs.map(async (config) => {
      const transport = createTransport(config, this.events);
      const managed: ManagedServer = {
        config,
        transport,
        status: "idle",
        restartCount: 0,
        lastError: null,
        lastConnectedAt: null,
      };
      this.servers.set(config.name, managed);

      try {
        managed.status = "connecting";
        this.events.onServerStateChange?.(config.name, "connecting");
        await transport.connect();
        managed.status = "connected";
        managed.lastConnectedAt = Date.now();
        this.events.onServerStateChange?.(config.name, "connected");
      } catch (err) {
        managed.status = "error";
        managed.lastError = (err as Error).message;
        this.events.onServerStateChange?.(config.name, "error");
        failures.push(config.name);
      }
    });

    await Promise.all(connectPromises);
    return failures;
  }

  /**
   * Get a managed server by ID.
   */
  getServer(serverId: string): ManagedServer | undefined {
    return this.servers.get(serverId);
  }

  /**
   * Get all managed servers.
   */
  getAllServers(): ReadonlyMap<string, ManagedServer> {
    return this.servers;
  }

  /**
   * Send a request to a specific server's transport.
   */
  async send(
    serverId: string,
    request: JsonRpcRequest
  ): Promise<JsonRpcResponse> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Unknown server: ${serverId}`);
    }
    if (managed.status !== "connected") {
      throw new Error(`Server ${serverId} is ${managed.status}, cannot send`);
    }
    return managed.transport.send(request);
  }

  /**
   * Restart a single server with exponential backoff.
   */
  async restart(serverId: string): Promise<boolean> {
    const managed = this.servers.get(serverId);
    if (!managed) return false;
    if (this.shutdownRequested) return false;

    if (managed.restartCount >= this.maxRestarts) {
      managed.status = "stopped";
      managed.lastError = `Exceeded max restarts (${this.maxRestarts})`;
      this.events.onServerStateChange?.(serverId, "stopped");
      return false;
    }

    managed.status = "restarting";
    this.events.onServerStateChange?.(serverId, "restarting");

    const backoffMs = Math.min(
      BASE_BACKOFF_MS * 2 ** managed.restartCount,
      MAX_BACKOFF_MS
    );

    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    if (this.shutdownRequested) return false;

    try {
      await managed.transport.close();
    } catch {
      // best-effort cleanup
    }

    const newTransport = createTransport(managed.config, this.events);
    (managed as { transport: McpTransport }).transport = newTransport;
    managed.restartCount++;

    try {
      await newTransport.connect();
      managed.status = "connected";
      managed.lastConnectedAt = Date.now();
      managed.lastError = null;
      this.events.onServerStateChange?.(serverId, "connected");
      return true;
    } catch (err) {
      managed.status = "error";
      managed.lastError = (err as Error).message;
      this.events.onServerStateChange?.(serverId, "error");
      return false;
    }
  }

  /**
   * Gracefully shut down all connections.
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;

    const closePromises = Array.from(this.servers.values()).map(
      async (managed) => {
        try {
          await managed.transport.close();
        } catch {
          // best-effort
        }
        managed.status = "stopped";
      }
    );

    await Promise.all(closePromises);
    this.servers.clear();
  }

  /**
   * Get status snapshot for all servers.
   */
  getStatusSnapshot(): readonly {
    serverId: string;
    status: ServerStatus;
    restartCount: number;
    lastError: string | null;
  }[] {
    return Array.from(this.servers.entries()).map(([id, s]) => ({
      serverId: id,
      status: s.status,
      restartCount: s.restartCount,
      lastError: s.lastError,
    }));
  }
}
