/**
 * STDIO Transport — connects MCP server to stdin/stdout.
 *
 * This is the primary transport for IDE integration (Cursor, VS Code, Claude Code).
 * stdin receives JSON-RPC requests, stdout sends JSON-RPC responses.
 *
 * CRITICAL: No logging to stdout. All diagnostics go to stderr.
 * Cold start target: <500ms from process start to MCP ready.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServerInstance } from "../types.js";

/**
 * Connect an MCP server to STDIO transport and start listening.
 * Returns a disconnect function for cleanup.
 */
export async function connectStdio(
  instance: McpServerInstance,
): Promise<{ disconnect: () => Promise<void> }> {
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);

  return {
    disconnect: async () => {
      await instance.server.close();
    },
  };
}
