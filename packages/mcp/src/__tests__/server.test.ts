import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import type { McpToolCallResult } from "../types.js";

function makeTestServer() {
  return createMcpServer({
    name: "test-server",
    version: "0.0.1",
    tools: [
      {
        name: "echo",
        description: "Echoes input",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        name: "greet",
        description: "Greets by name",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    ],
    onToolCall: async (name, args): Promise<McpToolCallResult> => {
      if (name === "echo") {
        return {
          content: [{ type: "text", text: String(args.message ?? "") }],
        };
      }
      if (name === "greet") {
        return {
          content: [
            { type: "text", text: `Hello, ${String(args.name ?? "world")}!` },
          ],
          _meta: { greeted: true },
        };
      }
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    },
  });
}

describe("createMcpServer", () => {
  it("creates a server with registered tools", () => {
    const instance = makeTestServer();
    expect(instance.server).toBeDefined();
    expect(instance.config.name).toBe("test-server");
    expect(instance.config.tools).toHaveLength(2);
  });

  it("lists tools via MCP protocol", async () => {
    const instance = makeTestServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );

    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]?.name).toBe("echo");
    expect(result.tools[1]?.name).toBe("greet");

    await client.close();
    await instance.server.close();
  });

  it("calls a tool and returns result", async () => {
    const instance = makeTestServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );

    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello world" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("hello world");

    await client.close();
    await instance.server.close();
  });

  it("handles tool call errors gracefully", async () => {
    const instance = createMcpServer({
      name: "error-server",
      version: "0.0.1",
      tools: [
        {
          name: "fail",
          description: "Always fails",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      onToolCall: async () => {
        throw new Error("intentional failure");
      },
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );

    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "fail",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("intentional failure");

    await client.close();
    await instance.server.close();
  });
});
