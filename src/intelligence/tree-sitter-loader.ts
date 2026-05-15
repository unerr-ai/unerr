/**
 * Tree-sitter WASM Loader — lazy initialization with grammar caching.
 *
 * Loads tree-sitter and language grammars on-demand. Caches parsers
 * per-language to avoid repeated WASM compilation.
 *
 * Performance: first load ~20ms, subsequent parses <1ms per file.
 */

import type Parser from "web-tree-sitter";

let TreeSitter: typeof Parser | null = null;
let initPromise: Promise<typeof Parser> | null = null;

const parserCache = new Map<string, Parser>();

/**
 * Initialize the Tree-sitter runtime. Idempotent — only loads once.
 */
export async function initTreeSitter(): Promise<typeof Parser> {
  if (TreeSitter) return TreeSitter;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const mod = await import("web-tree-sitter");
    const TS = mod.default;
    await TS.init();
    TreeSitter = TS;
    return TS;
  })();

  return initPromise;
}

/**
 * Resolve the path to a tree-sitter WASM grammar file.
 */
function resolveGrammarPath(wasmName: string): string {
  try {
    return require.resolve(`tree-sitter-wasms/out/${wasmName}`);
  } catch {
    const { join } = require("node:path") as typeof import("node:path");
    return join(
      process.cwd(),
      "node_modules",
      "tree-sitter-wasms",
      "out",
      wasmName
    );
  }
}

/**
 * Get a parser for a specific language. Caches the Language + Parser.
 */
export async function getParser(wasmName: string): Promise<Parser> {
  const cached = parserCache.get(wasmName);
  if (cached) return cached;

  const TS = await initTreeSitter();
  const grammarPath = resolveGrammarPath(wasmName);
  const language = await TS.Language.load(grammarPath);

  const parser = new TS();
  parser.setLanguage(language);
  parserCache.set(wasmName, parser);

  return parser;
}

/**
 * Parse source code with a cached language parser.
 */
export async function parseSource(
  source: string,
  wasmName: string
): Promise<Parser.Tree> {
  const parser = await getParser(wasmName);
  return parser.parse(source);
}

/**
 * Clear parser cache (for testing or memory reclaim).
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    parser.delete();
  }
  parserCache.clear();
}
