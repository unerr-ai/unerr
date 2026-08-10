/**
 * Tree-sitter WASM Loader — lazy initialization with grammar caching.
 *
 * Loads tree-sitter and language grammars on-demand. Caches parsers
 * per-language to avoid repeated WASM compilation.
 *
 * Performance: first load ~20ms, subsequent parses <1ms per file.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
// Pinned below 0.25 on purpose. The 0.25 runtime rewrote this API (default
// export split into named `Parser`/`Language`, `SyntaxNode` renamed to `Node`)
// AND stopped being able to load the grammars in tree-sitter-wasms 0.1.13 —
// every one of them fails while the runtime parses the wasm dynamic-link
// header. The API rename is a day of typing; the grammar break has no fix
// available, because 0.1.13 is the newest grammar package published. Nothing
// here throws loudly if you ignore this: getParser() rejects, callers fall back
// to the regex extractor, and the graph just gets worse. See the pin and its
// reasoning in .github/dependabot.yml.
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
    // createRequire, NOT bare require.resolve: the tsup bundle is pure ESM,
    // where `require` is undefined — both the resolve and the old
    // require("node:path") fallback threw, so grammars never resolved and
    // indexing silently fell back to the regex extractor.
    const esmRequire = createRequire(import.meta.url);
    return esmRequire.resolve(`tree-sitter-wasms/out/${wasmName}`);
  } catch {
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
