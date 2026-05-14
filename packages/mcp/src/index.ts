/**
 * @unerr/unerr-mcp — Transport-agnostic MCP server factory.
 *
 * Usage:
 *   import { createMcpServer } from "@unerr/unerr-mcp";
 *   import { connectStdio } from "@unerr/unerr-mcp/transports/stdio";
 *
 *   const instance = createMcpServer({ name, version, tools, onToolCall });
 *   await connectStdio(instance);
 */

export { createMcpServer } from "./server.js";
export type {
  McpServerConfig,
  McpServerInstance,
  McpToolCallResult,
  McpToolDefinition,
  McpToolHandler,
} from "./types.js";
