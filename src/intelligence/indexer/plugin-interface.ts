/**
 * Language Plugin Interface — contract for all language extractors.
 *
 * Each plugin handles one language family and provides:
 *   - Entity extraction from a Tree-sitter AST
 *   - Intra-file edge extraction (contains, calls, extends, implements)
 *   - Import resolution (source path + imported symbols)
 *
 * Plugins are registered in the registry and looked up by file extension.
 */

import type { default as Parser, SyntaxNode, Tree } from "web-tree-sitter";

export type EntityKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace"
  | "module"
  | "property"
  | "constructor"
  | "getter"
  | "setter";

export type EdgeType =
  | "contains"
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "exports"
  | "reads"
  | "writes"
  | "type_of"
  | "returns"
  | "parameter_of"
  | "decorates"
  | "overrides"
  | "re_exports"
  | "co_changes"
  | "tests";

export interface IndexedEntity {
  key: string;
  kind: EntityKind;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  body_hash: string;
  exported: boolean;
  parent_key: string | null;
  language: string;
  is_async: boolean;
  parameter_count: number;
  doc: string | null;
  /** Plugin-level test detection (e.g., Rust #[cfg(test)] scope). Overrides file-level heuristic when true. */
  is_test?: boolean;
}

export interface IndexedEdge {
  from_key: string;
  to_key: string;
  type: EdgeType;
  file_path: string;
  line: number;
}

export interface ExtractionResult {
  entities: IndexedEntity[];
  edges: IndexedEdge[];
}

export interface ImportInfo {
  source: string;
  symbols: string[];
  isDefault: boolean;
  isNamespace: boolean;
  localName?: string;
  line: number;
}

export interface CallSite {
  calleeName: string;
  line: number;
  isAwait: boolean;
}

export interface LanguagePlugin {
  id: string;
  extensions: string[];
  grammarWasmName: string;

  extract(tree: Tree, filePath: string, source: string): ExtractionResult;

  resolveImports(tree: Tree, filePath: string): ImportInfo[];

  detectCalls?(
    bodyNode: SyntaxNode,
    scopeEntities: Map<string, string>
  ): CallSite[];
}

const pluginRegistry = new Map<string, LanguagePlugin>();
const extensionIndex = new Map<string, LanguagePlugin>();

export function registerPlugin(plugin: LanguagePlugin): void {
  pluginRegistry.set(plugin.id, plugin);
  for (const ext of plugin.extensions) {
    extensionIndex.set(ext, plugin);
  }
}

export function getPluginForFile(filePath: string): LanguagePlugin | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot);
  return extensionIndex.get(ext) ?? null;
}

export function getPlugin(id: string): LanguagePlugin | null {
  return pluginRegistry.get(id) ?? null;
}

export function getAllPlugins(): LanguagePlugin[] {
  return [...pluginRegistry.values()];
}
