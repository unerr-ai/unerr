/**
 * FileRead Tool — read file contents with Sprint FE-B metadata-first protocol.
 */

import type { Tool, ToolContext, ToolOutput } from "../types.js";
import { runFileReadTool } from "./file-read-protocol.js";

export const fileReadTool: Tool = {
  name: "file_read",
  description:
    "Read file text with line numbers. Large files (>200 lines) return a structural outline unless you pass offset/limit or entity (symbol name). Logs default to tail window when large.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute or relative path to the file to read",
      },
      offset: {
        type: "number",
        description: "1-based start line (optional)",
      },
      limit: {
        type: "number",
        description: "Max lines to read (optional, default 2000, max 10000)",
      },
      entity: {
        type: "string",
        description:
          "Entity/symbol name — returns that definition ±5 lines context when found",
      },
    },
    required: ["file_path"],
  },
  isReadOnly: true,
  requiresPermission: false,

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    return runFileReadTool(args, ctx);
  },
};
