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
  readonly mode: "literal" | "regex";
  readonly query: string;
  readonly match_count: number;
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
 * Scan already-read file contents for a literal string or regex, returning each
 * hit with a bounded context slice. Pure — no I/O — so it is unit-testable
 * without a graph or a real repo. Stops collecting at the first cap hit (total
 * matches, total bytes) and marks `truncated`.
 */
export function scanFilesForPattern(
  files: ReadonlyArray<{ path: string; content: string }>,
  opts: ContentSearchOptions
): ContentSearchResult {
  const { mode, query } = opts;
  if (!query) {
    return {
      mode,
      query,
      match_count: 0,
      files_scanned: 0,
      matches: [],
      truncated: false,
      error: "empty query — pass the string/pattern to match",
    };
  }

  let re: RegExp;
  try {
    re = new RegExp(mode === "regex" ? query : escapeRegExp(query), "g");
  } catch (e) {
    return {
      mode,
      query,
      match_count: 0,
      files_scanned: 0,
      matches: [],
      truncated: false,
      error: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const matches: ContentMatch[] = [];
  let totalBytes = 0;
  let filesScanned = 0;
  let truncated = false;

  for (const { path, content } of files) {
    if (matches.length >= opts.limit || totalBytes >= opts.maxTotalBytes) {
      truncated = true;
      break;
    }
    filesScanned++;
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
        matches.length >= opts.limit ||
        totalBytes + sz > opts.maxTotalBytes
      ) {
        truncated = true;
        break;
      }
      matches.push({
        file_path: path,
        line: i + 1,
        match: lineText.trim().slice(0, 240),
        context: ctx,
      });
      totalBytes += sz;
      if (++perFile >= opts.maxPerFile) break;
    }
  }

  return {
    mode,
    query,
    match_count: matches.length,
    files_scanned: filesScanned,
    matches,
    truncated,
  };
}
