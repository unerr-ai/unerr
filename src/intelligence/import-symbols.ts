/**
 * Lightweight, regex-based import-symbol extractor for the `get_imports` MCP
 * tool. The graph stores file→file import edges but does NOT persist the
 * imported symbol names; capturing them at the entity level would require a
 * schema change. This module reads the source file on demand and pairs each
 * resolved module path with the symbols imported from it.
 *
 * Languages covered: TypeScript / JavaScript (ESM `import` and CommonJS
 * `require`). For other languages the call returns an empty map and the
 * handler falls back to path-only output — identical to legacy behavior.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Map of import source string (as written in code, e.g. `./shell-classifier.js`
 * or `cozo-node`) → list of imported symbol names. A bare side-effect import
 * (`import "polyfill"`) maps to an empty array.
 */
export type ImportSymbolMap = Map<string, string[]>;

const ESM_IMPORT_RE =
  /import\s+(?:type\s+)?(?:([^"';]*?)\s+from\s+)?["']([^"']+)["']/g;
const REQUIRE_RE =
  /(?:const|let|var)\s+([^=]+?)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;

function parseClause(clause: string): string[] {
  // clause can be:
  //   "X"                       — default import
  //   "* as X"                  — namespace import
  //   "{ a, b as c }"           — named imports
  //   "X, { a, b }"             — default + named
  //   "X, * as Ns"              — default + namespace
  const symbols: string[] = [];
  const trimmed = clause.trim();
  if (!trimmed) return symbols;

  // Split off the named-imports block if present.
  const braceStart = trimmed.indexOf("{");
  let head = trimmed;
  let braced = "";
  if (braceStart !== -1) {
    const braceEnd = trimmed.indexOf("}", braceStart);
    if (braceEnd !== -1) {
      head = trimmed.slice(0, braceStart).replace(/,\s*$/, "").trim();
      braced = trimmed.slice(braceStart + 1, braceEnd);
    }
  }

  if (head) {
    for (const part of head.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const nsMatch = piece.match(/^\*\s+as\s+(\w+)$/);
      if (nsMatch) symbols.push(`* as ${nsMatch[1]}`);
      else if (/^\w+$/.test(piece)) symbols.push(piece);
    }
  }

  if (braced) {
    for (const item of braced.split(",")) {
      const piece = item.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      // "a as b" — record the original (exported) name.
      const original = piece.split(/\s+as\s+/)[0]?.trim();
      if (original && /^\w+$/.test(original)) symbols.push(original);
    }
  }

  return symbols;
}

function parseRequireClause(clause: string): string[] {
  // Patterns:
  //   "X"                — const X = require(...)
  //   "{ a, b: c }"      — destructured
  //   "{ a, b: c } = ..." — already trimmed by caller
  const symbols: string[] = [];
  const trimmed = clause.trim();
  if (!trimmed) return symbols;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    for (const item of trimmed.slice(1, -1).split(",")) {
      const piece = item.trim();
      if (!piece) continue;
      const original = piece.split(/\s*:\s*/)[0]?.trim();
      if (original && /^\w+$/.test(original)) symbols.push(original);
    }
  } else if (/^\w+$/.test(trimmed)) {
    symbols.push(trimmed);
  }
  return symbols;
}

/**
 * Parse import statements from a TS/JS source string. Returns a map keyed by
 * the literal source path/module specifier exactly as written. Comments and
 * strings outside import statements are tolerated; the regex anchors on
 * `import ... from "..."` and `require("...")` so false positives are rare.
 */
export function parseImportSymbols(source: string): ImportSymbolMap {
  const out: ImportSymbolMap = new Map();
  const append = (key: string, syms: string[]): void => {
    const existing = out.get(key);
    if (existing) existing.push(...syms);
    else out.set(key, syms.slice());
  };
  // Strip line and block comments so they can't trigger the regex (cheap pass).
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const m of stripped.matchAll(ESM_IMPORT_RE)) {
    const clause = m[1] ?? "";
    const src = m[2];
    if (!src) continue;
    append(src, parseClause(clause));
  }
  for (const m of stripped.matchAll(REQUIRE_RE)) {
    const clause = m[1] ?? "";
    const src = m[2];
    if (!src) continue;
    append(src, parseRequireClause(clause));
  }
  return out;
}

/**
 * Best-effort load of a source file and parse its imports. Returns an empty
 * map on any IO/parse failure — get_imports must remain useful even when the
 * file moved or the language isn't TS/JS.
 */
export async function loadImportSymbols(
  projectRoot: string,
  filePath: string,
): Promise<ImportSymbolMap> {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  try {
    const text = await fs.readFile(abs, "utf8");
    return parseImportSymbols(text);
  } catch {
    return new Map();
  }
}
