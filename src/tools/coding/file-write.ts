/**
 * FileWrite Tool — create or overwrite a file, the unerr-owned write path.
 *
 * When overwriting an existing file, the original encoding (BOM) and line ending
 * are preserved so a whole-file rewrite of a CRLF or UTF-16 file does not silently
 * convert it. New files default to UTF-8 / LF. Returns a content hash the agent
 * can pass as base_hash to a follow-up file_edit, and never echoes the content
 * back into the model context.
 *
 * @sem domain=utilities role=tool
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWithHome } from "../../utils/expand-home.js";
import type { Tool, ToolContext, ToolOutput } from "../types.js";
import {
  contentHash,
  decodeFile,
  encodeFile,
  restoreNewlines,
} from "./edit-core.js";

export const fileWriteTool: Tool = {
  name: "file_write",
  description:
    "Write content to a file — the unerr-owned write path, no built-in Read required first. " +
    "Creates the file if missing, overwrites if present (preserving the original encoding + line ending). " +
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
    ctx: ToolContext
  ): Promise<ToolOutput> {
    const filePath = resolveWithHome(ctx.cwd, args.file_path as string);
    const content = args.content as string;

    try {
      mkdirSync(dirname(filePath), { recursive: true });

      // Preserve the existing file's encoding + line ending on overwrite; a new
      // file gets UTF-8 / LF.
      let encoding: ReturnType<typeof decodeFile>["encoding"] = "utf8";
      let hadBom = false;
      let lineEnding: "\r\n" | "\n" = "\n";
      const overwrite = existsSync(filePath);
      if (overwrite) {
        const prev = decodeFile(readFileSync(filePath));
        encoding = prev.encoding;
        hadBom = prev.hadBom;
        lineEnding = prev.lineEnding;
      }

      const restored = restoreNewlines(
        content.replace(/\r\n/g, "\n"),
        lineEnding
      );
      writeFileSync(filePath, encodeFile(restored, encoding, hadBom));

      const lineCount = content.split("\n").length;
      return {
        content: `${overwrite ? "Overwrote" : "Wrote"} ${lineCount} lines to ${filePath}`,
        metadata: { new_hash: contentHash(content), overwrite },
      };
    } catch (err) {
      return {
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
