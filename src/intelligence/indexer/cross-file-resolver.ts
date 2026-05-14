/**
 * Cross-File Call Resolver — resolves import → entity → calls edges.
 *
 * Given per-file extraction results with unresolved call edges (to_key starts
 * with "unresolved:"), resolves them to actual entity keys using the export map.
 *
 * Also handles:
 *   J.3 — Barrel file / re-export chain resolution
 *   - export { X } from "./other" → follow to original entity
 *   - export * from "./module" → resolve all namespace imports
 */

import { type ExportMap, buildExportMap } from "./export-map.js";
import type { ImportInfo, IndexedEdge } from "./plugin-interface.js";

export interface ResolvedEdge extends IndexedEdge {
  resolved: boolean;
}

export interface CrossFileResult {
  resolvedEdges: IndexedEdge[];
  /** File→file imports edges (deduplicated). */
  fileImportEdges: IndexedEdge[];
  unresolvedCount: number;
  resolvedCount: number;
}

/**
 * Resolve all unresolved cross-file edges using the export map.
 *
 * For each file's edges where to_key starts with "unresolved:", look up the
 * callee name in the file's import map, then resolve via the export map.
 */
export function resolveCrossFileEdges(
  fileResults: Map<
    string,
    {
      entities: Array<{
        key: string;
        name: string;
        exported: boolean;
        kind: string;
        file_path: string;
      }>;
      edges: IndexedEdge[];
      imports: ImportInfo[];
    }
  >,
): CrossFileResult {
  const exportMap = buildExportMap(
    fileResults as unknown as Parameters<typeof buildExportMap>[0],
  );

  const allResolvedEdges: IndexedEdge[] = [];
  // R.3: Track file→file import relationships (deduplicated by pair)
  const fileImportPairs = new Set<string>();
  let unresolvedCount = 0;
  let resolvedCount = 0;

  for (const [filePath, result] of fileResults) {
    const importLookup = buildImportLookup(result.imports, filePath);

    const localEntityNames = new Map(
      result.entities.map((e) => [e.name, e.key]),
    );

    // R.3: Emit file→file imports edges from the import declarations directly
    for (const imp of result.imports) {
      if (imp.source && imp.source !== filePath) {
        const pairKey = `${filePath}\0${imp.source}`;
        fileImportPairs.add(pairKey);
      }
    }

    for (const edge of result.edges) {
      if (!edge.to_key.startsWith("unresolved:")) {
        allResolvedEdges.push(edge);
        continue;
      }

      const calleeName = edge.to_key.slice("unresolved:".length);

      const localKey = localEntityNames.get(calleeName);
      if (localKey) {
        allResolvedEdges.push({ ...edge, to_key: localKey });
        resolvedCount++;
        continue;
      }

      const importedFrom = importLookup.get(calleeName);
      if (importedFrom) {
        const resolved = exportMap.resolveSymbol(
          importedFrom.source,
          importedFrom.originalName,
          filePath,
        );
        if (resolved) {
          allResolvedEdges.push({ ...edge, to_key: resolved.entityKey });
          resolvedCount++;
          continue;
        }
      }

      unresolvedCount++;
    }
  }

  // R.3: Build deduplicated file→file import edges
  const fileImportEdges: IndexedEdge[] = Array.from(fileImportPairs, (pair) => {
    const [from, to] = pair.split("\0") as [string, string];
    return {
      from_key: `file:${from}`,
      to_key: `file:${to}`,
      type: "imports" as const,
      file_path: from,
      line: 0,
    };
  });

  return {
    resolvedEdges: allResolvedEdges,
    fileImportEdges,
    unresolvedCount,
    resolvedCount,
  };
}

interface ImportLookupEntry {
  source: string;
  originalName: string;
  isDefault: boolean;
}

function buildImportLookup(
  imports: ImportInfo[],
  filePath: string,
): Map<string, ImportLookupEntry> {
  const lookup = new Map<string, ImportLookupEntry>();

  for (const imp of imports) {
    if (imp.isDefault && imp.localName) {
      lookup.set(imp.localName, {
        source: imp.source,
        originalName: "default",
        isDefault: true,
      });
    }

    if (imp.isNamespace && imp.localName) {
      lookup.set(imp.localName, {
        source: imp.source,
        originalName: "*",
        isDefault: false,
      });
    }

    for (const symbol of imp.symbols) {
      lookup.set(symbol, {
        source: imp.source,
        originalName: symbol,
        isDefault: false,
      });
    }
  }

  return lookup;
}
