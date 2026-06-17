/**
 * Edit core — pure, dependency-free primitives for the `file_edit` harness
 * (edit + whole-file write modes). Kept separate from the tool wiring so the
 * matching, encoding, hashing, and diff logic is unit-testable in isolation.
 *
 * These mirror the safety guarantees of a production editor (encoding + line-
 * ending preservation, quote-tolerant matching, uniqueness checks, a content
 * staleness hash) without depending on the host agent's read-tracking gate — an
 * MCP tool runs in a different process and can never satisfy that gate, so the
 * harness carries its own correctness instead.
 *
 * @sem domain=utilities role=core
 */

import { createHash } from "node:crypto";

/** Why an edit could not be applied — mirrored into agent-facing hints. */
export type EditErrorCode =
  | "not_found" // old_string is absent from the file
  | "ambiguous" // multiple matches and replace_all was not set
  | "stale" // base_hash did not match the on-disk content
  | "unchanged"; // old_string and new_string are identical

/** Text encoding inferred from a leading byte-order mark. */
export type FileEncoding = "utf8" | "utf16le" | "utf16be";

export interface DecodedFile {
  text: string;
  encoding: FileEncoding;
  hadBom: boolean;
  lineEnding: "\r\n" | "\n";
}

/**
 * Canonical content hash used by the optional staleness guard. Computed over the
 * newline-normalized text so the hash is stable regardless of how the file was
 * checked out (LF vs CRLF). `file_read` stamps it; `file_edit` verifies it.
 */
export function contentHash(text: string): string {
  return createHash("sha256")
    .update(normalizeNewlines(text), "utf8")
    .digest("hex");
}

// ── Encoding / line endings ──────────────────────────────────────────────────

export function detectEncoding(buf: Buffer): {
  encoding: FileEncoding;
  hadBom: boolean;
} {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf16le", hadBom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf16be", hadBom: true };
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    return { encoding: "utf8", hadBom: true };
  }
  return { encoding: "utf8", hadBom: false };
}

/** Decode a file buffer to a string, detecting encoding + line ending. */
export function decodeFile(buf: Buffer): DecodedFile {
  const { encoding, hadBom } = detectEncoding(buf);
  let text: string;
  if (encoding === "utf16le") {
    text = buf.toString("utf16le");
  } else if (encoding === "utf16be") {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else {
    text = buf.toString("utf8");
  }
  if (hadBom) text = text.replace(/^﻿/, "");
  return { text, encoding, hadBom, lineEnding: detectLineEnding(text) };
}

/** Re-encode text to a buffer, restoring the original BOM + encoding. */
export function encodeFile(
  text: string,
  encoding: FileEncoding,
  hadBom: boolean
): Buffer {
  const withBom = hadBom ? `﻿${text}` : text;
  if (encoding === "utf16le") return Buffer.from(withBom, "utf16le");
  if (encoding === "utf16be") {
    const b = Buffer.from(withBom, "utf16le");
    b.swap16();
    return b;
  }
  return Buffer.from(withBom, "utf8");
}

export function detectLineEnding(text: string): "\r\n" | "\n" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function restoreNewlines(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ── Quote-tolerant matching ──────────────────────────────────────────────────

// 1:1, length-preserving map: every replacement is a single BMP unit, so a match
// index found in normalized space lands on the same index in the original — which
// lets us splice the ORIGINAL bytes back and keep the file's real punctuation.
const NORMALIZE_RE = /[‘’‚‛“”„‟–—−   ]/g;
const NORMALIZE_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  " ": " ",
  " ": " ",
  " ": " ",
};

/** Normalize smart quotes / dashes / non-breaking spaces, preserving length. */
export function quoteNormalize(s: string): string {
  return s.replace(NORMALIZE_RE, (ch) => NORMALIZE_MAP[ch] ?? ch);
}

function exactCount(hay: string, needle: string): number {
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}

export type ReplaceResult =
  | {
      ok: true;
      content: string;
      replaced: number;
      /** Char offsets (in normalized content) where each replacement began. */
      indices: number[];
      /** True when a quote-normalized (non-exact) match was used. */
      normalized: boolean;
    }
  | { ok: false; code: EditErrorCode; count: number };

/**
 * Replace `search` with `replacement` in newline-normalized `content`. Tries an
 * exact match first, then a quote-normalized fallback. Enforces uniqueness
 * unless `replaceAll`. Splices original bytes so file punctuation is preserved.
 */
export function performReplace(
  content: string,
  search: string,
  replacement: string,
  replaceAll: boolean
): ReplaceResult {
  if (search === replacement) return { ok: false, code: "unchanged", count: 0 };

  let hay = content;
  let needle = search;
  let normalized = false;
  let count = exactCount(content, search);
  if (count === 0) {
    hay = quoteNormalize(content);
    needle = quoteNormalize(search);
    count = exactCount(hay, needle);
    if (count === 0) return { ok: false, code: "not_found", count: 0 };
    normalized = true;
  }
  if (count > 1 && !replaceAll) return { ok: false, code: "ambiguous", count };

  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    indices.push(i);
    from = i + needle.length;
    if (!replaceAll) break;
  }

  let out = "";
  let cursor = 0;
  // needle.length === search.length (normalization is 1:1), so original slices
  // line up exactly with normalized match offsets.
  for (const i of indices) {
    out += content.slice(cursor, i) + replacement;
    cursor = i + search.length;
  }
  out += content.slice(cursor);
  return {
    ok: true,
    content: out,
    replaced: indices.length,
    indices,
    normalized,
  };
}

// ── Out-of-band diff rendering ───────────────────────────────────────────────

/**
 * Render the edit as a unified-diff hunk list for the USER (log/dashboard) — it
 * must never enter the model tool_result, where it would re-bill on every later
 * cached turn. Built from the known replacement sites, so it costs O(edited
 * region), not O(file).
 */
export function renderEditDiff(
  filePath: string,
  before: string,
  search: string,
  replacement: string,
  indices: number[],
  contextLines = 3,
  maxHunks = 10
): string {
  const lineStarts = computeLineStarts(before);
  const out: string[] = [`--- ${filePath}`, `+++ ${filePath}`];
  const shown = indices.slice(0, maxHunks);
  for (const idx of shown) {
    const startLine = offsetToLine(lineStarts, idx);
    const oldLines = search.split("\n");
    const newLines = replacement.split("\n");
    const ctxBefore = sliceLines(
      before,
      lineStarts,
      startLine - contextLines,
      startLine
    );
    const afterStartLine = startLine + oldLines.length;
    const ctxAfter = sliceLines(
      before,
      lineStarts,
      afterStartLine,
      afterStartLine + contextLines
    );
    out.push(
      `@@ -${startLine + 1},${oldLines.length} +${startLine + 1},${newLines.length} @@`
    );
    for (const l of ctxBefore) out.push(` ${l}`);
    for (const l of oldLines) out.push(`-${l}`);
    for (const l of newLines) out.push(`+${l}`);
    for (const l of ctxAfter) out.push(` ${l}`);
  }
  if (indices.length > shown.length) {
    out.push(`… ${indices.length - shown.length} more hunk(s) not shown`);
  }
  return out.join("\n");
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  // binary search for the last line start <= offset
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sliceLines(
  text: string,
  lineStarts: number[],
  from: number,
  to: number
): string[] {
  const lines: string[] = [];
  const clampFrom = Math.max(0, from);
  const clampTo = Math.min(lineStarts.length, to);
  for (let ln = clampFrom; ln < clampTo; ln++) {
    const start = lineStarts[ln] ?? 0;
    const next = lineStarts[ln + 1];
    const end = next !== undefined ? next - 1 : text.length;
    lines.push(text.slice(start, end));
  }
  return lines;
}

/** Agent-facing hint for each failure — imperative, names the next action. */
export function editErrorHint(
  code: EditErrorCode,
  filePath: string,
  count: number
): string {
  switch (code) {
    case "not_found":
      return `old_string not found in ${filePath}. Likely a whitespace/quote drift or the file changed. Call file_read on the target range, then retry file_edit with the exact bytes.`;
    case "ambiguous":
      return `old_string matched ${count} times in ${filePath}. Add surrounding lines to old_string to make it unique, or pass replace_all:true.`;
    case "stale":
      return `${filePath} changed since you read it (base_hash mismatch). Call file_read on the file again, then retry file_edit with the fresh bytes and the new base_hash.`;
    case "unchanged":
      return `old_string and new_string are identical — no edit to apply to ${filePath}.`;
  }
}
