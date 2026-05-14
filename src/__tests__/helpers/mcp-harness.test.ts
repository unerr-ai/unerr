import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpHarness } from "./mcp-harness.js";

describe("MCP Test Harness", () => {
  it("creates a linked client/server pair", async () => {
    const harness = await createMcpHarness();
    expect(harness.client).toBeDefined();
    expect(harness.server).toBeDefined();
    await harness.close();
  });

  it("lists tools from a configured server", async () => {
    const harness = await createMcpHarness({
      setupServer: (server) => {
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "test_tool",
              description: "A test tool",
              inputSchema: {
                type: "object" as const,
                properties: {
                  input: { type: "string" },
                },
                required: ["input"],
              },
            },
          ],
        }));
      },
    });

    const tools = await harness.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("test_tool");
    await harness.close();
  });

  it("calls a tool and receives a response", async () => {
    const harness = await createMcpHarness({
      setupServer: (server) => {
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "echo",
              description: "Echoes input",
              inputSchema: {
                type: "object" as const,
                properties: {
                  message: { type: "string" },
                },
                required: ["message"],
              },
            },
          ],
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const args = request.params.arguments as { message: string };
          return {
            content: [{ type: "text" as const, text: `Echo: ${args.message}` }],
          };
        });
      },
    });

    const result = await harness.callTool("echo", { message: "hello" });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toBe("Echo: hello");
    await harness.close();
  });
});
