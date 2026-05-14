/**
 * MCP Server Types — shared interfaces for the transport-agnostic factory.
 *
 * These types define the contract between tool implementors (root proxy)
 * and the MCP server infrastructure (this package). Tool implementations
 * are injected — the package never imports CozoDB or intelligence modules.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  _meta?: Record<string, unknown>;
  _context?: Record<string, unknown>;
  isError?: boolean;
}

export type McpToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpToolCallResult>;

export interface McpServerConfig {
  name: string;
  version: string;
  tools: McpToolDefinition[];
  onToolCall: McpToolHandler;
}

export interface McpServerInstance {
  server: import("@modelcontextprotocol/sdk/server/index.js").Server;
  config: McpServerConfig;
}
