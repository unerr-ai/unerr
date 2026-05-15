/**
 * C.6: MCP Integration Test — Full Envelope Cycle
 *
 * Uses the MCP harness from A.6 to set up a server with a tool that
 * returns an envelope-wrapped response, then verifies the client
 * receives _meta + _context fields.
 */

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  type ContextInjector,
  createEnvelopePipeline,
  estimateTokens,
} from "../proxy/response-envelope.js";
import { createSessionDedup } from "../proxy/session-dedup.js";
import { createTokenCounter } from "../proxy/token-counter.js";
import { createMcpHarness } from "./helpers/mcp-harness.js";

describe("MCP Envelope Integration", () => {
  it("full pipeline: envelope + injector + dedup + token counter", async () => {
    const messages: string[] = [];
    const tokenCounter = createTokenCounter({
      emitEveryN: 1,
      sink: (msg) => messages.push(msg),
    });
    const dedup = createSessionDedup();

    const testInjector: ContextInjector = {
      key: "test",
      inject: ({ toolArgs }) => {
        if (toolArgs.key) {
          return { "dev.unerr/test_context": { entity: toolArgs.key } };
        }
        return null;
      },
    };

    const pipeline = createEnvelopePipeline([testInjector]);

    const harness = await createMcpHarness({
      setupServer: (server) => {
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "test_tool",
              description: "A test tool with envelope wrapping",
              inputSchema: {
                type: "object" as const,
                properties: { key: { type: "string" } },
                required: ["key"],
              },
            },
          ],
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const args = (request.params.arguments ?? {}) as Record<
            string,
            unknown
          >;
          const start = performance.now();

          const rawContent = { found: true, name: "testEntity", fan_in: 5 };
          const latencyMs = performance.now() - start;
          const originalTokens = estimateTokens(args);

          const envelope = await pipeline.wrapResponse(
            rawContent,
            latencyMs,
            request.params.name,
            args,
            originalTokens
          );

          const entityKey = String(args.key ?? "");
          let context = envelope._context ?? {};
          if (Object.keys(context).length > 0) {
            context = dedup.filter(entityKey, context);
          }

          tokenCounter.record(
            envelope._meta["dev.unerr/tokens_saved"],
            estimateTokens(rawContent)
          );

          const responseText = JSON.stringify(
            {
              ...rawContent,
              _meta: envelope._meta,
              ...(Object.keys(context).length > 0 ? { _context: context } : {}),
            },
            null,
            2
          );

          return {
            content: [{ type: "text" as const, text: responseText }],
          };
        });
      },
    });

    const result = await harness.callTool("test_tool", {
      key: "src/auth.ts::login",
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);

    const parsed = JSON.parse(content[0]!.text);
    expect(parsed._meta).toBeDefined();
    expect(parsed._meta["dev.unerr/version"]).toBe("0.1.0");
    expect(typeof parsed._meta["dev.unerr/latency_ms"]).toBe("number");
    expect(typeof parsed._meta["dev.unerr/tokens_saved"]).toBe("number");

    expect(parsed._context).toBeDefined();
    expect(parsed._context["dev.unerr/test_context"]).toBeDefined();
    expect(parsed._context["dev.unerr/test_context"].entity).toBe(
      "src/auth.ts::login"
    );

    expect(tokenCounter.getCallCount()).toBe(1);
    expect(messages).toHaveLength(1);

    const result2 = await harness.callTool("test_tool", {
      key: "src/auth.ts::login",
    });
    const parsed2 = JSON.parse(
      (result2.content as Array<{ text: string }>)[0]!.text
    );

    expect(parsed2._context).toBeUndefined();
    expect(
      dedup.hasDelivered("src/auth.ts::login", "dev.unerr/test_context")
    ).toBe(true);

    await harness.close();
  });

  it("envelope works without any injectors", async () => {
    const pipeline = createEnvelopePipeline();

    const harness = await createMcpHarness({
      setupServer: (server) => {
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "simple_tool",
              description: "No injectors",
              inputSchema: { type: "object" as const, properties: {} },
            },
          ],
        }));

        server.setRequestHandler(CallToolRequestSchema, async () => {
          const envelope = await pipeline.wrapResponse({ result: "ok" }, 0.5);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(envelope) },
            ],
          };
        });
      },
    });

    const result = await harness.callTool("simple_tool", {});
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text);

    expect(parsed._meta["dev.unerr/version"]).toBe("0.1.0");
    expect(parsed._context).toBeUndefined();

    await harness.close();
  });
});
