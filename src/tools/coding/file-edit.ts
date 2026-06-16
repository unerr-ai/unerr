/**
 * FileEdit Tool — exact string replacement in a file, the unerr-owned edit path.
 *
 * Unlike the host agent's built-in editor, this runs in the unerr process, so it
 * never relies on the agent's read-tracking gate (an MCP tool can't satisfy that
 * gate from a different process — see .internal/roadmap/OWN_EDIT_TOOL.md). It
 * carries its own correctness instead: quote-tolerant matching, uniqueness
 * checks, encoding + line-ending preservation, and an optional content-hash
 * staleness guard.
 *
 * The rendered diff is written out-of-band to the file log (never the
 * tool_result): a diff in the result would re-bill on every later cached turn
 * and can erase the round-trip saving. The model gets a one-line confirmation.
 *
 * @sem domain=utilities role=tool
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWithHome } from "../../utils/expand-home.js";
import { initFileLog, startupLog } from "../../utils/startup-log.js";
import type { Tool, ToolContext, ToolOutput } from "../types.js";
import {
  contentHash,
  decodeFile,
  editErrorHint,
  encodeFile,
  normalizeNewlines,
  performReplace,
  renderEditDiff,
  restoreNewlines,
} from "./edit-core.js";

let _logInit = false;

/** Write the rendered diff to the file log only — never to stdout or the result. */
function emitDiffOutOfBand(cwd: string, diff: string): void {
  if (process.env.VITEST) return;
  try {
    if (!_logInit) {
      initFileLog(cwd);
      _logInit = true;
    }
    startupLog.fileOnly("file_edit", diff);
  } catch {
    /* diff rendering is never load-bearing */
  }
}

export const fileEditTool: Tool = {
  name: "file_edit",
  description:
    "Perform an exact string replacement in a file — the unerr-owned edit path, no built-in Read required first. " +
    "old_string must be unique (add surrounding context) unless replace_all:true. " +
    "Pass base_hash (from the file_read that you based the edit on) to reject the edit if the file changed since.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to edit" },
      old_string: {
        type: "string",
        description: "The exact string to find and replace",
      },
      new_string: { type: "string", description: "The replacement string" },
      replace_all: {
        type: "boolean",
        description:
          "Replace all occurrences instead of just the first. Default: false",
      },
      base_hash: {
        type: "string",
        description:
          "Optional staleness guard: the content hash from the file_read you based this edit on. The edit is rejected if the on-disk file changed since.",
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
    const filePath = resolveWithHome(ctx.cwd, args.file_path as string);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) ?? false;
    const baseHash =
      typeof args.base_hash === "string" ? args.base_hash : undefined;

    if (!existsSync(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    try {
      const decoded = decodeFile(readFileSync(filePath));
      const normContent = normalizeNewlines(decoded.text);

      // Staleness guard (opt-in): reject if the file drifted since the read the
      // agent based this edit on. Hash is over normalized content, so LF/CRLF
      // checkouts compare equal.
      if (baseHash !== undefined) {
        const currentHash = contentHash(normContent);
        if (currentHash !== baseHash) {
          return {
            content: editErrorHint("stale", filePath, 0),
            isError: true,
            metadata: { error_code: "stale", current_hash: currentHash },
          };
        }
      }

      const normOld = normalizeNewlines(oldString);
      const normNew = normalizeNewlines(newString);
      const result = performReplace(normContent, normOld, normNew, replaceAll);

      if (!result.ok) {
        return {
          content: editErrorHint(result.code, filePath, result.count),
          isError: true,
          metadata: { error_code: result.code, match_count: result.count },
        };
      }

      const restored = restoreNewlines(result.content, decoded.lineEnding);
      writeFileSync(
        filePath,
        encodeFile(restored, decoded.encoding, decoded.hadBom)
      );

      emitDiffOutOfBand(
        ctx.cwd,
        renderEditDiff(filePath, normContent, normOld, normNew, result.indices)
      );

      const newHash = contentHash(result.content);
      return {
        content: `Replaced ${result.replaced} occurrence(s) in ${filePath}`,
        // new_hash lets the agent chain a follow-up file_edit with no re-read;
        // metadata is out-of-band (filtered from model context), so it never
        // bloats the prefix.
        metadata: {
          replaced: result.replaced,
          new_hash: newHash,
          normalized_match: result.normalized,
        },
      };
    } catch (err) {
      return {
        content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
