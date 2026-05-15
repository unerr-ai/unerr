/**
 * FileEdit Tool — perform exact string replacements in files.
 * Safer than full file writes — only modifies the targeted section.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../types.js";

export const fileEditTool: Tool = {
  name: "file_edit",
  description:
    "Perform an exact string replacement in a file. The old_string must be unique in the file " +
    "(provide more surrounding context if needed). Use replace_all: true to replace every occurrence.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace",
      },
      new_string: {
        type: "string",
        description: "The replacement string",
      },
      replace_all: {
        type: "boolean",
        description:
          "Replace all occurrences instead of just the first. Default: false",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isReadOnly: false,
  requiresPermission: true,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolOutput> {
    const filePath = resolve(ctx.cwd, args.file_path as string);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) ?? false;

    if (!existsSync(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return {
          content: `old_string not found in ${filePath}. Likely causes: (1) file changed since last read, (2) whitespace or line-ending mismatch. Call file_read on the target range first to capture the exact text, then retry the edit with the bytes from that read.`,
          isError: true,
        };
      }

      if (!replaceAll && occurrences > 1) {
        return {
          content: `old_string found ${occurrences} times in ${filePath}. Provide more context to make it unique, or use replace_all: true.`,
          isError: true,
        };
      }

      const updated = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);

      writeFileSync(filePath, updated, "utf-8");

      const replaced = replaceAll ? occurrences : 1;
      return { content: `Replaced ${replaced} occurrence(s) in ${filePath}` };
    } catch (err) {
      return {
        content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
