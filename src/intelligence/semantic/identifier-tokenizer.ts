/**
 * Identifier Tokenizer — splits code identifiers into semantic tokens.
 *
 * Handles: camelCase, PascalCase, snake_case, kebab-case, SCREAMING_CASE,
 * acronyms (e.g., HTMLParser → ["html", "parser"]), numbers.
 *
 * Performance: <1ms per entity (pure string splitting).
 */

export function tokenizeIdentifier(name: string): string[] {
  if (!name || name.length === 0) return [];

  const normalized = name
    .replace(/[-_./\\]/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  const raw = normalized.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];

  for (const part of raw) {
    const lower = part.toLowerCase();
    if (lower.length <= 1 && /\d/.test(lower)) continue;
    if (lower.length > 0) tokens.push(lower);
  }

  return tokens;
}

/**
 * Tokenize a file path into semantic tokens.
 */
export function tokenizeFilePath(filePath: string): string[] {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const tokens: string[] = [];

  for (const part of parts) {
    const withoutExt = part.replace(/\.[^.]+$/, "");
    tokens.push(...tokenizeIdentifier(withoutExt));
  }

  return tokens;
}

/**
 * Build a token frequency map from an array of identifiers.
 */
export function buildTokenFrequency(
  identifiers: string[]
): Map<string, number> {
  const freq = new Map<string, number>();

  for (const id of identifiers) {
    const tokens = tokenizeIdentifier(id);
    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return freq;
}
