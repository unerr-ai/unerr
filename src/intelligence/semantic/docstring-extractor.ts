/**
 * Docstring/Comment Extractor — extracts documentation annotations from entities.
 *
 * Reads JSDoc, Python docstrings, Go doc comments, etc. from the source
 * and associates them with the closest entity declaration.
 *
 * Layer 8 (domain understanding): also parses the sentinel line — one
 * machine-readable `k=v` line inside the doc comment carrying the entity's
 * domain/role tags. Token is vendor-neutral (`@sem` by default) and
 * configurable via the `comments.sentinel` setting.
 * See .internal/roadmap/LAYER_8_DOMAIN_UNDERSTANDING.md §2.
 */

export interface DocAnnotation {
  entityKey: string;
  docstring: string;
  tags: string[];
}

/** Default sentinel token; overridable via the `comments.sentinel` setting (§2.1.1). */
export const DEFAULT_SENTINEL_TOKENS = ["@sem"];

/**
 * Keys whose values must be kebab-case (comma-lists allowed). `coupled` and
 * unknown keys pass through raw — they carry file paths / entity names that
 * are legitimately not kebab (e.g. `coupled=src/auth/token.ts,validateToken`).
 */
const KEBAB_VALIDATED_KEYS = new Set(["domain", "role", "stability"]);

const KEBAB_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_SHAPE = /^[a-z][a-z0-9_-]*$/;

/** Decorators/attribute macros allowed between the doc comment and the entity. */
const MAX_ATTRIBUTE_GAP_LINES = 8;

export interface SentinelParse {
  /** Valid k=v pairs from the first sentinel line (first wins on duplicate keys). */
  pairs: Record<string, string>;
  /** Raw tokens that failed k=v shape or kebab validation — gate input (§5.2). */
  invalidPairs: string[];
  /** Character length of the first sentinel line — length-gate input (≤120, §5.2). */
  lineLength: number;
  /** Total sentinel lines in the block; >1 → stacking gate rejects the rest (§5.2). */
  stackedCount: number;
}

export interface ParsedDocComment {
  /** Prose with sentinel lines removed, ≤500 chars. Null when the block is sentinel-only. */
  prose: string | null;
  /** Parsed first sentinel line; null when no line carries a sentinel token. */
  sentinel: SentinelParse | null;
  /** JSDoc-style tags from the prose (sentinel tokens excluded). */
  tags: string[];
}

/** Comment-line prefixes across the extractor languages. `#[` is a Rust attribute, not a comment. */
function isCommentLine(line: string): boolean {
  return (
    line.startsWith("*") ||
    line.startsWith("//") ||
    (line.startsWith("#") && !line.startsWith("#[")) ||
    line.startsWith("--") ||
    line.startsWith(";;")
  );
}

/** Decorator / attribute-macro lines that may sit between the doc comment and the entity. */
function isAttributeGapLine(line: string): boolean {
  return /^@[\w.]/.test(line) || line.startsWith("#[");
}

/**
 * Walk backward from the entity start line and collect its doc-comment block.
 * Skips decorator/attribute-macro lines between the comment and the entity
 * (Python/TS decorators, Rust `#[...]`), capped at MAX_ATTRIBUTE_GAP_LINES.
 */
function collectCommentBlock(lines: string[], entityLineIdx: number): string[] {
  const commentLines: string[] = [];
  let i = entityLineIdx - 1;

  let gap = 0;
  while (i >= 0 && gap < MAX_ATTRIBUTE_GAP_LINES) {
    const line = lines[i]?.trim();
    if (line === undefined || !isAttributeGapLine(line)) break;
    i--;
    gap++;
  }

  while (i >= 0) {
    const line = lines[i]?.trim();
    if (line === undefined) break;
    if (line === "/**" || line === "*/") {
      commentLines.unshift(line);
      i--;
    } else if (isCommentLine(line)) {
      commentLines.unshift(line);
      i--;
    } else if (line.startsWith("/*")) {
      commentLines.unshift(line);
      break;
    } else if (line === '"""' || line === "'''") {
      commentLines.unshift(line);
      break;
    } else {
      break;
    }
  }

  return commentLines;
}

/** Strip comment syntax (block markers, line prefixes) and return the plain text. */
function cleanCommentText(commentLines: string[]): string {
  return commentLines
    .join("\n")
    .replace(/^\/\*\*?\s*|\s*\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\/{2,3}!?\s?/gm, "")
    .replace(/^#\s?/gm, "")
    .replace(/^--\s?/gm, "")
    .replace(/^;;+\s?/gm, "")
    .replace(/^"""|'''|"""|'''/gm, "")
    .trim();
}

/**
 * Extract doc comment text from raw source at a specific line.
 * Looks backward from the entity start line for comment blocks.
 */
export function extractDocComment(
  source: string,
  entityStartLine: number
): string | null {
  const lines = source.split("\n");
  const lineIdx = entityStartLine - 1;
  if (lineIdx <= 0 || lineIdx >= lines.length) return null;

  const commentLines = collectCommentBlock(lines, lineIdx);
  if (commentLines.length === 0) return null;

  const text = cleanCommentText(commentLines);
  return text.length > 0 ? text.slice(0, 500) : null;
}

/**
 * Extract JSDoc tags (@param, @returns, @deprecated, etc.)
 */
export function extractDocTags(docstring: string): string[] {
  const tagPattern = /@(\w+)/g;
  const tags: string[] = [];
  let match: RegExpExecArray | null;

  match = tagPattern.exec(docstring);
  while (match !== null) {
    tags.push(match[1]!);
    match = tagPattern.exec(docstring);
  }

  return [...new Set(tags)];
}

/**
 * If the line carries a sentinel token (token followed by whitespace or
 * end-of-line), return the text after the token; otherwise null.
 */
function matchSentinelToken(line: string, tokens: string[]): string | null {
  for (const token of tokens) {
    const idx = line.indexOf(token);
    if (idx === -1) continue;
    const after = line[idx + token.length];
    if (after === undefined || /\s/.test(after)) {
      return line.slice(idx + token.length).trim();
    }
  }
  return null;
}

/**
 * Parse sentinel lines out of cleaned doc-comment text (§2.1 grammar):
 * space-separated `k=v` pairs; kebab-case values for vocabulary keys;
 * unknown keys pass through (extras); first sentinel line wins, the rest
 * only increment `stackedCount` for the stacking gate.
 *
 * Pure and total: malformed pairs land in `invalidPairs`, never throw.
 */
export function parseSentinelText(
  text: string,
  tokens: string[] = DEFAULT_SENTINEL_TOKENS
): SentinelParse | null {
  if (tokens.length === 0) return null;

  let parse: SentinelParse | null = null;
  let stacked = 0;

  for (const line of text.split("\n")) {
    const rest = matchSentinelToken(line, tokens);
    if (rest === null) continue;
    stacked++;
    if (parse !== null) continue; // first wins (§2.3 cap discipline)

    const pairs = new Map<string, string>();
    const invalidPairs: string[] = [];
    for (const piece of rest.split(/\s+/).filter(Boolean)) {
      const eq = piece.indexOf("=");
      const key = eq > 0 ? piece.slice(0, eq) : "";
      const value = eq > 0 ? piece.slice(eq + 1) : "";
      if (!KEY_SHAPE.test(key) || value.length === 0 || pairs.has(key)) {
        invalidPairs.push(piece);
        continue;
      }
      if (
        KEBAB_VALIDATED_KEYS.has(key) &&
        !value.split(",").every((v) => KEBAB_VALUE.test(v))
      ) {
        invalidPairs.push(piece);
        continue;
      }
      pairs.set(key, value);
    }

    parse = {
      pairs: Object.fromEntries(pairs),
      invalidPairs,
      lineLength: line.trim().length,
      stackedCount: 0,
    };
  }

  if (parse !== null) parse.stackedCount = stacked;
  return parse;
}

/**
 * Extract the doc comment for an entity and split it into prose + sentinel.
 * Prose is capped at 500 chars AFTER sentinel removal, so a long docstring
 * never truncates the machine line.
 */
export function extractParsedDocComment(
  source: string,
  entityStartLine: number,
  tokens: string[] = DEFAULT_SENTINEL_TOKENS
): ParsedDocComment | null {
  const lines = source.split("\n");
  const lineIdx = entityStartLine - 1;
  if (lineIdx <= 0 || lineIdx >= lines.length) return null;

  const commentLines = collectCommentBlock(lines, lineIdx);
  if (commentLines.length === 0) return null;

  const text = cleanCommentText(commentLines);
  if (text.length === 0) return null;

  const sentinel = parseSentinelText(text, tokens);
  const proseText = text
    .split("\n")
    .filter((line) => matchSentinelToken(line, tokens) === null)
    .join("\n")
    .trim();

  return {
    prose: proseText.length > 0 ? proseText.slice(0, 500) : null,
    sentinel,
    tags: extractDocTags(proseText),
  };
}
