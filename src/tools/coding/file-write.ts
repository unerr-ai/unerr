/**
 * FileWrite Tool — create or overwrite a file.
 * Requires explicit user permission since it modifies the filesystem.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../types.js";

export const fileWriteTool: Tool = {
  name: "file_write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, or overwrites it if it does. " +
    "Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute or relative path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  isReadOnly: false,
  requiresPermission: true,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const filePath = resolve(ctx.cwd, args.file_path as string);
    const content = args.content as string;

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      const lineCount = content.split("\n").length;
      return { content: `Wrote ${lineCount} lines to ${filePath}` };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
