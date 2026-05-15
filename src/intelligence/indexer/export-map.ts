/**
 * Export Map Builder — builds a project-wide lookup of all exported entities.
 *
 * Given per-file extraction results, produces a map from (filePath, symbolName)
 * to entity key. This enables cross-file call resolution: when file A imports
 * `fn` from file B, we look up B's export map to find the entity key for `fn`.
 *
 * Handles:
 *   - Named exports: export function foo() {}
 *   - Default exports: export default class Bar {}
 *   - Re-exports: export { X } from "./other"
 *   - Barrel files: export * from "./module"
 */

import type { ImportInfo, IndexedEntity } from "./plugin-interface.js";

export interface ExportEntry {
  entityKey: string;
  name: string;
  kind: string;
  filePath: string;
  isDefault: boolean;
}

export interface ReExportEntry {
  fromFile: string;
  symbols: string[];
  isNamespace: boolean;
  line: number;
}

export interface ExportMap {
  getExport: (filePath: string, symbolName: string) => ExportEntry | null;
  getDefaultExport: (filePath: string) => ExportEntry | null;
  getAllExports: (filePath: string) => ExportEntry[];
  getReExports: (filePath: string) => ReExportEntry[];
  resolveSymbol: (
    importSource: string,
    symbolName: string,
    importerPath: string
  ) => ExportEntry | null;
}

/**
 * Normalize an import path relative to the importer's directory.
 * Handles: "./foo" → "src/foo", "../utils/bar" → "utils/bar"
 */
function resolveImportPath(
  importSource: string,
  importerFilePath: string
): string | null {
  if (!importSource.startsWith(".")) return null;

  // biome-ignore format: typeof import() must stay single-line for TS
  const { dirname, join, normalize } = require("node:path") as typeof import("node:path");
  const importerDir = dirname(importerFilePath);
  let resolved = normalize(join(importerDir, importSource));

  resolved = resolved.replace(/\\/g, "/");
  if (resolved.startsWith("./")) resolved = resolved.slice(2);

  return resolved;
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

/**
 * Build the export map from per-file extraction results.
 */
export function buildExportMap(
  fileResults: Map<string, { entities: IndexedEntity[]; imports: ImportInfo[] }>
): ExportMap {
  const exports = new Map<string, ExportEntry[]>();
  const reExports = new Map<string, ReExportEntry[]>();

  for (const [filePath, result] of fileResults) {
    const fileExports: ExportEntry[] = [];

    for (const entity of result.entities) {
      if (entity.exported) {
        fileExports.push({
          entityKey: entity.key,
          name: entity.name,
          kind: entity.kind,
          filePath: entity.file_path,
          isDefault: false,
        });
      }
    }

    const fileReExports: ReExportEntry[] = [];
    for (const imp of result.imports) {
      if (imp.source.startsWith(".") && imp.symbols.length > 0) {
        const isReExport = result.entities.some(
          (e) => imp.symbols.includes(e.name) && e.exported
        );
        if (!isReExport) {
          fileReExports.push({
            fromFile: imp.source,
            symbols: imp.symbols,
            isNamespace: imp.isNamespace,
            line: imp.line,
          });
        }
      }
    }

    exports.set(filePath, fileExports);
    if (fileReExports.length > 0) {
      reExports.set(filePath, fileReExports);
    }
  }

  function getExport(filePath: string, symbolName: string): ExportEntry | null {
    const fileExports = exports.get(filePath);
    if (!fileExports) return null;
    return fileExports.find((e) => e.name === symbolName) ?? null;
  }

  function getDefaultExport(filePath: string): ExportEntry | null {
    const fileExports = exports.get(filePath);
    if (!fileExports) return null;
    return fileExports.find((e) => e.isDefault) ?? null;
  }

  function getAllExports(filePath: string): ExportEntry[] {
    return exports.get(filePath) ?? [];
  }

  function getReExports(filePath: string): ReExportEntry[] {
    return reExports.get(filePath) ?? [];
  }

  function resolveSymbol(
    importSource: string,
    symbolName: string,
    importerPath: string
  ): ExportEntry | null {
    const resolvedPath = resolveImportPath(importSource, importerPath);
    if (!resolvedPath) return null;

    const candidates = [
      resolvedPath,
      `${resolvedPath}.ts`,
      `${resolvedPath}.tsx`,
      `${resolvedPath}.js`,
      `${resolvedPath}/index.ts`,
      `${resolvedPath}/index.tsx`,
      `${resolvedPath}/index.js`,
    ];

    for (const candidate of candidates) {
      const stripped = stripExtension(candidate);
      for (const [filePath] of exports) {
        if (stripExtension(filePath) === stripped || filePath === candidate) {
          const found = getExport(filePath, symbolName);
          if (found) return found;

          const fileReExports = reExports.get(filePath) ?? [];
          for (const re of fileReExports) {
            if (re.symbols.includes(symbolName) || re.isNamespace) {
              const reResolved = resolveImportPath(re.fromFile, filePath);
              if (reResolved) {
                const deep = resolveSymbol(re.fromFile, symbolName, filePath);
                if (deep) return deep;
              }
            }
          }
        }
      }
    }

    return null;
  }

  return {
    getExport,
    getDefaultExport,
    getAllExports,
    getReExports,
    resolveSymbol,
  };
}
