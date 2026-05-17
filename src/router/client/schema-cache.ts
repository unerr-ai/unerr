/**
 * Schema cache for downstream MCP server tool definitions.
 *
 * On first connect (or invalidation), fetches `tools/list` from the child
 * server and caches the result. Invalidated when:
 *   - Child emits `notifications/tools/list_changed`
 *   - Manual refresh triggered by health checker after restart
 *   - Cache TTL expires (default 5 minutes)
 *
 * The cache is purely in-memory — no disk persistence. It is reconstructed
 * on each proxy startup from live `tools/list` calls to connected servers.
 */

import type { ConnectionManager } from "./connection-manager.js";
import type { JsonRpcResponse } from "./transport.js";

export interface CachedToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface ServerSchemaEntry {
  readonly serverId: string;
  readonly tools: readonly CachedToolDefinition[];
  readonly fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;
let nextRequestId = 1_000_000;

export class SchemaCache {
  private readonly cache = new Map<string, ServerSchemaEntry>();
  private readonly connectionManager: ConnectionManager;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
  }

  /**
   * Fetch and cache tools/list for a single server.
   * Returns the cached entry (newly fetched or existing if fresh).
   */
  async fetchSchema(serverId: string): Promise<ServerSchemaEntry> {
    const existing = this.cache.get(serverId);
    if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) {
      return existing;
    }

    const response = await this.connectionManager.send(serverId, {
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "tools/list",
    });

    const tools = extractTools(response);
    const entry: ServerSchemaEntry = {
      serverId,
      tools,
      fetchedAt: Date.now(),
    };
    this.cache.set(serverId, entry);
    return entry;
  }

  /**
   * Fetch schemas for all connected servers in parallel.
   * Returns a map of serverId → entry. Failed fetches are omitted.
   */
  async fetchAll(serverIds: readonly string[]): Promise<ReadonlyMap<string, ServerSchemaEntry>> {
    const results = new Map<string, ServerSchemaEntry>();

    await Promise.all(
      serverIds.map(async (id) => {
        try {
          const entry = await this.fetchSchema(id);
          results.set(id, entry);
        } catch {
          // Failed fetch — server may be unhealthy; skip
        }
      }),
    );

    return results;
  }

  /**
   * Invalidate a single server's cached schema.
   * Called on `tools/list_changed` notification or after restart.
   */
  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  /**
   * Invalidate all cached schemas.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Get the cached entry for a server without fetching.
   */
  getCached(serverId: string): ServerSchemaEntry | undefined {
    const entry = this.cache.get(serverId);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return entry;
    }
    return undefined;
  }

  /**
   * Get all currently cached schemas (excludes expired entries).
   */
  getAllCached(): ReadonlyMap<string, ServerSchemaEntry> {
    const result = new Map<string, ServerSchemaEntry>();
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.fetchedAt < CACHE_TTL_MS) {
        result.set(id, entry);
      }
    }
    return result;
  }

  /**
   * Count total tools across all cached schemas.
   */
  totalToolCount(): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      count += entry.tools.length;
    }
    return count;
  }
}

function extractTools(response: JsonRpcResponse): CachedToolDefinition[] {
  if (response.error) return [];
  const result = response.result as { tools?: unknown[] } | undefined;
  if (!result?.tools || !Array.isArray(result.tools)) return [];

  return result.tools.map((t) => {
    const tool = t as Record<string, unknown>;
    return {
      name: (tool.name as string) ?? "",
      description: tool.description as string | undefined,
      inputSchema: tool.inputSchema,
    };
  });
}
