/**
 * MCP Test Harness — in-process MCP client/server for integration testing.
 *
 * Uses the MCP SDK's InMemoryTransport to create a linked pair of transports
 * that communicate within the same process. No stdio, no ports, no forks.
 *
 * Usage:
 *   const harness = await createMcpHarness();
 *   const tools = await harness.listTools();
 *   const result = await harness.callTool("get_function", { key: "src/foo.ts::myFn" });
 *   await harness.close();
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface McpHarness {
  client: Client;
  server: Server;
  listTools: () => Promise<Tool[]>;
  callTool: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<Awaited<ReturnType<Client["callTool"]>>>;
  close: () => Promise<void>;
}

export interface McpHarnessOptions {
  serverName?: string;
  serverVersion?: string;
  setupServer?: (server: Server) => void | Promise<void>;
}

/**
 * Create an in-process MCP test harness with linked client/server.
 *
 * The `setupServer` callback is where you register tool handlers
 * (ListToolsRequestSchema, CallToolRequestSchema) on the server.
 * This mirrors the real proxy's MCP setup from proxy.ts.
 */
export async function createMcpHarness(
  options: McpHarnessOptions = {}
): Promise<McpHarness> {
  const {
    serverName = "unerr-test",
    serverVersion = "0.0.1",
    setupServer,
  } = options;

  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } }
  );

  if (setupServer) {
    await setupServer(server);
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "mcp-test-client", version: "0.0.1" },
    { capabilities: {} }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listTools = async (): Promise<Tool[]> => {
    const response = await client.listTools();
    return response.tools;
  };

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    return await client.callTool({ name, arguments: args });
  };

  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
  };

  return { client, server, listTools, callTool, close };
}
