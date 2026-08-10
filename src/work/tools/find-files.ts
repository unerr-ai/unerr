/**
 * Work-mode `find_files` — name and content search with NO index.
 *
 * Code mode answers "where is X" from the indexed call graph. Work mode has no
 * graph and no indexing step: the host may have opened a folder two seconds
 * ago. So this walks the tree on demand, which is the honest implementation for
 * a folder of documents (thousands of files, not hundreds of thousands).
 *
 * What keeps the walk cheap:
 *   - a hard-coded skip list for directories no document search wants
 *     (`node_modules`, `.git`, build output, virtualenvs, the state dir)
 *   - `.gitignore` files, read per directory and applied to everything below,
 *     matching git's own precedence (deepest rule wins, `!` re-includes)
 *   - binary sniffing (a NUL byte in the first 8 KB) and a per-file size cap,
 *     so content search never reads a video into memory
 *   - bounded results: the walk stops once `limit` files have matched
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Directories never walked, whatever .gitignore says. */
const ALWAYS_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".unerr",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
]);

/** Files larger than this are never opened for a content search. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** Bytes sniffed for a NUL to decide "binary". */
const SNIFF_BYTES = 8 * 1024;

/** Hard ceiling on directories visited, so a pathological tree still returns. */
const MAX_DIRS_VISITED = 20_000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_CONTEXT = 2;
const MAX_CONTEXT = 6;

/** Matched lines reported per file — beyond this the count is summarized. */
const MAX_LINES_PER_FILE = 5;

// ── .gitignore matching ──────────────────────────────────────────────────────

interface IgnoreRule {
  /** Compiled matcher against a path relative to the rule's own directory. */
  readonly re: RegExp;
  /** `!pattern` — re-includes a path an earlier rule excluded. */
  readonly negated: boolean;
  /** Pattern ended in `/` — matches directories only. */
  readonly dirOnly: boolean;
}

interface IgnoreScope {
  /** Directory the rules are anchored to, absolute. */
  readonly dir: string;
  readonly rules: readonly IgnoreRule[];
}

/**
 * Translate one gitignore pattern into a regular expression.
 * Supports `*` (no separator), `?`, `**` (any depth), a leading `/` (anchored to
 * the gitignore's own directory) and a trailing `/` (directory only).
 */
function compilePattern(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;

  let re = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === "*") {
      if (body[i + 1] === "*") {
        i++;
        if (body[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  // An unanchored pattern with no separator matches at any depth, like git.
  const prefix = anchored || body.includes("/") ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

function parseGitignore(dir: string): IgnoreScope | null {
  let text: string;
  try {
    text = readFileSync(join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    const withoutBang = negated ? trimmed.slice(1) : trimmed;
    const dirOnly = withoutBang.endsWith("/");
    const pattern = dirOnly ? withoutBang.slice(0, -1) : withoutBang;
    if (pattern.length === 0) continue;
    rules.push({ re: compilePattern(pattern), negated, dirOnly });
  }
  return rules.length > 0 ? { dir, rules } : null;
}

/**
 * Decide whether `absolute` is ignored. Scopes are ordered shallowest-first;
 * a deeper scope's rule wins, and within a scope the last matching rule wins —
 * which is git's precedence.
 */
function isIgnored(
  scopes: readonly IgnoreScope[],
  absolute: string,
  isDir: boolean
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const rel = relative(scope.dir, absolute).split(sep).join("/");
    if (rel.length === 0 || rel.startsWith("..")) continue;
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rel)) ignored = !rule.negated;
    }
  }
  return ignored;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface WorkFindFilesArgs {
  readonly name?: unknown;
  readonly content?: unknown;
  readonly regex?: unknown;
  readonly case_sensitive?: unknown;
  readonly path?: unknown;
  readonly limit?: unknown;
  readonly context?: unknown;
}

interface ContentHit {
  readonly line: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

interface FileResult {
  readonly relPath: string;
  readonly hits: readonly ContentHit[];
  readonly totalHits: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function runWorkFindFiles(
  args: WorkFindFilesArgs,
  ctx: { readonly workRoot: string }
): string {
  const namePattern =
    typeof args.name === "string" && args.name.trim().length > 0
      ? args.name.trim()
      : null;
  const contentQuery =
    typeof args.content === "string" && args.content.length > 0
      ? args.content
      : null;

  if (namePattern === null && contentQuery === null) {
    return "find_files needs name or content. Call find_files({name:'*.md'}) for filenames, or find_files({content:'search text'}) for text inside files.";
  }

  const subPath = typeof args.path === "string" ? args.path.trim() : "";
  const searchRoot =
    subPath.length > 0 ? resolve(ctx.workRoot, subPath) : ctx.workRoot;

  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(searchRoot);
  } catch {
    return `find_files cannot open ${subPath.length > 0 ? subPath : searchRoot}. Call find_files({name:'*'}) with no path to list the working folder.`;
  }
  if (!rootStat.isDirectory()) {
    return `${subPath} is a file, not a folder. Call file_read({file_path:'${subPath}'}) to read it.`;
  }

  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const contextLines = clampInt(args.context, DEFAULT_CONTEXT, 0, MAX_CONTEXT);
  const caseSensitive = args.case_sensitive === true;
  const useRegex = args.regex === true;

  const nameRe = namePattern === null ? null : compilePattern(namePattern);

  let contentRe: RegExp | null = null;
  if (contentQuery !== null) {
    const flags = caseSensitive ? "g" : "gi";
    try {
      contentRe = new RegExp(
        useRegex ? contentQuery : escapeLiteral(contentQuery),
        flags
      );
    } catch (err) {
      return `find_files could not compile content as a regular expression: ${err instanceof Error ? err.message : String(err)}. Drop regex:true to search for the literal text.`;
    }
  }

  const results: FileResult[] = [];
  let filesScanned = 0;
  let dirsVisited = 0;
  let truncated = false;

  const walk = (dir: string, scopes: readonly IgnoreScope[]): void => {
    if (results.length >= limit || dirsVisited >= MAX_DIRS_VISITED) {
      truncated = truncated || results.length >= limit;
      return;
    }
    dirsVisited++;

    const localScope = parseGitignore(dir);
    const nextScopes = localScope === null ? scopes : [...scopes, localScope];

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) {
        truncated = true;
        return;
      }
      const absolute = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (isIgnored(nextScopes, absolute, true)) continue;
        walk(absolute, nextScopes);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnored(nextScopes, absolute, false)) continue;

      const relPath = relative(ctx.workRoot, absolute).split(sep).join("/");
      if (nameRe !== null && !nameRe.test(relPath)) continue;

      if (contentRe === null) {
        results.push({ relPath, hits: [], totalHits: 0 });
        continue;
      }

      filesScanned++;
      const hits = scanContent(absolute, contentRe, contextLines);
      if (hits === null || hits.total === 0) continue;
      results.push({
        relPath,
        hits: hits.shown,
        totalHits: hits.total,
      });
    }
  };

  const rootScope = parseGitignore(ctx.workRoot);
  walk(searchRoot, rootScope === null ? [] : [rootScope]);

  return render(results, {
    namePattern,
    contentQuery,
    filesScanned,
    truncated,
    limit,
  });
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanContent(
  absolute: string,
  re: RegExp,
  contextLines: number
): { shown: ContentHit[]; total: number } | null {
  let buf: Buffer;
  try {
    const stat = statSync(absolute);
    if (stat.size > MAX_CONTENT_BYTES) return null;
    buf = readFileSync(absolute);
  } catch {
    return null;
  }
  if (looksBinary(buf)) return null;

  const lines = buf.toString("utf8").split("\n");
  const shown: ContentHit[] = [];
  let total = 0;

  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (!re.test(lines[i] as string)) continue;
    total++;
    if (shown.length >= MAX_LINES_PER_FILE) continue;
    shown.push({
      line: i + 1,
      text: (lines[i] as string).slice(0, 400),
      before: lines
        .slice(Math.max(0, i - contextLines), i)
        .map((l) => l.slice(0, 400)),
      after: lines
        .slice(i + 1, i + 1 + contextLines)
        .map((l) => l.slice(0, 400)),
    });
  }
  return { shown, total };
}

function render(
  results: readonly FileResult[],
  meta: {
    namePattern: string | null;
    contentQuery: string | null;
    filesScanned: number;
    truncated: boolean;
    limit: number;
  }
): string {
  if (results.length === 0) {
    const what =
      meta.contentQuery !== null
        ? `content "${meta.contentQuery}"`
        : `name "${meta.namePattern}"`;
    return `No file matched ${what}. Call find_files({name:'*'}) to list the working folder, then narrow from what it returns.`;
  }

  const out: string[] = [];
  out.push(
    `${results.length} file(s)${meta.truncated ? ` (capped at limit ${meta.limit})` : ""}`
  );

  for (const r of results) {
    if (r.hits.length === 0) {
      out.push(r.relPath);
      continue;
    }
    const more =
      r.totalHits > r.hits.length
        ? ` (+${r.totalHits - r.hits.length} more line(s))`
        : "";
    out.push(`${r.relPath} — ${r.totalHits} match(es)${more}`);
    for (const hit of r.hits) {
      for (let i = 0; i < hit.before.length; i++) {
        out.push(`  ${hit.line - hit.before.length + i}- ${hit.before[i]}`);
      }
      out.push(`  ${hit.line}: ${hit.text}`);
      for (let i = 0; i < hit.after.length; i++) {
        out.push(`  ${hit.line + 1 + i}- ${hit.after[i]}`);
      }
    }
  }

  if (meta.truncated) {
    out.push(
      `Result cap ${meta.limit} reached — call find_files with limit:${Math.min(MAX_LIMIT, meta.limit * 2)} or a narrower name pattern for the rest.`
    );
  }
  return out.join("\n");
}
