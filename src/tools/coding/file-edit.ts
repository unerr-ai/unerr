/**
 * FileEdit Tool — change a file, the unerr-owned edit/write path (one tool, two modes).
 *
 * Two mutually-exclusive modes, picked by which args are present:
 *   - Targeted edit: old_string + new_string (+ replace_all, base_hash) — exact
 *     string replacement, quote-tolerant, uniqueness-checked.
 *   - Whole-file write: content — create or overwrite the entire file.
 * Exactly one mode must be supplied; both or neither is an error.
 *
 * Unlike the host agent's built-in editor, this runs in the unerr process, so it
 * never relies on the agent's read-tracking gate (an MCP tool can't satisfy that
 * gate from a different process — see .internal/roadmap/OWN_EDIT_TOOL.md). It
 * carries its own correctness instead: quote-tolerant matching, uniqueness
 * checks, encoding + line-ending preservation, and an optional content-hash
 * staleness guard.
 *
 * The rendered diff (edit mode) is written out-of-band to the file log (never the
 * tool_result): a diff in the result would re-bill on every later cached turn
 * and can erase the round-trip saving. The model gets a one-line confirmation
 * with added/removed line counts. The user sees what changed through the
 * DETERMINISTIC end-of-turn "files changed" receipt (Stop hook), not a
 * per-edit model echo: each successful edit returns `metadata.edit_summary`
 * (file, added, removed, changed line ranges) which the proxy records as a
 * `code_edit_applied` behavior event; the receipt renderer lists every file
 * edited this turn with its line numbers. This is host-emitted, so it never
 * depends on the model remembering to echo (which it dropped ~94% of the time).
 *
 * @sem domain=utilities role=tool
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { renderInlineBlastRadius } from "../../intelligence/edit-impact.js";
import { handleBlastRadiusRequest } from "../../proxy/blast-radius-protocol.js";
import { resolveWithHome } from "../../utils/expand-home.js";
import { initFileLog, startupLog } from "../../utils/startup-log.js";
import type { Tool, ToolContext, ToolOutput } from "../types.js";
import {
  computeEditedLineRanges,
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

/** Path shown to the user — relative to the project root, never absolute or
 *  `$HOME`-expanded. Falls back to the given path if it sits outside cwd. */
function toRepoRelative(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}

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

/** Local-only spool for user-visible diffs. Lives under `.unerr/state/` —
 *  NOT `.unerr/events/` (which the cloud push-reporter drains). Raw source
 *  must never leave the machine (HR-2). */
const EDIT_DISPLAY_SPOOL = "edit-display.jsonl";
const EDIT_DISPLAY_CAP = 50;

/** Spool an edit diff entry for the post-edit hook to display to the user.
 *  Appends `{ts, file, diff}` to `.unerr/state/edit-display.jsonl`, capped
 *  at {@link EDIT_DISPLAY_CAP} entries (oldest dropped). Best-effort: never
 *  throws into the edit path. Gated off under VITEST like emitDiffOutOfBand. */
function spoolEditDisplay(cwd: string, file: string, diff: string): void {
  if (process.env.VITEST) return;
  try {
    const stateDir = join(cwd, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const spoolPath = join(stateDir, EDIT_DISPLAY_SPOOL);
    const entry = JSON.stringify({ ts: new Date().toISOString(), file, diff });

    // Read existing entries, keep last (CAP-1), append new one.
    let lines: string[] = [];
    if (existsSync(spoolPath)) {
      lines = readFileSync(spoolPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }
    lines.push(entry);
    if (lines.length > EDIT_DISPLAY_CAP) {
      lines = lines.slice(lines.length - EDIT_DISPLAY_CAP);
    }
    writeFileSync(spoolPath, `${lines.join("\n")}\n`, "utf-8");
  } catch {
    /* spool is never load-bearing */
  }
}

/** Read and consume (remove) the latest spool entry matching `file`.
 *  Returns the diff string, or null if no matching entry exists. Best-effort. */
export function consumeSpooledDiff(cwd: string, file: string): string | null {
  try {
    const spoolPath = join(cwd, ".unerr", "state", EDIT_DISPLAY_SPOOL);
    if (!existsSync(spoolPath)) return null;
    const lines = readFileSync(spoolPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    // Find the last entry matching this file.
    let matchIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i] ?? "") as {
          file?: string;
          diff?: string;
        };
        // Normalize both paths against cwd so relative ("src/foo.ts") and
        // absolute ("/repo/src/foo.ts") keys match each other.
        if (
          typeof row.file === "string" &&
          resolve(cwd, row.file) === resolve(cwd, file)
        ) {
          matchIdx = i;
          break;
        }
      } catch {
        /* malformed line — skip */
      }
    }
    if (matchIdx === -1) return null;
    const row = JSON.parse(lines[matchIdx] ?? "") as { diff?: string };
    // Remove the consumed entry.
    lines.splice(matchIdx, 1);
    writeFileSync(
      join(cwd, ".unerr", "state", EDIT_DISPLAY_SPOOL),
      lines.length > 0 ? `${lines.join("\n")}\n` : "",
      "utf-8"
    );
    return typeof row.diff === "string" ? row.diff : null;
  } catch {
    return null;
  }
}

/**
 * Whole-file create/overwrite (content mode). Preserves an existing file's
 * encoding + line ending; a new file gets UTF-8 / LF. Parent dirs are created.
 */
function writeWholeFile(
  filePath: string,
  content: string,
  cwd: string
): ToolOutput {
  mkdirSync(dirname(filePath), { recursive: true });

  let encoding: ReturnType<typeof decodeFile>["encoding"] = "utf8";
  let hadBom = false;
  let lineEnding: "\r\n" | "\n" = "\n";
  const overwrite = existsSync(filePath);
  let removed = 0;
  if (overwrite) {
    const prev = decodeFile(readFileSync(filePath));
    encoding = prev.encoding;
    hadBom = prev.hadBom;
    lineEnding = prev.lineEnding;
    removed = prev.text.split("\n").length;
  }

  const restored = restoreNewlines(content.replace(/\r\n/g, "\n"), lineEnding);
  writeFileSync(filePath, encodeFile(restored, encoding, hadBom));

  // Spool a first-10-lines preview for the post-edit display hook.
  const previewLines = content.split("\n").slice(0, 10);
  const previewDiff = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -1,0 +1,${previewLines.length} @@`,
    ...previewLines.map((l) => `+${l}`),
  ].join("\n");
  spoolEditDisplay(cwd, filePath, previewDiff);

  const lineCount = content.split("\n").length;
  const rel = toRepoRelative(cwd, filePath);
  return {
    content: `${overwrite ? "Overwrote" : "Wrote"} ${lineCount} lines to ${filePath} — added ${lineCount} line(s), removed ${removed} line(s)`,
    // edit_summary feeds the deterministic end-of-turn "files changed" receipt
    // (the proxy reads it and records a code_edit_applied behavior event). A
    // whole-file write spans the entire resulting file.
    metadata: {
      new_hash: contentHash(content),
      overwrite,
      edit_summary: {
        file: rel,
        mode: overwrite ? "overwrite" : "create",
        added: lineCount,
        removed,
        ranges: [{ start: 1, end: lineCount }],
      },
    },
  };
}

/**
 * Targeted exact-string replacement (old_string/new_string mode), with optional
 * staleness guard and a quote-tolerant, uniqueness-checked match.
 */
function replaceInFile(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  baseHash: string | undefined,
  cwd: string
): ToolOutput {
  if (!existsSync(filePath)) {
    return { content: `File not found: ${filePath}`, isError: true };
  }

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

  const renderedDiff = renderEditDiff(
    filePath,
    normContent,
    normOld,
    normNew,
    result.indices
  );
  emitDiffOutOfBand(cwd, renderedDiff);
  spoolEditDisplay(cwd, filePath, renderedDiff);

  // Line deltas + the changed line ranges, both for the end-of-turn receipt.
  const removed = normOld.split("\n").length * result.replaced;
  const added = normNew.split("\n").length * result.replaced;
  const ranges = computeEditedLineRanges(
    result.content,
    normOld,
    normNew,
    result.indices
  );
  const newHash = contentHash(result.content);
  const rel = toRepoRelative(cwd, filePath);
  return {
    content: `Replaced ${result.replaced} occurrence(s) in ${filePath} — added ${added} line(s), removed ${removed} line(s)`,
    // new_hash lets the agent chain a follow-up file_edit with no re-read;
    // metadata is out-of-band (filtered from model context), so it never
    // bloats the prefix. edit_summary feeds the deterministic end-of-turn
    // "files changed" receipt via a code_edit_applied behavior event.
    metadata: {
      replaced: result.replaced,
      new_hash: newHash,
      edit_summary: {
        file: rel,
        mode: "edit",
        added,
        removed,
        ranges,
      },
    },
  };
}

/**
 * Append the graph-confirmed inline blast-radius `ur|rsk` line to a successful
 * targeted edit, so every agent gets the callers-at-risk for a signature change
 * in the same response without a get_references round-trip. Never load-bearing:
 * any failure (or no graph / no signature change / <2 callers) returns `result`
 * unchanged, keeping zero false positives.
 */
async function augmentWithBlastRadius(
  result: ToolOutput,
  filePath: string,
  oldString: string,
  newString: string,
  ctx: ToolContext
): Promise<ToolOutput> {
  if (result.isError || !ctx.graph) return result;
  try {
    const { warnings } = await handleBlastRadiusRequest(
      ctx.graph,
      {
        file_path: filePath,
        old_content: oldString,
        new_content: newString,
      },
      ctx.cwd
    );
    const line = renderInlineBlastRadius(warnings);
    if (!line) return result;
    return { ...result, content: `${result.content}\n${line}` };
  } catch {
    /* blast-radius is never load-bearing */
    return result;
  }
}

export const fileEditTool: Tool = {
  name: "file_edit",
  description:
    "Change a file — the unerr-owned edit/write path, no built-in Read required first. " +
    "Two modes: pass old_string + new_string for an exact replacement (unique unless replace_all:true), " +
    "or pass content to create/overwrite the whole file. Supply exactly one mode. " +
    "Pass base_hash (from the file_read you based the edit on) to reject the edit if the file changed since.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to change" },
      old_string: {
        type: "string",
        description:
          "Edit mode: the exact string to find and replace. Must be unique (add surrounding context) unless replace_all:true.",
      },
      new_string: {
        type: "string",
        description: "Edit mode: the replacement string.",
      },
      replace_all: {
        type: "boolean",
        description:
          "Edit mode: replace all occurrences instead of just the first. Default: false",
      },
      base_hash: {
        type: "string",
        description:
          "Edit mode staleness guard: the content hash from the file_read you based this edit on. The edit is rejected if the on-disk file changed since.",
      },
      content: {
        type: "string",
        description:
          "Write mode: the full content of the file. Creates the file (and parent dirs) if missing, overwrites if present (preserving encoding + line ending).",
      },
    },
    required: ["file_path"],
  },
  isReadOnly: false,
  requiresPermission: true,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolOutput> {
    const filePath = resolveWithHome(ctx.cwd, args.file_path as string);
    const hasContent = typeof args.content === "string";
    const hasReplace =
      typeof args.old_string === "string" &&
      typeof args.new_string === "string";

    // Exactly one mode.
    if (hasContent && hasReplace) {
      return {
        content:
          "file_edit: pass EITHER content (whole-file write) OR old_string+new_string (targeted edit), not both.",
        isError: true,
        metadata: { error_code: "mode_conflict" },
      };
    }
    if (!hasContent && !hasReplace) {
      return {
        content:
          "file_edit: provide content (whole-file write) or old_string+new_string (targeted edit).",
        isError: true,
        metadata: { error_code: "mode_missing" },
      };
    }

    try {
      if (hasContent) {
        return writeWholeFile(filePath, args.content as string, ctx.cwd);
      }
      const replaceAll = (args.replace_all as boolean) ?? false;
      const baseHash =
        typeof args.base_hash === "string" ? args.base_hash : undefined;
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const editResult = replaceInFile(
        filePath,
        oldString,
        newString,
        replaceAll,
        baseHash,
        ctx.cwd
      );
      return augmentWithBlastRadius(
        editResult,
        filePath,
        oldString,
        newString,
        ctx
      );
    } catch (err) {
      return {
        content: `Error changing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
