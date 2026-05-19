/**
 * fetch_url MCP tool — replaces built-in WebFetch with a local-controlled
 * pipeline: undici → Defuddle/Readability → turndown → passages → telemetry.
 */

import type { Tool, ToolContext, ToolOutput } from "../types.js";
import { runFetchUrl } from "./fetch-url-protocol.js";

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch URL, extract main content (Defuddle/Readability), return markdown passages with offset/limit. Pass prompt to rank passages.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute URL to fetch" },
      prompt: {
        type: "string",
        description:
          "Optional prompt — passages are ranked by relevance when set",
      },
      offset: {
        type: "number",
        description: "Passage offset for pagination (default 0)",
      },
      limit: {
        type: "number",
        description: "Max passages to return (default 50)",
      },
      token_budget: {
        type: "number",
        description: "Raise wire byte cap when full payload is needed",
      },
    },
    required: ["url"],
  },
  isReadOnly: true,
  requiresPermission: false,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolOutput> {
    const result = await runFetchUrl(
      {
        url: args.url as string,
        prompt: args.prompt as string | undefined,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        token_budget: args.token_budget as number | undefined,
      },
      { cwd: ctx.cwd, abortSignal: ctx.abortSignal }
    );
    return {
      content: result as unknown as Record<string, unknown>,
      metadata: {
        extractor: result.extractor,
        compression_ratio: result.compression_ratio,
      },
    };
  },
};
