/**
 * Tier-3 Regex Fallback Plugin — basic entity detection for unsupported languages.
 *
 * Produces file-level entities and basic function/class detection using
 * language-agnostic regex patterns. Lower confidence than tree-sitter,
 * but provides baseline coverage for any text file with code-like structure.
 */

import type { Tree } from "web-tree-sitter";
import { bodyHash, entityKey } from "../entity-key.js";
import type {
  ExtractionResult,
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
  LanguagePlugin,
} from "../plugin-interface.js";

const FUNCTION_PATTERN =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|def|func|fn|fun|sub|proc)\s+(\w+)/gm;
const CLASS_PATTERN =
  /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?(?:class|struct|interface|trait|enum|module|object)\s+(\w+)/gm;

function extractWithRegex(
  source: string,
  filePath: string,
  language: string,
): ExtractionResult {
  const entities: IndexedEntity[] = [];
  const edges: IndexedEdge[] = [];
  const lines = source.split("\n");

  let match: RegExpExecArray | null;

  FUNCTION_PATTERN.lastIndex = 0;
  while ((match = FUNCTION_PATTERN.exec(source)) !== null) {
    const name = match[1]!;
    const lineNum = source.slice(0, match.index).split("\n").length;

    entities.push({
      key: entityKey(filePath, "function", name, ""),
      kind: "function",
      name,
      file_path: filePath,
      start_line: lineNum,
      end_line: lineNum + 5,
      signature: `${name}()`,
      body_hash: bodyHash(match[0]),
      exported: match[0].includes("export"),
      parent_key: null,
      language,
      is_async: match[0].includes("async"),
      parameter_count: 0,
      doc: null,
    });
  }

  CLASS_PATTERN.lastIndex = 0;
  while ((match = CLASS_PATTERN.exec(source)) !== null) {
    const name = match[1]!;
    const lineNum = source.slice(0, match.index).split("\n").length;

    entities.push({
      key: entityKey(filePath, "class", name, ""),
      kind: "class",
      name,
      file_path: filePath,
      start_line: lineNum,
      end_line: lineNum + 10,
      signature: `class ${name}`,
      body_hash: bodyHash(match[0]),
      exported: match[0].includes("export"),
      parent_key: null,
      language,
      is_async: false,
      parameter_count: 0,
      doc: null,
    });
  }

  return { entities, edges };
}

export const regexFallbackPlugin: LanguagePlugin = {
  id: "regex-fallback",
  extensions: [],
  grammarWasmName: "",

  extract(_tree: Tree, filePath: string, source: string): ExtractionResult {
    const ext = filePath.slice(filePath.lastIndexOf(".") + 1);
    return extractWithRegex(source, filePath, ext);
  },

  resolveImports(): ImportInfo[] {
    return [];
  },
};

/**
 * Standalone extraction without tree-sitter (for files with no grammar).
 */
export function regexExtract(
  source: string,
  filePath: string,
): ExtractionResult {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1);
  return extractWithRegex(source, filePath, ext);
}
