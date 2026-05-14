/**
 * Language Detection & Tier Assignment — maps file extensions to languages,
 * assigns extraction tiers, and dispatches to the correct plugin.
 *
 * Tiers:
 *   Tier 1: Full tree-sitter + SCIP enrichment path (8 languages)
 *   Tier 2: Tree-sitter extraction only (10+ languages)
 *   Tier 3: Regex fallback for unknown languages
 */

export type LanguageTier = 1 | 2 | 3;

export interface LanguageInfo {
  id: string;
  name: string;
  tier: LanguageTier;
  extensions: string[];
  grammarWasm: string | null;
}

const LANGUAGE_MAP: Record<string, LanguageInfo> = {
  ".ts": {
    id: "typescript",
    name: "TypeScript",
    tier: 1,
    extensions: [".ts", ".tsx"],
    grammarWasm: "tree-sitter-typescript.wasm",
  },
  ".tsx": {
    id: "typescript",
    name: "TypeScript",
    tier: 1,
    extensions: [".ts", ".tsx"],
    grammarWasm: "tree-sitter-typescript.wasm",
  },
  ".js": {
    id: "javascript",
    name: "JavaScript",
    tier: 1,
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    grammarWasm: "tree-sitter-javascript.wasm",
  },
  ".jsx": {
    id: "javascript",
    name: "JavaScript",
    tier: 1,
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    grammarWasm: "tree-sitter-javascript.wasm",
  },
  ".mjs": {
    id: "javascript",
    name: "JavaScript",
    tier: 1,
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    grammarWasm: "tree-sitter-javascript.wasm",
  },
  ".cjs": {
    id: "javascript",
    name: "JavaScript",
    tier: 1,
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    grammarWasm: "tree-sitter-javascript.wasm",
  },
  ".py": {
    id: "python",
    name: "Python",
    tier: 1,
    extensions: [".py"],
    grammarWasm: "tree-sitter-python.wasm",
  },
  ".go": {
    id: "go",
    name: "Go",
    tier: 1,
    extensions: [".go"],
    grammarWasm: "tree-sitter-go.wasm",
  },
  ".java": {
    id: "java",
    name: "Java",
    tier: 1,
    extensions: [".java"],
    grammarWasm: "tree-sitter-java.wasm",
  },
  ".rs": {
    id: "rust",
    name: "Rust",
    tier: 1,
    extensions: [".rs"],
    grammarWasm: "tree-sitter-rust.wasm",
  },
  ".rb": {
    id: "ruby",
    name: "Ruby",
    tier: 1,
    extensions: [".rb"],
    grammarWasm: "tree-sitter-ruby.wasm",
  },
  ".cs": {
    id: "csharp",
    name: "C#",
    tier: 1,
    extensions: [".cs"],
    grammarWasm: "tree-sitter-c_sharp.wasm",
  },
  ".c": {
    id: "c",
    name: "C",
    tier: 2,
    extensions: [".c", ".h"],
    grammarWasm: "tree-sitter-c.wasm",
  },
  ".h": {
    id: "c",
    name: "C",
    tier: 2,
    extensions: [".c", ".h"],
    grammarWasm: "tree-sitter-c.wasm",
  },
  ".cpp": {
    id: "cpp",
    name: "C++",
    tier: 2,
    extensions: [".cpp", ".cc", ".cxx", ".hpp"],
    grammarWasm: "tree-sitter-cpp.wasm",
  },
  ".cc": {
    id: "cpp",
    name: "C++",
    tier: 2,
    extensions: [".cpp", ".cc", ".cxx", ".hpp"],
    grammarWasm: "tree-sitter-cpp.wasm",
  },
  ".cxx": {
    id: "cpp",
    name: "C++",
    tier: 2,
    extensions: [".cpp", ".cc", ".cxx", ".hpp"],
    grammarWasm: "tree-sitter-cpp.wasm",
  },
  ".hpp": {
    id: "cpp",
    name: "C++",
    tier: 2,
    extensions: [".cpp", ".cc", ".cxx", ".hpp"],
    grammarWasm: "tree-sitter-cpp.wasm",
  },
  ".php": {
    id: "php",
    name: "PHP",
    tier: 2,
    extensions: [".php"],
    grammarWasm: "tree-sitter-php.wasm",
  },
  ".swift": {
    id: "swift",
    name: "Swift",
    tier: 2,
    extensions: [".swift"],
    grammarWasm: "tree-sitter-swift.wasm",
  },
  ".kt": {
    id: "kotlin",
    name: "Kotlin",
    tier: 2,
    extensions: [".kt", ".kts"],
    grammarWasm: "tree-sitter-kotlin.wasm",
  },
  ".kts": {
    id: "kotlin",
    name: "Kotlin",
    tier: 2,
    extensions: [".kt", ".kts"],
    grammarWasm: "tree-sitter-kotlin.wasm",
  },
  ".scala": {
    id: "scala",
    name: "Scala",
    tier: 2,
    extensions: [".scala"],
    grammarWasm: "tree-sitter-scala.wasm",
  },
  ".lua": {
    id: "lua",
    name: "Lua",
    tier: 2,
    extensions: [".lua"],
    grammarWasm: "tree-sitter-lua.wasm",
  },
  ".dart": {
    id: "dart",
    name: "Dart",
    tier: 2,
    extensions: [".dart"],
    grammarWasm: "tree-sitter-dart.wasm",
  },
  ".ex": {
    id: "elixir",
    name: "Elixir",
    tier: 2,
    extensions: [".ex", ".exs"],
    grammarWasm: "tree-sitter-elixir.wasm",
  },
  ".exs": {
    id: "elixir",
    name: "Elixir",
    tier: 2,
    extensions: [".ex", ".exs"],
    grammarWasm: "tree-sitter-elixir.wasm",
  },
  ".zig": {
    id: "zig",
    name: "Zig",
    tier: 2,
    extensions: [".zig"],
    grammarWasm: "tree-sitter-zig.wasm",
  },
};

export function detectLanguage(filePath: string): LanguageInfo | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return LANGUAGE_MAP[ext] ?? null;
}

export function getLanguageTier(filePath: string): LanguageTier {
  const info = detectLanguage(filePath);
  if (!info) return 3;
  return info.tier;
}

export function isSupportedExtension(ext: string): boolean {
  return ext in LANGUAGE_MAP;
}

export function getAllSupportedExtensions(): string[] {
  return Object.keys(LANGUAGE_MAP);
}
