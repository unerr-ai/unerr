/**
 * Docstring/Comment Extractor — extracts documentation annotations from entities.
 *
 * Reads JSDoc, Python docstrings, Go doc comments, etc. from the source
 * and associates them with the closest entity declaration.
 */

export interface DocAnnotation {
  entityKey: string;
  docstring: string;
  tags: string[];
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

  const commentLines: string[] = [];
  let i = lineIdx - 1;

  while (i >= 0) {
    const line = lines[i]?.trim();
    if (line === undefined) break;
    if (line.startsWith("*") || line.startsWith("//") || line.startsWith("#")) {
      commentLines.unshift(line);
      i--;
    } else if (line === "/**" || line === "*/") {
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

  if (commentLines.length === 0) return null;

  const text = commentLines
    .join("\n")
    .replace(/^\/\*\*?\s*|\s*\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\/\/\s?/gm, "")
    .replace(/^#\s?/gm, "")
    .replace(/^"""|'''|"""|'''/gm, "")
    .trim();

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
