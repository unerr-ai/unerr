/**
 * Docstring/Comment Extractor — extracts documentation annotations from entities.
 *
 * Reads JSDoc, Python docstrings, Go doc comments, etc. from the source
 * and associates them with the closest entity declaration. The prose feeds
 * the harvested annotation tier (source='harvested') — no structured
 * comment format is required or parsed.
 */

export interface DocAnnotation {
  entityKey: string;
  docstring: string;
  tags: string[];
}

/** Decorators/attribute macros allowed between the doc comment and the entity. */
const MAX_ATTRIBUTE_GAP_LINES = 8;

export interface ParsedDocComment {
  /** Doc-comment prose, ≤500 chars. Null when the block is empty. */
  prose: string | null;
  /** JSDoc-style tags from the prose. */
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
 * Extract the doc comment for an entity as prose + tags. Prose is capped
 * at 500 chars.
 */
export function extractParsedDocComment(
  source: string,
  entityStartLine: number
): ParsedDocComment | null {
  const lines = source.split("\n");
  const lineIdx = entityStartLine - 1;
  if (lineIdx <= 0 || lineIdx >= lines.length) return null;

  const commentLines = collectCommentBlock(lines, lineIdx);
  if (commentLines.length === 0) return null;

  const text = cleanCommentText(commentLines);
  if (text.length === 0) return null;

  return {
    prose: text.slice(0, 500),
    tags: extractDocTags(text),
  };
}
