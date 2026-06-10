/**
 * Layer 8 §2.1.1 — the documented exit. `unerr uninstall --strip-annotations`
 * removes `@sem` sentinel lines from source comments repo-wide. Prose summaries
 * (the team's own documentation) are NEVER touched — only the machine-readable
 * sentinel line goes. The result is byte-identical except for the removed lines,
 * so the round-trip is reviewable as a clean diff and reversible by `git`.
 *
 * This is a pure filesystem sweep with no graph dependency — it must work after
 * the index is already gone (uninstall removes `.unerr/` separately). The
 * sentinel-match rule mirrors the parser's (`matchSentinelToken`): the token
 * followed by whitespace or end-of-line, on a line that is itself a comment.
 */

import {
  type Dirent,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_SENTINEL_TOKENS } from "./docstring-extractor.js";

/** Source extensions that can carry doc-comment sentinels (mirrors local-indexer's INDEXABLE_EXTENSIONS). */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
]);

/** Directories never walked (mirrors local-indexer's EXCLUDED_DIRS). */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".hg",
  ".svn",
  "coverage",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".unerr",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

/** Skip files larger than this — sentinels never live in generated megabyte blobs. */
const MAX_FILE_SIZE = 1_048_576;

/** True when `line` is a comment line carrying a sentinel token (token + whitespace/EOL). */
function lineCarriesSentinel(line: string, tokens: readonly string[]): boolean {
  const trimmed = line.trim();
  const looksComment =
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    (trimmed.startsWith("#") && !trimmed.startsWith("#[")) ||
    trimmed.startsWith("--") ||
    trimmed.startsWith(";;");
  if (!looksComment) return false;
  for (const token of tokens) {
    const idx = line.indexOf(token);
    if (idx === -1) continue;
    const after = line[idx + token.length];
    if (after === undefined || /\s/.test(after)) return true;
  }
  return false;
}

export interface StripResult {
  /** Source with sentinel lines removed (everything else byte-identical). */
  content: string;
  /** Number of sentinel lines removed. */
  linesRemoved: number;
}

/**
 * Remove sentinel-carrying comment lines from one file's content. Only the
 * sentinel line itself is dropped; surrounding prose is preserved verbatim.
 *
 * Safety: when a sentinel sits on a line that ALSO closes a block comment
 * (the closing star-slash rides the same line as `@sem`), that closer is
 * preserved (the line collapses to just the closer) so the strip never
 * comments out the following code.
 */
export function stripSentinelLines(
  content: string,
  tokens: readonly string[] = DEFAULT_SENTINEL_TOKENS
): StripResult {
  if (tokens.length === 0) return { content, linesRemoved: 0 };
  const lines = content.split("\n");
  const out: string[] = [];
  let linesRemoved = 0;
  for (const line of lines) {
    if (!lineCarriesSentinel(line, tokens)) {
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    const isOneLineBlock = trimmed.startsWith("/*") && trimmed.endsWith("*/");
    if (!isOneLineBlock && trimmed.endsWith("*/")) {
      // Sentinel rides the block's closing line — keep the closer, drop the
      // sentinel text, so following code is never swallowed by the comment.
      const indent = line.slice(0, line.length - line.trimStart().length);
      const cr = line.endsWith("\r") ? "\r" : "";
      out.push(`${indent}*/${cr}`);
      linesRemoved++;
      continue;
    }
    // Pure sentinel line (or a self-contained one-line block) — drop entirely.
    linesRemoved++;
  }
  return { content: out.join("\n"), linesRemoved };
}

export interface RepoStripResult {
  filesScanned: number;
  filesChanged: number;
  linesRemoved: number;
  /** Relative paths of files that were rewritten. */
  changedFiles: string[];
}

/** Recursively collect source files under `dir`, skipping excluded directories. */
function collectSourceFiles(root: string, dir: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, best-effort
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectSourceFiles(root, full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    if (!SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
    acc.push(full);
  }
}

/**
 * Strip sentinel lines from every source file under `cwd`. Best-effort and
 * idempotent: a second run on an already-stripped repo changes nothing and
 * reports `filesChanged: 0`. Unreadable/oversized files are skipped silently.
 */
export function stripAnnotationsFromRepo(
  cwd: string,
  tokens: readonly string[] = DEFAULT_SENTINEL_TOKENS
): RepoStripResult {
  const result: RepoStripResult = {
    filesScanned: 0,
    filesChanged: 0,
    linesRemoved: 0,
    changedFiles: [],
  };
  if (tokens.length === 0) return result;

  const files: string[] = [];
  collectSourceFiles(cwd, cwd, files);

  for (const file of files) {
    let content: string;
    try {
      if (statSync(file).size > MAX_FILE_SIZE) continue;
      content = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable — skip
    }
    result.filesScanned++;
    // Cheap pre-filter: no token anywhere → nothing to do, no rewrite.
    if (!tokens.some((t) => content.includes(t))) continue;
    const { content: stripped, linesRemoved } = stripSentinelLines(
      content,
      tokens
    );
    if (linesRemoved === 0 || stripped === content) continue;
    try {
      writeFileSync(file, stripped, "utf8");
    } catch {
      continue; // unwritable — skip, don't abort the sweep
    }
    result.filesChanged++;
    result.linesRemoved += linesRemoved;
    result.changedFiles.push(relative(cwd, file));
  }
  return result;
}
