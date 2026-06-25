/**
 * Content search over code files (Issue 2) — the exact-string / regex match the
 * entity graph cannot express, served in-tool so there is no correct reason left
 * to shell out to grep. Pure + deterministic: the caller gathers file contents
 * (from `file_index`), this scans them and returns bounded matches. Every result
 * carries a small surrounding-context slice so the agent does not fire a
 * follow-up read; hard caps (total matches, per-file matches, total bytes) keep
 * it from flooding context with whole files.
 *
 * @sem domain=search role=matcher
 */

export interface ContentMatch {
  readonly file_path: string;
  /** 1-based line number of the matched line. */
  readonly line: number;
  /** The matched line, trimmed and length-capped. */
  readonly match: string;
  /** The matched line ± `context` lines, joined — the bounded slice. */
  readonly context: string;
}

export interface ContentSearchResult {
  readonly files_scanned: number;
  readonly matches: ContentMatch[];
  readonly truncated: boolean;
  readonly error?: string;
}

export interface ContentSearchOptions {
  readonly mode: "literal" | "regex";
  readonly query: string;
  /** Max matches total across all files. */
  readonly limit: number;
  /** Lines of surrounding context per match. */
  readonly contextLines: number;
  /** Stop once collected context exceeds this many bytes. */
  readonly maxTotalBytes: number;
  /** Max matches collected from any single file. */
  readonly maxPerFile: number;
}

/** Escape regex metacharacters so a literal query matches as a plain substring. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Files larger than this are skipped by the streaming scan — a >2 MB file in
 * `file_index` is almost always generated / minified / a data blob, not source
 * the agent means to grep, and reading it blocks the event loop for no value.
 */
export const MAX_SCAN_FILE_BYTES = 2_000_000;

/**
 * Compile the query into a global RegExp, or return an error string. Literal
 * mode escapes the query so it matches as a plain substring. Shared by the pure
 * {@link scanFilesForPattern} and the streaming caller so both interpret a
 * pattern identically.
 */
export function compilePattern(
  mode: "literal" | "regex",
  query: string
): { re: RegExp } | { error: string } {
  if (!query)
    return { error: "empty query — pass the string/pattern to match" };
  try {
    return {
      re: new RegExp(mode === "regex" ? query : escapeRegExp(query), "g"),
    };
  } catch (e) {
    return {
      error: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Running accumulator threaded across a streaming, file-by-file scan. */
export interface ScanAccumulator {
  matches: ContentMatch[];
  totalBytes: number;
  truncated: boolean;
}

/**
 * Scan ONE file's content into `acc`, capped by the global limit + byte budget
 * and the per-file match cap. Returns `false` when a GLOBAL cap (total matches
 * or total bytes) is hit — the caller must then stop reading further files (the
 * early-exit that keeps a literal/regex search from reading the whole repo).
 * Pure — no I/O.
 */
export function scanFileInto(
  re: RegExp,
  path: string,
  content: string,
  opts: ContentSearchOptions,
  acc: ScanAccumulator
): boolean {
  if (
    acc.matches.length >= opts.limit ||
    acc.totalBytes >= opts.maxTotalBytes
  ) {
    acc.truncated = true;
    return false;
  }
  const lines = content.split("\n");
  let perFile = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? "";
    re.lastIndex = 0;
    if (!re.test(lineText)) continue;
    const from = Math.max(0, i - opts.contextLines);
    const to = Math.min(lines.length - 1, i + opts.contextLines);
    const ctx = lines.slice(from, to + 1).join("\n");
    const sz = ctx.length + path.length + 16;
    if (
      acc.matches.length >= opts.limit ||
      acc.totalBytes + sz > opts.maxTotalBytes
    ) {
      acc.truncated = true;
      return false; // global cap hit — stop the whole scan
    }
    acc.matches.push({
      file_path: path,
      line: i + 1,
      match: lineText.trim().slice(0, 240),
      context: ctx,
    });
    acc.totalBytes += sz;
    if (++perFile >= opts.maxPerFile) break; // per-file cap — move to next file
  }
  return true;
}

/**
 * Scan already-read file contents for a literal string or regex, returning each
 * hit with a bounded context slice. Pure — no I/O — so it is unit-testable
 * without a graph or a real repo. Stops collecting at the first cap hit (total
 * matches, total bytes) and marks `truncated`.
 *
 * For a real repo the proxy uses the streaming path ({@link compilePattern} +
 * {@link scanFileInto}) so it reads files lazily and stops at the cap instead of
 * materialising every file first; this array form stays for tests + small sets.
 */
export function scanFilesForPattern(
  files: ReadonlyArray<{ path: string; content: string }>,
  opts: ContentSearchOptions
): ContentSearchResult {
  const { mode, query } = opts;
  const compiled = compilePattern(mode, query);
  if ("error" in compiled) {
    return {
      files_scanned: 0,
      matches: [],
      truncated: false,
      error: compiled.error,
    };
  }

  const acc: ScanAccumulator = { matches: [], totalBytes: 0, truncated: false };
  let filesScanned = 0;
  for (const { path, content } of files) {
    if (
      acc.matches.length >= opts.limit ||
      acc.totalBytes >= opts.maxTotalBytes
    ) {
      acc.truncated = true;
      break;
    }
    filesScanned++;
    if (!scanFileInto(compiled.re, path, content, opts, acc)) break;
  }

  return {
    files_scanned: filesScanned,
    matches: acc.matches,
    truncated: acc.truncated,
  };
}
