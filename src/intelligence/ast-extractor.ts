/**
 * Lightweight AST entity extractor — regex-based, zero-dependency.
 *
 * Extracts function, class, method, and interface declarations from source files
 * using language-specific regex patterns. Designed for drift detection where we
 * need entity boundaries (name + line range) without full semantic analysis.
 *
 * The SCIP indexer handles the heavy lifting for the base graph.
 * This extractor only needs to identify "what entities exist in this file" for
 * overlay diffing against the CozoDB base entities.
 *
 * Supported: TypeScript/JavaScript, Python, Go, Java, Rust, C/C++
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Build-time flag: `false` in the tsup/Node build (so the embedded-wasm
// branches below fold away), `true` in a compiled Bun binary.
declare const __UNERR_BINARY__: boolean;

function isCompiledBinary(): boolean {
  return typeof __UNERR_BINARY__ !== "undefined" && __UNERR_BINARY__;
}

// Embedded tree-sitter `.wasm` paths — ONLY present in a compiled Bun binary.
// Loaded via a dynamic import so the Node/worker build never resolves the
// `embedded-natives` module (the AST worker runs under `--experimental-strip-
// types`, which cannot map a static `./embedded-natives.js` specifier to its
// `.ts` source; a static import here made every worker parse return []). The
// branch that calls this only runs when isCompiledBinary() is true, where Bun
// has bundled the module in.
let _wasmPaths: Record<string, string> | null = null;
async function embeddedWasmPaths(): Promise<Record<string, string>> {
  if (_wasmPaths) return _wasmPaths;
  const mod = await import("./embedded-natives.js");
  _wasmPaths = mod.WASM_PATHS;
  return _wasmPaths;
}

/**
 * Extraction-logic version. Stored alongside the per-file content hashes when a
 * full index runs; the startup staleness planner forces a full reindex whenever
 * the stored version differs (see `staleness.ts`).
 *
 * BUMP THIS whenever the entity-extraction logic changes in a way that alters
 * the entities produced from unchanged source — otherwise a graph indexed by an
 * older extractor keeps its stale entities forever, because the file content
 * (and thus its hash) never changed.
 *
 * v2 (2026-05-31): tree-sitter parse-quality gate (fall back to regex on a
 * degraded/error parse — old grammar can't parse `import("./m").T` type
 * annotations), multi-line signature join, control-flow false-positive filter.
 */
export const EXTRACTOR_VERSION = "2";

export interface ExtractedEntity {
  /** Entity name */
  name: string;
  /** Entity kind: "function" | "class" | "method" | "interface" */
  kind: string;
  /** Function/method signature (params) */
  signature: string;
  /** Line number where entity starts (1-based) */
  line_start: number;
  /** Line number where entity ends (1-based) */
  line_end: number;
  /** SHA-256 of entity body text */
  content_hash: string;
  /** Plugin-level test detection (e.g., Rust #[cfg(test)] scope). Overrides file-level heuristic when true. */
  is_test?: boolean;
  /** Owning class name (for methods). Used to create class→method containment edges. */
  parent_class?: string;
}

type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "kotlin"
  | "swift";

const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".rake": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
};

/**
 * Detect language from file extension. Returns null for unsupported languages.
 */
export function detectLanguage(filePath: string): Language | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

/**
 * Control-flow keywords that the regex method pattern (`name(args) {`) would
 * otherwise capture as bogus methods (`if`/`switch`/`for`/…). Used to filter
 * them out in {@link extractEntities}.
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  "if",
  "else",
  "switch",
  "for",
  "while",
  "do",
  "catch",
  "return",
  "with",
]);

/**
 * Collapse a (possibly multi-line) declaration starting at `lines[startIdx]`
 * onto one logical line so the single-line entity patterns can match
 * signatures whose params or return type wrap across lines.
 *
 * Appends continuation lines until one carries a `{` (body open) or `;`
 * (statement end) at parenthesis-depth 0. Braces and semicolons nested inside
 * the parameter list (object-type params like `{ a: number; b: string }`) sit
 * at depth ≥ 1 and are skipped, so the join stops only at the real body `{` or
 * field `;`. Bounded by `maxJoin` lines to avoid runaway joins on malformed
 * input. Stray joins on non-declaration lines are harmless: the anchored
 * patterns simply fail to match the longer probe.
 */
function buildLogicalLine(
  lines: string[],
  startIdx: number,
  maxJoin = 16
): string {
  let depth = 0;
  let result = "";
  for (let j = startIdx; j < lines.length && j - startIdx <= maxJoin; j++) {
    const raw = lines[j] ?? "";
    result += j === startIdx ? raw : ` ${raw.trim()}`;
    for (let k = 0; k < raw.length; k++) {
      const ch = raw.charCodeAt(k);
      if (ch === 40)
        depth++; // (
      else if (ch === 41)
        depth--; // )
      else if ((ch === 123 || ch === 59) && depth <= 0) return result; // { ;
    }
  }
  return result;
}

/**
 * Extract entities from source code using regex patterns.
 * Returns empty array for unsupported languages (never throws).
 */
export function extractEntities(
  content: string,
  filePath: string
): ExtractedEntity[] {
  const language = detectLanguage(filePath);
  if (!language) return [];

  const lines = content.split("\n");
  const entities: ExtractedEntity[] = [];

  const patterns = getPatterns(language);
  let currentClassName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Methods and functions may carry multi-line signatures — params split
    // across lines (`fn(\n  a: string,\n  b: unknown\n)`), object-type params
    // (`stats: { entities: number; edges: number }`), and/or a return type that
    // wraps (`): Promise<\n  A | B | null\n> {`). The single-line patterns below
    // require the closing `)` and opening `{` on the matched text, so collapse
    // the declaration onto one logical line. line_start stays the opening line.
    const matchLine = buildLogicalLine(lines, i);

    for (const pattern of patterns) {
      const match = pattern.regex.exec(matchLine);
      if (match) {
        const rawName = match[pattern.nameGroup] ?? "";
        if (!rawName || rawName.length === 0) continue;

        // The method pattern (`name(args) {`) also matches control-flow
        // statements (`if (…) {`, `switch (…) {`, `for (…) {`, …) since the
        // keyword is a bare `\w+`. Skip those — they are not entities and
        // otherwise pollute the graph as bogus methods (e.g. `QueryRouter.if`).
        if (pattern.kind === "method" && CONTROL_FLOW_KEYWORDS.has(rawName)) {
          continue;
        }

        // Track current class context for method naming
        if (pattern.kind === "class") {
          currentClassName = rawName;
        }

        // Prefix method names with parent class (matches tree-sitter behavior)
        const name =
          pattern.kind === "method" && currentClassName
            ? `${currentClassName}.${rawName}`
            : rawName;

        const signature = match[pattern.sigGroup ?? 0] ?? "";
        const lineStart = i + 1; // 1-based
        const lineEnd = findBlockEnd(lines, i, language);
        const bodyLines = lines.slice(i, lineEnd);
        const body = bodyLines.join("\n");
        const contentHash = createHash("sha256")
          .update(body)
          .digest("hex")
          .slice(0, 16);

        entities.push({
          name,
          kind: pattern.kind,
          signature: signature.trim(),
          line_start: lineStart,
          line_end: lineEnd,
          content_hash: contentHash,
          parent_class:
            pattern.kind === "method"
              ? (currentClassName ?? undefined)
              : undefined,
        });
        break; // Only match first pattern per line
      }
    }
  }

  return entities;
}

interface PatternDef {
  regex: RegExp;
  kind: string;
  nameGroup: number;
  sigGroup?: number;
}

function getPatterns(language: Language): PatternDef[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return [
        // export function name(params) / async function name(params)
        {
          regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        // export class Name / class Name
        {
          regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // export interface Name
        {
          regex: /^(?:export\s+)?interface\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // method(params) { — inside class (with optional access modifiers).
        // Param group tolerates one level of nested parens (callback/function
        // types like `(cb: () => void)`); return-type group tolerates spaces
        // (`: Promise<Foo | null>`) up to the body `{`. Combined with the
        // multi-line-signature join in extractEntities, this captures methods
        // whose signatures span lines or carry complex param/return types.
        {
          regex:
            /^\s+(?:(?:private|protected|public|override|abstract|readonly)\s+)*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\s*(\((?:[^()]|\([^()]*\))*\))\s*(?::\s*[^{;]+)?[{]/,
          kind: "method",
          nameGroup: 1,
          sigGroup: 2,
        },
        // const name = function / const name = (params) =>
        {
          regex:
            /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/,
          kind: "function",
          nameGroup: 1,
        },
      ];

    case "python":
      return [
        // def name(params):
        {
          regex: /^(?:\s*)(?:async\s+)?def\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        // class Name:
        { regex: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
      ];

    case "go":
      return [
        // func name(params)
        {
          regex: /^func\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        // func (r *Type) Name(params)
        {
          regex: /^func\s+\([^)]+\)\s+(\w+)\s*(\([^)]*\))/,
          kind: "method",
          nameGroup: 1,
          sigGroup: 2,
        },
        // type Name struct
        { regex: /^type\s+(\w+)\s+struct/, kind: "class", nameGroup: 1 },
        // type Name interface
        { regex: /^type\s+(\w+)\s+interface/, kind: "interface", nameGroup: 1 },
      ];

    case "java":
      return [
        // public class Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // public interface Name
        {
          regex: /^\s*(?:public\s+|private\s+|protected\s+)?interface\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // public void name(params)
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*(\([^)]*\))/,
          kind: "method",
          nameGroup: 1,
          sigGroup: 2,
        },
      ];

    case "rust":
      return [
        // fn name(params)
        {
          regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        // struct Name
        { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: "class", nameGroup: 1 },
        // trait Name
        {
          regex: /^\s*(?:pub\s+)?trait\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // impl Name
        { regex: /^\s*impl(?:<[^>]+>)?\s+(\w+)/, kind: "class", nameGroup: 1 },
      ];

    case "c":
    case "cpp":
      return [
        // returnType name(params) {
        {
          regex: /^(?:\w+(?:\s*\*)?)\s+(\w+)\s*(\([^)]*\))\s*\{?$/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        // class Name
        { regex: /^\s*class\s+(\w+)/, kind: "class", nameGroup: 1 },
        // struct Name
        {
          regex: /^\s*(?:typedef\s+)?struct\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
      ];

    case "csharp":
      return [
        // class Name / public class Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:abstract\s+|sealed\s+)?(?:partial\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // interface Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:partial\s+)?interface\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // struct Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:readonly\s+)?(?:partial\s+)?struct\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // method: returnType Name(params)
        {
          regex:
            /^\s+(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:async\s+)?(?:virtual\s+|override\s+|abstract\s+)?(?:\w+(?:<[^>]+>)?(?:\[\])?)\s+(\w+)\s*(\([^)]*\))/,
          kind: "method",
          nameGroup: 1,
          sigGroup: 2,
        },
      ];

    case "ruby":
      return [
        // def name(params) / def self.name(params)
        {
          regex: /^\s*def\s+(?:self\.)?(\w+[?!=]?)\s*(\([^)]*\))?/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        // class Name
        { regex: /^\s*class\s+(\w+)/, kind: "class", nameGroup: 1 },
        // module Name
        { regex: /^\s*module\s+(\w+)/, kind: "interface", nameGroup: 1 },
      ];

    case "php":
      return [
        // class Name
        {
          regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // interface Name
        {
          regex: /^\s*interface\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // trait Name
        {
          regex: /^\s*trait\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // function name(params) / public function name(params)
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
      ];

    case "kotlin":
      return [
        // class Name / data class Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:open\s+|abstract\s+|sealed\s+|data\s+|enum\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // interface Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:sealed\s+)?interface\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // object Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?object\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // fun name(params)
        {
          regex:
            /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:open\s+|override\s+|abstract\s+)?(?:suspend\s+)?fun\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
      ];

    case "swift":
      return [
        // class Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)?(?:final\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // struct Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+)?struct\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // protocol Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+)?protocol\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        // enum Name
        {
          regex:
            /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+)?enum\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        // func name(params)
        {
          regex:
            /^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)?(?:static\s+|class\s+)?(?:override\s+)?func\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
      ];

    default:
      return [];
  }
}

/**
 * Find the end line of a code block starting at the given line.
 * Uses brace matching for C-like languages, indentation for Python.
 */
function findBlockEnd(
  lines: string[],
  startIdx: number,
  language: Language
): number {
  if (language === "python") {
    return findPythonBlockEnd(lines, startIdx);
  }
  if (language === "ruby") {
    return findRubyBlockEnd(lines, startIdx);
  }
  return findBraceBlockEnd(lines, startIdx);
}

function findBraceBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        foundOpen = true;
      } else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          return i + 1; // 1-based
        }
      }
    }
    // If no braces found after 200 lines, cap it
    if (i - startIdx > 200) return i + 1;
  }

  // If no closing brace, return a reasonable range
  return Math.min(startIdx + 10, lines.length);
}

function findPythonBlockEnd(lines: string[], startIdx: number): number {
  const startLine = lines[startIdx] ?? "";
  const baseIndent = startLine.search(/\S/);

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip blank lines
    if (line.trim().length === 0) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) {
      return i; // Previous line was last in block
    }
    if (i - startIdx > 200) return i + 1;
  }

  return lines.length;
}

function findRubyBlockEnd(lines: string[], startIdx: number): number {
  const keywords =
    /^\s*(?:def|class|module|if|unless|while|until|for|begin|case|do)\b/;
  let depth = 1; // The opening keyword is on startIdx

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (keywords.test(lines[i] ?? "")) depth++;
    if (/^\s*end\b/.test(lines[i] ?? "")) {
      depth--;
      if (depth === 0) return i + 1;
    }
    if (i - startIdx > 200) return i + 1;
  }

  return Math.min(startIdx + 10, lines.length);
}

/**
 * Generate an entity key that matches the entityHash algorithm.
 * Hash inputs: repoId + filePath + kind + name + signature
 * Output: 16-char hex (matches lib/indexer/entity-hash.ts)
 */
export function entityKey(
  repoId: string,
  filePath: string,
  kind: string,
  name: string,
  signature?: string
): string {
  const input = [repoId, filePath, kind, name, signature ?? ""].join("\0");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ── Tree-sitter WASM-based extraction (Task 6.5) ───────────────

/** Minimal tree-sitter node interface for AST walking. */
interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TSNode[];
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
  parent: TSNode | null;
  previousSibling: TSNode | null;
  /** True when the parse produced ERROR/MISSING nodes anywhere in the subtree. */
  hasError: boolean;
}

interface TSParser {
  parse(input: string): { rootNode: TSNode };
}

/** Tree-sitter grammar name for each language (maps to WASM file). */
const TS_GRAMMAR_MAP: Record<Language, string> = {
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  go: "go",
  java: "java",
  rust: "rust",
  c: "c",
  cpp: "cpp",
  csharp: "c_sharp",
  ruby: "ruby",
  php: "php",
  kotlin: "kotlin",
  swift: "swift",
};

/** TSX file extensions need the tsx grammar, not typescript. */
const TSX_EXTENSIONS = new Set([".tsx", ".jsx"]);

/** Cached parsers keyed by grammar name. null = load attempted but failed. */
const tsParserCache = new Map<string, TSParser | null>();

/** Whether tree-sitter init has been called. */
let tsInitDone = false;

/**
 * Resolve the grammar name for a file, handling TSX/JSX → tsx grammar.
 */
function resolveGrammar(filePath: string, language: Language): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  if (TSX_EXTENSIONS.has(ext)) return "tsx";
  return TS_GRAMMAR_MAP[language];
}

/**
 * Lazy-load a tree-sitter parser for a given grammar.
 * Returns null if WASM not available (graceful degradation to regex).
 */
async function getTSParser(grammar: string): Promise<TSParser | null> {
  if (tsParserCache.has(grammar)) {
    return tsParserCache.get(grammar) ?? null;
  }

  try {
    const TreeSitter = (await import("web-tree-sitter")).default;
    if (!tsInitDone) {
      // In a compiled binary the runtime `tree-sitter.wasm` is embedded, not on
      // disk under node_modules — point emscripten's loader at the embedded path.
      const coreWasm = isCompiledBinary()
        ? (await embeddedWasmPaths()).__core__
        : undefined;
      await TreeSitter.init(
        coreWasm ? { locateFile: () => coreWasm } : undefined
      );
      tsInitDone = true;
    }

    const parser = new TreeSitter();
    const wasmFile = `tree-sitter-${grammar}.wasm`;

    // Check tree-sitter-wasms/out/ first, then fallback paths.
    // Must check BOTH process.cwd() (user project) AND the unerr package dir,
    // since unerr often runs in a different project's directory.
    const pkgDir =
      import.meta.dirname ?? join(fileURLToPath(import.meta.url), "..");
    const pkgRoot = join(pkgDir, ".."); // dist/ → package root
    const possiblePaths = [
      join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmFile),
      join(process.cwd(), "node_modules", `tree-sitter-${grammar}`, wasmFile),
      join(process.cwd(), "node_modules", "web-tree-sitter", wasmFile),
      // Package-relative paths (when unerr is installed globally or in another project)
      join(pkgRoot, "node_modules", "tree-sitter-wasms", "out", wasmFile),
      join(pkgRoot, "node_modules", `tree-sitter-${grammar}`, wasmFile),
      join(pkgRoot, "node_modules", "web-tree-sitter", wasmFile),
    ];

    let wasmPath: string | null = null;
    if (isCompiledBinary()) {
      // Compiled binary: the grammar `.wasm` is embedded; node_modules is absent.
      wasmPath = (await embeddedWasmPaths())[grammar] ?? null;
    } else {
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          wasmPath = p;
          break;
        }
      }
    }

    if (!wasmPath) {
      tsParserCache.set(grammar, null);
      return null;
    }

    const lang = await TreeSitter.Language.load(wasmPath);
    parser.setLanguage(lang);
    const tsParser = parser as unknown as TSParser;
    tsParserCache.set(grammar, tsParser);
    return tsParser;
  } catch {
    tsParserCache.set(grammar, null);
    return null;
  }
}

/**
 * Pre-load tree-sitter WASM grammars for given languages (DEFERRED startup).
 * Called during deferred init so it doesn't block MCP startup.
 */
export async function preloadGrammars(
  languages: Language[] = [
    "typescript",
    "javascript",
    "python",
    "go",
    "java",
    "rust",
  ]
): Promise<void> {
  const grammars = new Set<string>();
  for (const lang of languages) {
    grammars.add(TS_GRAMMAR_MAP[lang]);
  }
  // Also preload tsx
  grammars.add("tsx");

  await Promise.allSettled([...grammars].map((g) => getTSParser(g)));
}

/**
 * Extract entities from source code using tree-sitter AST parsing.
 * Falls back to regex-based extraction if WASM is unavailable.
 *
 * Advantages over regex:
 * - No false positives from comments or string literals
 * - Methods include parent class context
 * - Handles multi-line signatures and nested generics correctly
 */
export async function extractEntitiesAsync(
  content: string,
  filePath: string
): Promise<ExtractedEntity[]> {
  const language = detectLanguage(filePath);
  if (!language) return [];

  const grammar = resolveGrammar(filePath, language);
  const parser = await getTSParser(grammar);
  if (!parser) {
    // Graceful fallback to regex extraction
    return extractEntities(content, filePath);
  }

  try {
    const tree = parser.parse(content);
    const lines = content.split("\n");
    const tsEntities = extractFromAST(tree.rootNode, lines, language);

    // Parse-quality gate. The bundled tree-sitter grammars are version-pinned
    // (tree-sitter-wasms 0.1.13 — older than current TS syntax) and choke on
    // some constructs: e.g. an inline `import("./mod").Type` type annotation on
    // a class property collapses the whole-file parse to a root ERROR node
    // (seen on query-router.ts:593). tree-sitter does NOT throw on this — it
    // returns a degraded tree with no class scopes and control-flow false
    // positives (`if`/`switch` mis-read as methods), so the catch-based
    // fallback below never fires and the broken extraction is shipped.
    //
    // When the parse reports errors, run the regex extractor too and prefer it
    // only if it recovers strictly more entities. A clean parse (hasError =
    // false) keeps tree-sitter; a file with a minor recoverable error still
    // keeps tree-sitter unless regex genuinely extracts more (i.e. tree-sitter
    // under-extracted), so the cleaner AST output is preserved in the common
    // case while collapsed parses self-heal to regex.
    if (tree.rootNode.hasError) {
      const regexEntities = extractEntities(content, filePath);
      if (regexEntities.length > tsEntities.length) return regexEntities;
    }
    return tsEntities;
  } catch {
    // Parse failure — fall back to regex
    return extractEntities(content, filePath);
  }
}

/**
 * Walk tree-sitter AST and extract entities based on language-specific node types.
 */
function extractFromAST(
  root: TSNode,
  lines: string[],
  language: Language
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];

  switch (language) {
    case "typescript":
    case "javascript":
      extractTSEntities(root, lines, entities);
      break;
    case "python":
      extractPythonEntities(root, lines, entities);
      break;
    case "go":
      extractGoEntities(root, lines, entities);
      break;
    case "java":
      extractJavaEntities(root, lines, entities);
      break;
    case "rust":
      extractRustEntities(root, lines, entities);
      break;
    case "c":
    case "cpp":
      extractCEntities(root, lines, entities);
      break;
    case "csharp":
      extractCSharpEntities(root, lines, entities);
      break;
    case "ruby":
      extractRubyEntities(root, lines, entities);
      break;
    case "php":
      extractPHPEntities(root, lines, entities);
      break;
    case "kotlin":
      extractKotlinEntities(root, lines, entities);
      break;
    case "swift":
      extractSwiftEntities(root, lines, entities);
      break;
  }

  return entities;
}

/** Compute content hash from line range. */
function hashLines(
  lines: string[],
  startLine: number,
  endLine: number
): string {
  const body = lines.slice(startLine - 1, endLine).join("\n");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** Get signature text from a parameters/formal_parameters node. */
function getSignature(node: TSNode, fieldName: string): string {
  const params = node.childForFieldName(fieldName);
  return params ? params.text : "";
}

/** Find the enclosing class name for a method node. */
function findParentClassName(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "class_definition" ||
      current.type === "class_body"
    ) {
      if (current.type === "class_body" && current.parent) {
        current = current.parent;
        continue;
      }
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── TypeScript/JavaScript extraction ────────────────────────────

/**
 * Test framework primitives recognized for is_test classification. The first
 * dotted segment is matched so `it.only`, `describe.skip`, `test.each(...)`,
 * `bench.only` all qualify. When a call_expression's callee matches, the
 * function-expression arg (the callback body) is extracted as an entity with
 * is_test=true. Top-level helpers in test files (seedEntities, MockEntity)
 * stay is_test=false and stop seeding spurious `tests` edges.
 */
const TEST_PRIMITIVES = new Set([
  "describe",
  "it",
  "test",
  "suite",
  "bench",
  "context",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
  "before",
  "after",
  "fdescribe",
  "fit",
  "xdescribe",
  "xit",
  "xtest",
]);

function extractTSEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "call_expression": {
        // Test-primitive callbacks: it("desc", () => {...}) becomes an entity
        // with is_test=true so resolveTestEdges can wire it to the source
        // entities its calls reach. Pure helpers and fixtures (not inside a
        // test primitive) are NOT marked — that's the whole point of this fix.
        const fnNode = n.childForFieldName("function");
        if (!fnNode) break;
        // First dotted segment — handles `it.only`, `describe.skip`, etc.
        const primitive = fnNode.text.split(".")[0]?.trim();
        if (!primitive || !TEST_PRIMITIVES.has(primitive)) break;

        const argsNode = n.childForFieldName("arguments");
        if (!argsNode) break;

        let description: string | null = null;
        let callback: TSNode | null = null;
        for (const arg of argsNode.namedChildren) {
          if (
            description === null &&
            (arg.type === "string" || arg.type === "template_string")
          ) {
            description = arg.text.replace(/^["'`]|["'`]$/g, "");
          } else if (
            callback === null &&
            (arg.type === "arrow_function" ||
              arg.type === "function_expression" ||
              arg.type === "function")
          ) {
            callback = arg;
          }
        }
        if (!callback) break;

        const startLine = callback.startPosition.row + 1;
        const endLine = callback.endPosition.row + 1;
        const name = description
          ? `${primitive}: ${description}`
          : `${primitive}@L${startLine}`;
        entities.push({
          name,
          kind: "function",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          is_test: true,
        });
        break;
      }
      case "function_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "function",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "class_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "interface_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "method_definition": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findParentClassName(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind: "method",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
      case "lexical_declaration": {
        // const foo = (...) => { ... } or const foo = function(...) { ... }
        // Also: const FOO = { ... }, const BAR = [...], const X = <expr>
        for (const child of n.namedChildren) {
          if (child.type === "variable_declarator") {
            const nameNode = child.childForFieldName("name");
            const valueNode = child.childForFieldName("value");
            if (!nameNode || !valueNode) continue;
            const startLine = n.startPosition.row + 1;
            const endLine = n.endPosition.row + 1;
            if (
              valueNode.type === "arrow_function" ||
              valueNode.type === "function_expression" ||
              valueNode.type === "function"
            ) {
              entities.push({
                name: nameNode.text,
                kind: "function",
                signature: getSignature(valueNode, "parameters"),
                line_start: startLine,
                line_end: endLine,
                content_hash: hashLines(lines, startLine, endLine),
              });
            } else if (
              valueNode.type === "object" ||
              valueNode.type === "array" ||
              valueNode.type === "as_expression" ||
              valueNode.type === "satisfies_expression" ||
              valueNode.type === "new_expression" ||
              valueNode.type === "call_expression" ||
              valueNode.type === "template_string" ||
              valueNode.type === "string" ||
              valueNode.type === "number" ||
              valueNode.type === "true" ||
              valueNode.type === "false" ||
              valueNode.type === "regex"
            ) {
              // Only extract if top-level (not nested inside a function/class body)
              const isTopLevel =
                !n.parent ||
                n.parent.type === "program" ||
                n.parent.type === "export_statement";
              if (isTopLevel) {
                entities.push({
                  name: nameNode.text,
                  kind: "variable",
                  signature: "",
                  line_start: startLine,
                  line_end: endLine,
                  content_hash: hashLines(lines, startLine, endLine),
                });
              }
            }
          }
        }
        break;
      }
      case "type_alias_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "enum_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
    }
  });
}

// ── Python extraction ───────────────────────────────────────────

function extractPythonEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "function_definition": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findPythonParentClass(n);
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        if (className) {
          entities.push({
            name: `${className}.${name.text}`,
            kind: "method",
            signature: getSignature(n, "parameters"),
            line_start: startLine,
            line_end: endLine,
            content_hash: hashLines(lines, startLine, endLine),
            parent_class: className,
          });
        } else {
          entities.push({
            name: name.text,
            kind: "function",
            signature: getSignature(n, "parameters"),
            line_start: startLine,
            line_end: endLine,
            content_hash: hashLines(lines, startLine, endLine),
          });
        }
        break;
      }
      case "class_definition": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
    }
  });
}

function findPythonParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "class_definition") {
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Go extraction ───────────────────────────────────────────────

function extractGoEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "function_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "function",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "method_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        // Go methods: func (r *Type) Name(params)
        const receiver = n.childForFieldName("receiver");
        let className: string | null = null;
        if (receiver) {
          // Extract type from receiver parameter list
          for (const child of receiver.namedChildren) {
            const typeNode = child.childForFieldName("type");
            if (typeNode) {
              className = typeNode.text.replace(/^\*/, "");
              break;
            }
          }
        }
        const entityName = className ? `${className}.${name.text}` : name.text;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind: "method",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
      case "type_declaration": {
        // type Name struct { ... } or type Name interface { ... }
        for (const spec of n.namedChildren) {
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name");
            const typeNode = spec.childForFieldName("type");
            if (!name || !typeNode) continue;
            const kind =
              typeNode.type === "interface_type" ? "interface" : "class";
            const startLine = n.startPosition.row + 1;
            const endLine = n.endPosition.row + 1;
            entities.push({
              name: name.text,
              kind,
              signature: "",
              line_start: startLine,
              line_end: endLine,
              content_hash: hashLines(lines, startLine, endLine),
            });
          }
        }
        break;
      }
    }
  });
}

// ── Java extraction ─────────────────────────────────────────────

function extractJavaEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "class_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "interface_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "method_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findJavaParentClass(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind: "method",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
    }
  });
}

function findJavaParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "interface_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Rust extraction ─────────────────────────────────────────────

/**
 * Check if a node is inside a #[cfg(test)] module by walking up the tree.
 * Detects attribute_item siblings of mod_item ancestors containing "cfg" and "test".
 */
function isInsideCfgTest(node: TSNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "mod_item") {
      let sibling = current.previousSibling;
      while (sibling) {
        if (sibling.type === "attribute_item") {
          const text = sibling.text;
          if (text.includes("cfg") && text.includes("test")) return true;
        } else if (
          sibling.type !== "line_comment" &&
          sibling.type !== "block_comment"
        ) {
          break;
        }
        sibling = sibling.previousSibling;
      }
    }
    current = current.parent;
  }
  return false;
}

function extractRustEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "function_item": {
        const name = n.childForFieldName("name");
        if (!name) return;
        // Check if inside impl block
        const implName = findRustImplName(n);
        const entityName = implName ? `${implName}.${name.text}` : name.text;
        const kind = implName ? "method" : "function";
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        const entity: ExtractedEntity = {
          name: entityName,
          kind,
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: implName ?? undefined,
        };
        if (isInsideCfgTest(n)) entity.is_test = true;
        entities.push(entity);
        break;
      }
      case "struct_item": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        const entity: ExtractedEntity = {
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        };
        if (isInsideCfgTest(n)) entity.is_test = true;
        entities.push(entity);
        break;
      }
      case "trait_item": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        const entity: ExtractedEntity = {
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        };
        if (isInsideCfgTest(n)) entity.is_test = true;
        entities.push(entity);
        break;
      }
      case "impl_item": {
        const name = n.childForFieldName("type");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        const entity: ExtractedEntity = {
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        };
        if (isInsideCfgTest(n)) entity.is_test = true;
        entities.push(entity);
        break;
      }
    }
  });
}

function findRustImplName(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "impl_item") {
      const typeNode = current.childForFieldName("type");
      return typeNode ? typeNode.text : null;
    }
    // Skip declaration_list (impl body)
    current = current.parent;
  }
  return null;
}

// ── C/C++ extraction ────────────────────────────────────────────

function extractCEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "function_definition": {
        const declarator = n.childForFieldName("declarator");
        if (!declarator) return;
        // function_declarator has name and parameters
        const name =
          declarator.type === "function_declarator"
            ? declarator.childForFieldName("declarator")
            : null;
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "function",
          signature: getSignature(declarator, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "struct_specifier": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "class_specifier": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
    }
  });
}

// ── C# extraction ──────────────────────────────────────────────

function extractCSharpEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "class_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "interface_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "struct_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "method_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findCSharpParentClass(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind: "method",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
    }
  });
}

function findCSharpParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "struct_declaration" ||
      current.type === "interface_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Ruby extraction ────────────────────────────────────────────

function extractRubyEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "class": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "module": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "method":
      case "singleton_method": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findRubyParentClass(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const kind = className ? "method" : "function";
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind,
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
    }
  });
}

function findRubyParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "class") {
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── PHP extraction ─────────────────────────────────────────────

function extractPHPEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "class_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "interface_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "trait_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "function_definition": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "function",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "method_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findPHPParentClass(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind: "method",
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
    }
  });
}

function findPHPParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "trait_declaration" ||
      current.type === "interface_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Kotlin extraction ──────────────────────────────────────────

function extractKotlinEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "class_declaration": {
        const name = findFirstIdentifier(n);
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "interface_declaration": {
        const name = findFirstIdentifier(n);
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "object_declaration": {
        const name = findFirstIdentifier(n);
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "function_declaration": {
        const name =
          (n.childForFieldName("name") ?? findFirstIdentifier(n))
            ? { text: findFirstIdentifier(n) }
            : null;
        if (!name?.text) return;
        const className = findKotlinParentClass(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const kind = className ? "method" : "function";
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind,
          signature: getSignature(n, "value_parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
    }
  });
}

/** Find the first simple_identifier child of a node (Kotlin grammars use this instead of "name" field). */
function findFirstIdentifier(node: TSNode): string | null {
  for (const child of node.namedChildren) {
    if (
      child.type === "type_identifier" ||
      child.type === "simple_identifier"
    ) {
      return child.text;
    }
  }
  return null;
}

function findKotlinParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "object_declaration" ||
      current.type === "interface_declaration"
    ) {
      return findFirstIdentifier(current);
    }
    // Skip class_body
    current = current.parent;
  }
  return null;
}

// ── Swift extraction ───────────────────────────────────────────

function extractSwiftEntities(
  node: TSNode,
  lines: string[],
  entities: ExtractedEntity[]
): void {
  walkNodes(node, (n) => {
    switch (n.type) {
      case "class_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "struct_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "protocol_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "interface",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "enum_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: name.text,
          kind: "class",
          signature: "",
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
        });
        break;
      }
      case "function_declaration": {
        const name = n.childForFieldName("name");
        if (!name) return;
        const className = findSwiftParentClass(n);
        const entityName = className ? `${className}.${name.text}` : name.text;
        const kind = className ? "method" : "function";
        const startLine = n.startPosition.row + 1;
        const endLine = n.endPosition.row + 1;
        entities.push({
          name: entityName,
          kind,
          signature: getSignature(n, "parameters"),
          line_start: startLine,
          line_end: endLine,
          content_hash: hashLines(lines, startLine, endLine),
          parent_class: className ?? undefined,
        });
        break;
      }
    }
  });
}

function findSwiftParentClass(node: TSNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "struct_declaration" ||
      current.type === "enum_declaration" ||
      current.type === "protocol_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Edge Extraction (Sprint L2) ───────────────────────────────────

/** Extracted edge from AST analysis (import or call reference). */
export interface ExtractedEdge {
  /** Source entity name or file-level pseudo-key */
  from_name: string;
  /** Target name (imported symbol, called function, extended class) */
  to_name: string;
  /** Edge type: "imports", "calls", "extends", "implements" */
  type: string;
  /** Import source path (for cross-file resolution) */
  import_source?: string;
}

/**
 * Extract edges (imports, calls, extends, implements) from source code using tree-sitter AST.
 * Falls back to regex-based extraction if WASM is unavailable.
 */
export async function extractEdgesAsync(
  content: string,
  filePath: string,
  entities: ExtractedEntity[]
): Promise<ExtractedEdge[]> {
  const language = detectLanguage(filePath);
  if (!language) return [];

  const grammar = resolveGrammar(filePath, language);
  const parser = await getTSParser(grammar);
  if (!parser) {
    return extractEdgesRegex(content, filePath, language);
  }

  try {
    const tree = parser.parse(content);
    return extractEdgesFromAST(tree.rootNode, language, entities);
  } catch {
    return extractEdgesRegex(content, filePath, language);
  }
}

/** Extract edges from tree-sitter AST by language. */
function extractEdgesFromAST(
  root: TSNode,
  language: Language,
  entities: ExtractedEntity[]
): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];

  switch (language) {
    case "typescript":
    case "javascript":
      extractTSEdges(root, edges, entities);
      break;
    case "python":
      extractPythonEdges(root, edges);
      break;
    case "go":
      extractGoEdges(root, edges);
      break;
    case "java":
      extractJavaEdges(root, edges);
      break;
    case "rust":
      extractRustEdges(root, edges);
      break;
    case "csharp":
      extractCSharpEdges(root, edges);
      break;
    case "ruby":
      extractRubyEdges(root, edges);
      break;
    case "php":
      extractPHPEdges(root, edges);
      break;
    case "kotlin":
      extractKotlinEdges(root, edges);
      break;
    case "swift":
      extractSwiftEdges(root, edges);
      break;
    default:
      break;
  }

  return edges;
}

/** TS/JS: extract imports, calls, extends, implements from AST. */
function extractTSEdges(
  root: TSNode,
  edges: ExtractedEdge[],
  entities: ExtractedEntity[]
): void {
  const entityNames = new Set(
    entities.map((e) => e.name.split(".").pop() ?? e.name)
  );

  // Collect imported symbol names so cross-file calls are captured.
  // First pass: gather import names before recording call edges.
  const importedNames = new Set<string>();
  walkNodes(root, (n) => {
    if (n.type === "import_statement") {
      for (const child of n.namedChildren) {
        if (child.type === "import_clause") {
          for (const spec of child.namedChildren) {
            if (spec.type === "named_imports") {
              for (const s of spec.namedChildren) {
                if (s.type === "import_specifier") {
                  const name = s.childForFieldName("name");
                  if (name) importedNames.add(name.text);
                }
              }
            } else if (spec.type === "identifier") {
              importedNames.add(spec.text);
            }
          }
        }
      }
    }
    // Dynamic import: const { Foo, Bar } = await import("./module.js")
    // Collect destructured names so downstream call edges are tracked.
    if (n.type === "call_expression") {
      const func = n.childForFieldName("function");
      if (func?.type === "import") {
        const awaitExpr = n.parent;
        const varDecl =
          awaitExpr?.type === "await_expression" ? awaitExpr.parent : null;
        if (varDecl?.type === "variable_declarator") {
          const pattern = varDecl.childForFieldName("name");
          if (pattern?.type === "object_pattern") {
            for (const prop of pattern.namedChildren) {
              if (prop.type === "shorthand_property_identifier_pattern") {
                importedNames.add(prop.text);
              } else if (prop.type === "pair_pattern") {
                const val = prop.childForFieldName("value");
                if (val?.type === "identifier") importedNames.add(val.text);
              }
            }
          } else if (pattern?.type === "identifier") {
            importedNames.add(pattern.text);
          }
        }
      }
    }
  });

  walkNodes(root, (n) => {
    // import { Foo, Bar } from "./module"
    if (n.type === "import_statement") {
      const source = n.childForFieldName("source");
      const importSource = source ? source.text.replace(/['"]/g, "") : "";
      // Named imports
      for (const child of n.namedChildren) {
        if (child.type === "import_clause") {
          for (const spec of child.namedChildren) {
            if (spec.type === "named_imports") {
              for (const s of spec.namedChildren) {
                if (s.type === "import_specifier") {
                  const name = s.childForFieldName("name");
                  if (name) {
                    edges.push({
                      from_name: "__file__",
                      to_name: name.text,
                      type: "imports",
                      import_source: importSource,
                    });
                  }
                }
              }
            } else if (spec.type === "identifier") {
              // Default import
              edges.push({
                from_name: "__file__",
                to_name: spec.text,
                type: "imports",
                import_source: importSource,
              });
            }
          }
        }
      }
    }

    // class Foo extends Bar implements Baz
    if (n.type === "class_declaration") {
      const className = n.childForFieldName("name");
      if (!className) return;
      // Heritage: extends and implements
      for (const child of n.namedChildren) {
        if (child.type === "class_heritage") {
          for (const clause of child.namedChildren) {
            if (clause.type === "extends_clause") {
              for (const val of clause.namedChildren) {
                if (val.type === "identifier") {
                  edges.push({
                    from_name: className.text,
                    to_name: val.text,
                    type: "extends",
                  });
                }
              }
            }
            if (clause.type === "implements_clause") {
              for (const val of clause.namedChildren) {
                if (
                  val.type === "type_identifier" ||
                  val.type === "identifier"
                ) {
                  edges.push({
                    from_name: className.text,
                    to_name: val.text,
                    type: "implements",
                  });
                }
              }
            }
          }
        }
      }
    }

    // Function calls: foo(), bar.baz(), new Foo()
    if (n.type === "call_expression") {
      const func = n.childForFieldName("function");
      if (!func) return;

      // Dynamic import: await import("../intelligence/local-graph.js")
      // Creates a file→file imports edge so get_cross_boundary_links can
      // find connections between modules that use dynamic imports exclusively.
      if (func.type === "import") {
        const argsNode = n.childForFieldName("arguments");
        if (argsNode) {
          const strArg = argsNode.namedChildren.find(
            (c) => c.type === "string"
          );
          if (strArg) {
            const src = strArg.text.replace(/['"]/g, "");
            if (src) {
              edges.push({
                from_name: "__file__",
                to_name: "__dynamic_import__",
                type: "imports",
                import_source: src,
              });
            }
          }
        }
        return;
      }

      let calledName: string | null = null;
      if (func.type === "identifier") {
        calledName = func.text;
      } else if (func.type === "member_expression") {
        const prop = func.childForFieldName("property");
        if (prop) calledName = prop.text;
      }
      if (
        calledName &&
        (entityNames.has(calledName) || importedNames.has(calledName))
      ) {
        const caller = findEnclosingEntity(n, entities);
        edges.push({
          from_name: caller ?? "__file__",
          to_name: calledName,
          type: "calls",
        });
      }
    }

    // new Foo()
    if (n.type === "new_expression") {
      const ctor = n.childForFieldName("constructor");
      if (ctor && ctor.type === "identifier") {
        const caller = findEnclosingEntity(n, entities);
        edges.push({
          from_name: caller ?? "__file__",
          to_name: ctor.text,
          type: "calls",
        });
      }
    }
  });
}

/** Python: extract imports, calls, class inheritance. */
function extractPythonEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    // import foo / from foo import bar
    if (n.type === "import_statement" || n.type === "import_from_statement") {
      const moduleName = n.childForFieldName("module_name");
      const importSource = moduleName ? moduleName.text : "";
      for (const child of n.namedChildren) {
        if (child.type === "dotted_name" && child !== moduleName) {
          edges.push({
            from_name: "__file__",
            to_name: child.text.split(".").pop() ?? child.text,
            type: "imports",
            import_source: importSource,
          });
        }
        if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          if (name) {
            edges.push({
              from_name: "__file__",
              to_name: name.text.split(".").pop() ?? name.text,
              type: "imports",
              import_source: importSource,
            });
          }
        }
      }
    }

    // class Foo(Bar, Baz):
    if (n.type === "class_definition") {
      const name = n.childForFieldName("name");
      const superclasses = n.childForFieldName("superclasses");
      if (name && superclasses) {
        for (const arg of superclasses.namedChildren) {
          if (arg.type === "identifier") {
            edges.push({
              from_name: name.text,
              to_name: arg.text,
              type: "extends",
            });
          }
        }
      }
    }
  });
}

/** Go: extract imports and struct embedding. */
function extractGoEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    if (n.type === "import_declaration") {
      for (const child of n.namedChildren) {
        if (child.type === "import_spec" || child.type === "import_spec_list") {
          const specs =
            child.type === "import_spec_list" ? child.namedChildren : [child];
          for (const spec of specs) {
            if (spec.type === "import_spec") {
              const path = spec.childForFieldName("path");
              if (path) {
                const importPath = path.text.replace(/"/g, "");
                const pkgName = importPath.split("/").pop() ?? importPath;
                edges.push({
                  from_name: "__file__",
                  to_name: pkgName,
                  type: "imports",
                  import_source: importPath,
                });
              }
            }
          }
        }
      }
    }
  });
}

/** Java: extract imports and extends/implements. */
function extractJavaEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    if (n.type === "import_declaration") {
      // import com.example.Foo;
      for (const child of n.namedChildren) {
        if (child.type === "scoped_identifier") {
          const name = child.text.split(".").pop() ?? child.text;
          edges.push({
            from_name: "__file__",
            to_name: name,
            type: "imports",
            import_source: child.text,
          });
        }
      }
    }

    if (n.type === "class_declaration") {
      const name = n.childForFieldName("name");
      const superclass = n.childForFieldName("superclass");
      const interfaces = n.childForFieldName("interfaces");

      if (name && superclass) {
        edges.push({
          from_name: name.text,
          to_name: superclass.text,
          type: "extends",
        });
      }
      if (name && interfaces) {
        for (const iface of interfaces.namedChildren) {
          if (iface.type === "type_identifier" || iface.type === "type_list") {
            const names =
              iface.type === "type_list" ? iface.namedChildren : [iface];
            for (const t of names) {
              edges.push({
                from_name: name.text,
                to_name: t.text,
                type: "implements",
              });
            }
          }
        }
      }
    }
  });
}

/** Rust: extract use statements and trait impls. */
function extractRustEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    if (n.type === "use_declaration") {
      // Extract the full use path for import_source, then leaf names
      const fullPath = extractRustUsePath(n);
      extractRustUseNames(n, edges, fullPath);
    }

    // impl Trait for Type
    if (n.type === "impl_item") {
      const traitNode = n.childForFieldName("trait");
      const typeNode = n.childForFieldName("type");
      if (traitNode && typeNode) {
        edges.push({
          from_name: typeNode.text,
          to_name: traitNode.text,
          type: "implements",
        });
      }
    }
  });
}

// ── New language edge extraction (tree-sitter) ──────────────────

function extractCSharpEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    // using Namespace.Type;
    if (n.type === "using_directive") {
      const name = n.text
        .replace(/^using\s+/, "")
        .replace(/;$/, "")
        .trim();
      const leaf = name.split(".").pop() ?? name;
      edges.push({
        from_name: "__file__",
        to_name: leaf,
        type: "imports",
        import_source: name,
      });
    }
    // class Foo : Bar, IBaz
    if (n.type === "base_list") {
      const parent = n.parent;
      const parentName = parent?.childForFieldName("name");
      if (parentName) {
        for (const child of n.namedChildren) {
          const baseName =
            child.type === "identifier"
              ? child.text
              : child.childForFieldName("name")?.text;
          if (baseName) {
            edges.push({
              from_name: parentName.text,
              to_name: baseName,
              type: "extends",
            });
          }
        }
      }
    }
  });
}

function extractRubyEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    // require "foo" / require_relative "foo"
    if (n.type === "call" && n.namedChildren.length >= 1) {
      const methodName = n.childForFieldName("method");
      if (
        methodName &&
        (methodName.text === "require" ||
          methodName.text === "require_relative")
      ) {
        const args = n.childForFieldName("arguments");
        if (args) {
          for (const arg of args.namedChildren) {
            if (arg.type === "string") {
              const val = arg.text.replace(/^['"]|['"]$/g, "");
              const leaf = val.split("/").pop() ?? val;
              edges.push({
                from_name: "__file__",
                to_name: leaf,
                type: "imports",
                import_source: val,
              });
            }
          }
        }
      }
    }
    // class Foo < Bar
    if (n.type === "class") {
      const name = n.childForFieldName("name");
      const superclass = n.childForFieldName("superclass");
      if (name && superclass) {
        edges.push({
          from_name: name.text,
          to_name: superclass.text,
          type: "extends",
        });
      }
    }
  });
}

function extractPHPEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    // use Namespace\Class;
    if (n.type === "namespace_use_declaration") {
      for (const clause of n.namedChildren) {
        if (clause.type === "namespace_use_clause") {
          const name = clause.text;
          const leaf = name.split("\\").pop() ?? name;
          edges.push({
            from_name: "__file__",
            to_name: leaf,
            type: "imports",
            import_source: name,
          });
        }
      }
    }
    // class Foo extends Bar implements Baz
    if (n.type === "class_declaration") {
      const name = n.childForFieldName("name");
      if (!name) return;
      const baseClause = n.childForFieldName("base_clause");
      if (baseClause) {
        for (const child of baseClause.namedChildren) {
          if (child.type === "name" || child.type === "qualified_name") {
            edges.push({
              from_name: name.text,
              to_name: child.text,
              type: "extends",
            });
          }
        }
      }
      const interfaces = n.childForFieldName("interfaces");
      if (interfaces) {
        for (const child of interfaces.namedChildren) {
          if (child.type === "name" || child.type === "qualified_name") {
            edges.push({
              from_name: name.text,
              to_name: child.text,
              type: "implements",
            });
          }
        }
      }
    }
  });
}

function extractKotlinEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    // import foo.bar.Baz
    if (n.type === "import_header") {
      const path = n.text.replace(/^import\s+/, "").trim();
      const leaf = path.split(".").pop() ?? path;
      if (leaf !== "*") {
        edges.push({
          from_name: "__file__",
          to_name: leaf,
          type: "imports",
          import_source: path,
        });
      }
    }
    // class Foo : Bar, Baz
    if (n.type === "class_declaration" || n.type === "object_declaration") {
      const name = findFirstIdentifier(n);
      if (!name) return;
      const delegation = n.namedChildren.find(
        (c) =>
          c.type === "delegation_specifier" ||
          c.type === "delegation_specifiers"
      );
      if (delegation) {
        for (const child of delegation.namedChildren) {
          const typeName = child.text.split("(")[0]?.trim();
          if (typeName) {
            edges.push({ from_name: name, to_name: typeName, type: "extends" });
          }
        }
      }
    }
  });
}

function extractSwiftEdges(root: TSNode, edges: ExtractedEdge[]): void {
  walkNodes(root, (n) => {
    // import Foundation
    if (n.type === "import_declaration") {
      const path = n.text.replace(/^import\s+/, "").trim();
      const leaf = path.split(".").pop() ?? path;
      edges.push({
        from_name: "__file__",
        to_name: leaf,
        type: "imports",
        import_source: path,
      });
    }
    // class Foo: Bar, Baz — inheritance_specifier
    if (
      n.type === "class_declaration" ||
      n.type === "struct_declaration" ||
      n.type === "enum_declaration"
    ) {
      const name = n.childForFieldName("name");
      if (!name) return;
      for (const child of n.namedChildren) {
        if (child.type === "type_inheritance_clause") {
          for (const inherited of child.namedChildren) {
            const typeName = inherited.text.trim();
            if (typeName) {
              edges.push({
                from_name: name.text,
                to_name: typeName,
                type: "extends",
              });
            }
          }
        }
      }
    }
  });
}

/** Extract the full path from a Rust use declaration (e.g., "crate::module::sub"). */
function extractRustUsePath(node: TSNode): string {
  // The use_declaration's text is like "use crate::foo::bar;" — extract the path portion
  const text = node.text
    .replace(/^use\s+/, "")
    .replace(/;$/, "")
    .trim();
  // Remove any trailing ::{...} or ::* for the base path
  const braceIdx = text.indexOf("::{");
  if (braceIdx >= 0) return text.slice(0, braceIdx);
  const starIdx = text.indexOf("::*");
  if (starIdx >= 0) return text.slice(0, starIdx);
  // For "use crate::foo::Bar" → base is "crate::foo"
  const lastSep = text.lastIndexOf("::");
  if (lastSep >= 0) return text.slice(0, lastSep);
  return text;
}

function extractRustUseNames(
  node: TSNode,
  edges: ExtractedEdge[],
  importSource: string
): void {
  walkNodes(node, (n) => {
    if (n.type === "identifier" && n.parent?.type === "use_as_clause") {
      edges.push({
        from_name: "__file__",
        to_name: n.text,
        type: "imports",
        import_source: importSource,
      });
    } else if (
      n.type === "identifier" &&
      (n.parent?.type === "use_declaration" ||
        n.parent?.type === "scoped_identifier" ||
        n.parent?.type === "use_list")
    ) {
      // Only leaf identifiers (no parent scoped_identifier that has this as left side)
      const isLeaf = !n.children.some((c) => c.type === "scoped_identifier");
      if (isLeaf && n.parent?.type !== "scoped_identifier") {
        edges.push({
          from_name: "__file__",
          to_name: n.text,
          type: "imports",
          import_source: importSource,
        });
      }
    }
  });
}

/**
 * Find the enclosing entity (function/method/class) for a given AST node.
 * Returns the entity name or null if at file scope.
 */
function findEnclosingEntity(
  node: TSNode,
  entities: ExtractedEntity[]
): string | null {
  const callLine = node.startPosition.row + 1;
  let best: ExtractedEntity | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const entity of entities) {
    if (callLine >= entity.line_start && callLine <= entity.line_end) {
      const span = entity.line_end - entity.line_start;
      // Prefer the narrowest enclosing entity (method over class)
      if (span < bestSpan) {
        bestSpan = span;
        best = entity;
      }
    }
  }

  return best?.name ?? null;
}

/** Regex-based edge extraction fallback (imports only). */
function extractEdgesRegex(
  content: string,
  _filePath: string,
  language: Language
): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    switch (language) {
      case "typescript":
      case "javascript": {
        // import { Foo, Bar } from "./module"
        const importMatch = line.match(
          /^\s*import\s+(?:(?:type\s+)?{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/
        );
        if (importMatch) {
          const names = importMatch[1] ?? importMatch[2] ?? "";
          const source = importMatch[3] ?? "";
          for (const name of names.split(",")) {
            const trimmed = name
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim();
            if (trimmed) {
              edges.push({
                from_name: "__file__",
                to_name: trimmed,
                type: "imports",
                import_source: source,
              });
            }
          }
        }
        // class Foo extends Bar
        const extendsMatch = line.match(/class\s+(\w+)\s+extends\s+(\w+)/);
        if (extendsMatch?.[1] && extendsMatch[2]) {
          edges.push({
            from_name: extendsMatch[1],
            to_name: extendsMatch[2],
            type: "extends",
          });
        }
        break;
      }
      case "python": {
        const fromImport = line.match(/^\s*from\s+(\S+)\s+import\s+(.+)/);
        if (fromImport?.[1] && fromImport[2]) {
          const pySource = fromImport[1];
          for (const name of fromImport[2].split(",")) {
            const trimmed = name
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim();
            if (trimmed) {
              edges.push({
                from_name: "__file__",
                to_name: trimmed,
                type: "imports",
                import_source: pySource,
              });
            }
          }
        }
        const pyImport = line.match(/^\s*import\s+(\S+)/);
        if (pyImport?.[1] && !line.includes(" from ")) {
          const mod = pyImport[1].replace(/,$/, "");
          edges.push({
            from_name: "__file__",
            to_name: mod.split(".").pop() ?? mod,
            type: "imports",
            import_source: mod,
          });
        }
        break;
      }
      case "go": {
        const goImport = line.match(/^\s*"([^"]+)"/);
        if (goImport?.[1]) {
          const pkg = goImport[1].split("/").pop() ?? goImport[1];
          edges.push({
            from_name: "__file__",
            to_name: pkg,
            type: "imports",
            import_source: goImport[1],
          });
        }
        break;
      }
      case "java": {
        const javaImport = line.match(/^\s*import\s+(?:static\s+)?([^;]+);/);
        if (javaImport?.[1]) {
          const name = javaImport[1].split(".").pop() ?? javaImport[1];
          edges.push({
            from_name: "__file__",
            to_name: name,
            type: "imports",
            import_source: javaImport[1],
          });
        }
        break;
      }
      case "rust": {
        const useMatch = line.match(/^\s*use\s+([^;]+);/);
        if (useMatch?.[1]) {
          const path = useMatch[1];
          const name = path.split("::").pop() ?? path;
          // Compute base path (everything before last ::)
          const lastSep = path.lastIndexOf("::");
          const rustSource = lastSep >= 0 ? path.slice(0, lastSep) : path;
          if (name !== "*" && name !== "self") {
            edges.push({
              from_name: "__file__",
              to_name: name,
              type: "imports",
              import_source: rustSource,
            });
          }
        }
        break;
      }
      case "csharp": {
        const usingMatch = line.match(/^\s*using\s+(?:static\s+)?([^;=]+);/);
        if (usingMatch?.[1]) {
          const ns = usingMatch[1].trim();
          const leaf = ns.split(".").pop() ?? ns;
          edges.push({
            from_name: "__file__",
            to_name: leaf,
            type: "imports",
            import_source: ns,
          });
        }
        const csExtends = line.match(/class\s+(\w+)\s*:\s*(\w+)/);
        if (csExtends?.[1] && csExtends[2]) {
          edges.push({
            from_name: csExtends[1],
            to_name: csExtends[2],
            type: "extends",
          });
        }
        break;
      }
      case "ruby": {
        const reqMatch = line.match(
          /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/
        );
        if (reqMatch?.[1]) {
          const mod = reqMatch[1];
          const leaf = mod.split("/").pop() ?? mod;
          edges.push({
            from_name: "__file__",
            to_name: leaf,
            type: "imports",
            import_source: mod,
          });
        }
        const rbExtends = line.match(/class\s+(\w+)\s*<\s*(\w+)/);
        if (rbExtends?.[1] && rbExtends[2]) {
          edges.push({
            from_name: rbExtends[1],
            to_name: rbExtends[2],
            type: "extends",
          });
        }
        break;
      }
      case "php": {
        const phpUse = line.match(/^\s*use\s+([^;]+);/);
        if (phpUse?.[1]) {
          const ns = phpUse[1].trim();
          const leaf = ns.split("\\").pop() ?? ns;
          edges.push({
            from_name: "__file__",
            to_name: leaf,
            type: "imports",
            import_source: ns,
          });
        }
        const phpExtends = line.match(/class\s+(\w+)\s+extends\s+(\w+)/);
        if (phpExtends?.[1] && phpExtends[2]) {
          edges.push({
            from_name: phpExtends[1],
            to_name: phpExtends[2],
            type: "extends",
          });
        }
        const phpImpl = line.match(
          /class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+(.+?)(?:\s*\{|$)/
        );
        if (phpImpl?.[1] && phpImpl[2]) {
          for (const iface of phpImpl[2].split(",")) {
            const trimmed = iface.trim();
            if (trimmed)
              edges.push({
                from_name: phpImpl[1],
                to_name: trimmed,
                type: "implements",
              });
          }
        }
        break;
      }
      case "kotlin": {
        const ktImport = line.match(/^\s*import\s+(\S+)/);
        if (ktImport?.[1]) {
          const path = ktImport[1];
          const leaf = path.split(".").pop() ?? path;
          if (leaf !== "*") {
            edges.push({
              from_name: "__file__",
              to_name: leaf,
              type: "imports",
              import_source: path,
            });
          }
        }
        const ktExtends = line.match(
          /class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(\w+)/
        );
        if (ktExtends?.[1] && ktExtends[2]) {
          edges.push({
            from_name: ktExtends[1],
            to_name: ktExtends[2],
            type: "extends",
          });
        }
        break;
      }
      case "swift": {
        const swImport = line.match(/^\s*import\s+(\S+)/);
        if (swImport?.[1]) {
          const mod = swImport[1];
          edges.push({
            from_name: "__file__",
            to_name: mod,
            type: "imports",
            import_source: mod,
          });
        }
        const swExtends = line.match(
          /(?:class|struct|enum)\s+(\w+)\s*:\s*(\w+)/
        );
        if (swExtends?.[1] && swExtends[2]) {
          edges.push({
            from_name: swExtends[1],
            to_name: swExtends[2],
            type: "extends",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return edges;
}

// ── AST walker utility ──────────────────────────────────────────

/** Depth-first walk of tree-sitter AST, calling visitor on each node. */
function walkNodes(node: TSNode, visitor: (n: TSNode) => void): void {
  visitor(node);
  for (const child of node.children) {
    walkNodes(child, visitor);
  }
}
