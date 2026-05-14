/**
 * Cross-File Edge Repair — when an import target changes, re-resolve edges.
 *
 * After incremental reindex of a changed file, other files that import
 * from it may have stale edge targets. This module identifies affected
 * files and repairs their cross-file edges.
 */

import { createModuleLogger } from "../../utils/logger.js";
import { buildExportMap } from "./export-map.js";
import type {
  ImportInfo,
  IndexedEdge,
  IndexedEntity,
} from "./plugin-interface.js";

const log = createModuleLogger("edge-repair");

export interface RepairResult {
  repairedEdges: number;
  affectedFiles: string[];
}

/**
 * Find files that import from a changed file.
 */
export function findDependentFiles(
  changedFile: string,
  allImports: Map<string, ImportInfo[]>,
): string[] {
  const dependents: string[] = [];
  const changedBase = stripExtension(changedFile);

  for (const [filePath, imports] of allImports) {
    if (filePath === changedFile) continue;

    for (const imp of imports) {
      if (!imp.source.startsWith(".")) continue;

      const { dirname, join, normalize } =
        require("node:path") as typeof import("node:path");
      const importerDir = dirname(filePath);
      let resolved = normalize(join(importerDir, imp.source)).replace(
        /\\/g,
        "/",
      );
      if (resolved.startsWith("./")) resolved = resolved.slice(2);

      if (
        stripExtension(resolved) === changedBase ||
        resolved === changedFile
      ) {
        dependents.push(filePath);
        break;
      }
    }
  }

  return dependents;
}

/**
 * Repair cross-file edges for dependent files after a target file changes.
 */
export function repairCrossFileEdges(
  dependentFiles: string[],
  fileResults: Map<
    string,
    { entities: IndexedEntity[]; edges: IndexedEdge[]; imports: ImportInfo[] }
  >,
): { repairedEdges: IndexedEdge[]; count: number } {
  const exportMap = buildExportMap(
    fileResults as unknown as Parameters<typeof buildExportMap>[0],
  );

  const repairedEdges: IndexedEdge[] = [];
  let count = 0;

  for (const filePath of dependentFiles) {
    const result = fileResults.get(filePath);
    if (!result) continue;

    const importLookup = new Map<
      string,
      { source: string; originalName: string }
    >();
    for (const imp of result.imports) {
      if (imp.isDefault && imp.localName) {
        importLookup.set(imp.localName, {
          source: imp.source,
          originalName: "default",
        });
      }
      for (const symbol of imp.symbols) {
        importLookup.set(symbol, { source: imp.source, originalName: symbol });
      }
    }

    for (const edge of result.edges) {
      if (!edge.to_key.startsWith("unresolved:")) {
        repairedEdges.push(edge);
        continue;
      }

      const calleeName = edge.to_key.slice("unresolved:".length);

      const localKey = result.entities.find((e) => e.name === calleeName)?.key;
      if (localKey) {
        repairedEdges.push({ ...edge, to_key: localKey });
        count++;
        continue;
      }

      const imported = importLookup.get(calleeName);
      if (imported) {
        const resolved = exportMap.resolveSymbol(
          imported.source,
          imported.originalName,
          filePath,
        );
        if (resolved) {
          repairedEdges.push({ ...edge, to_key: resolved.entityKey });
          count++;
          continue;
        }
      }

      repairedEdges.push(edge);
    }
  }

  log.debug(
    `Repaired ${count} cross-file edges in ${dependentFiles.length} files`,
  );
  return { repairedEdges, count };
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}
