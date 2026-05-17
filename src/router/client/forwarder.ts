/**
 * Tool-call forwarder — routes `tools/call` requests to the correct
 * downstream MCP server.
 *
 * The forwarder resolves the target server from the tool name, builds
 * the JSON-RPC request, sends it through the ConnectionManager, and
 * returns the response. It does NOT rewrite tool names — that is the
 * aliasing layer's job (Sprint P1-2). This module is pure dispatch.
 */

import type { ConnectionManager } from "./connection-manager.js";
import type { JsonRpcResponse } from "./transport.js";

export interface ForwardRequest {
  readonly serverId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

export interface ForwardResult {
  readonly response: JsonRpcResponse;
  readonly serverId: string;
  readonly latencyMs: number;
}

let nextForwardId = 2_000_000;

export class Forwarder {
  private readonly connectionManager: ConnectionManager;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
  }

  /**
   * Forward a tool call to the specified server.
   * Returns the raw JSON-RPC response + timing metadata.
   */
  async forward(request: ForwardRequest): Promise<ForwardResult> {
    const start = performance.now();
    const server = this.connectionManager.getServer(request.serverId);

    if (!server) {
      return {
        response: makeErrorResponse(
          nextForwardId++,
          -32001,
          `Unknown server: ${request.serverId}`,
        ),
        serverId: request.serverId,
        latencyMs: performance.now() - start,
      };
    }

    if (server.status !== "connected") {
      return {
        response: makeErrorResponse(
          nextForwardId++,
          -32002,
          `Server ${request.serverId} is ${server.status}`,
        ),
        serverId: request.serverId,
        latencyMs: performance.now() - start,
      };
    }

    const id = nextForwardId++;

    try {
      const response = await this.connectionManager.send(request.serverId, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: request.toolName,
          arguments: request.args,
        },
      });

      return {
        response,
        serverId: request.serverId,
        latencyMs: performance.now() - start,
      };
    } catch (err) {
      return {
        response: makeErrorResponse(
          id,
          -32003,
          `Forward to ${request.serverId} failed: ${(err as Error).message}`,
        ),
        serverId: request.serverId,
        latencyMs: performance.now() - start,
      };
    }
  }

  /**
   * Check if a server is available for forwarding.
   */
  isServerAvailable(serverId: string): boolean {
    const server = this.connectionManager.getServer(serverId);
    return server?.status === "connected";
  }
}

function makeErrorResponse(
  id: number,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}
