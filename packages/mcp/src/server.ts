/**
 * MCP Server Factory — creates a transport-agnostic MCP server.
 *
 * The factory pattern separates tool registration from transport selection.
 * Tool definitions and handlers are injected by the caller (root proxy).
 * Transport (STDIO, HTTP) is selected separately.
 *
 * This enables:
 *   - Root proxy: uses STDIO transport for IDE integration
 *   - CI/Remote: uses HTTP transport for web access
 *   - Testing: uses InMemoryTransport for unit tests
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServerConfig,
  McpServerInstance,
} from "./types.js";

/**
 * Create an MCP server with registered tools and call handler.
 * Returns the server instance — caller connects the transport.
 */
export function createMcpServer(config: McpServerConfig): McpServerInstance {
  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: config.tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = await config.onToolCall(name, args);
      return {
        content: result.content,
        ...(result._meta ? { _meta: result._meta } : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return { server, config };
}
