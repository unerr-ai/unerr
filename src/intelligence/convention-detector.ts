/**
 * Convention Detector — automated detection of naming, structural, and
 * import direction conventions from the codebase graph.
 *
 * O.6: Naming conventions (suffix/prefix patterns)
 * O.7: Structure conventions (file organization)
 * O.8: Import direction conventions (layer violations)
 * O.9: Confidence scoring per convention
 * O.10: Persistence to .unerr/conventions/detected.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexedEdge, IndexedEntity } from "./indexer/plugin-interface.js";

export interface DetectedConvention {
  id: string;
  type: "naming" | "structure" | "import-direction";
  name: string;
  pattern: string;
  examples: string[];
  adherence: number;
  confidence: number;
  entityCount: number;
}

export interface ConventionReport {
  conventions: DetectedConvention[];
  totalEntities: number;
  analyzedAt: string;
}

/**
 * Detect naming conventions (suffix/prefix patterns).
 */
export function detectNamingConventions(
  entities: IndexedEntity[]
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];

  const suffixCounts = new Map<
    string,
    { count: number; kind: string; examples: string[] }
  >();
  const prefixCounts = new Map<
    string,
    { count: number; kind: string; examples: string[] }
  >();

  for (const entity of entities) {
    if (entity.kind === "function" || entity.kind === "method") {
      const prefixes = [
        "get",
        "set",
        "is",
        "has",
        "create",
        "update",
        "delete",
        "fetch",
        "handle",
        "on",
      ];
      for (const prefix of prefixes) {
        if (
          entity.name.startsWith(prefix) &&
          entity.name.length > prefix.length
        ) {
          const entry = prefixCounts.get(prefix) ?? {
            count: 0,
            kind: entity.kind,
            examples: [],
          };
          entry.count++;
          if (entry.examples.length < 3) entry.examples.push(entity.name);
          prefixCounts.set(prefix, entry);
        }
      }
    }

    if (entity.kind === "class" || entity.kind === "interface") {
      const suffixes = [
        "Service",
        "Controller",
        "Repository",
        "Handler",
        "Factory",
        "Provider",
        "Manager",
        "Helper",
        "Util",
      ];
      for (const suffix of suffixes) {
        if (entity.name.endsWith(suffix)) {
          const entry = suffixCounts.get(suffix) ?? {
            count: 0,
            kind: entity.kind,
            examples: [],
          };
          entry.count++;
          if (entry.examples.length < 3) entry.examples.push(entity.name);
          suffixCounts.set(suffix, entry);
        }
      }
    }
  }

  for (const [suffix, data] of suffixCounts) {
    if (data.count >= 3) {
      const totalOfKind = entities.filter((e) => e.kind === data.kind).length;
      const adherence = totalOfKind > 0 ? data.count / totalOfKind : 0;
      conventions.push({
        id: `naming:suffix:${suffix.toLowerCase()}`,
        type: "naming",
        name: `${data.kind}s use "${suffix}" suffix`,
        pattern: `*${suffix}`,
        examples: data.examples,
        adherence: Math.round(adherence * 100) / 100,
        confidence: Math.min(0.95, 0.5 + data.count * 0.05),
        entityCount: data.count,
      });
    }
  }

  for (const [prefix, data] of prefixCounts) {
    if (data.count >= 5) {
      const totalFuncs = entities.filter(
        (e) => e.kind === "function" || e.kind === "method"
      ).length;
      const adherence = totalFuncs > 0 ? data.count / totalFuncs : 0;
      conventions.push({
        id: `naming:prefix:${prefix}`,
        type: "naming",
        name: `Functions use "${prefix}" prefix pattern`,
        pattern: `${prefix}*`,
        examples: data.examples,
        adherence: Math.round(adherence * 100) / 100,
        confidence: Math.min(0.9, 0.4 + data.count * 0.03),
        entityCount: data.count,
      });
    }
  }

  return conventions;
}

/**
 * Detect structural conventions (file organization patterns).
 */
export function detectStructureConventions(
  entities: IndexedEntity[]
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  const dirKinds = new Map<string, Map<string, number>>();

  for (const entity of entities) {
    const parts = entity.file_path.split("/");
    if (parts.length < 2) continue;
    const dir = parts.slice(0, -1).join("/");

    if (!dirKinds.has(dir)) dirKinds.set(dir, new Map());
    const kindMap = dirKinds.get(dir)!;
    kindMap.set(entity.kind, (kindMap.get(entity.kind) ?? 0) + 1);
  }

  const dirPatterns = new Map<string, number>();
  for (const [dir, kinds] of dirKinds) {
    const dominant = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] >= 3) {
      const dirName = dir.split("/").pop() ?? dir;
      const pattern = `${dirName}→${dominant[0]}`;
      dirPatterns.set(pattern, (dirPatterns.get(pattern) ?? 0) + 1);
    }
  }

  for (const [pattern, count] of dirPatterns) {
    if (count >= 2) {
      const [dirName, kind] = pattern.split("→");
      conventions.push({
        id: `structure:${pattern.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        type: "structure",
        name: `"${dirName}" directories contain primarily ${kind}s`,
        pattern,
        examples: [],
        adherence: 0.8,
        confidence: Math.min(0.85, 0.5 + count * 0.1),
        entityCount: count,
      });
    }
  }

  return conventions;
}

/**
 * Detect import direction conventions (layer violations).
 */
export function detectImportDirectionConventions(
  entities: IndexedEntity[],
  edges: IndexedEdge[]
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  const layerOrder = [
    "utils",
    "lib",
    "core",
    "services",
    "api",
    "routes",
    "commands",
    "entrypoints",
  ];

  const importEdges = edges.filter((e) => e.type === "imports");
  let violations = 0;
  let total = 0;

  for (const edge of importEdges) {
    const fromEntity = entities.find((e) => e.key === edge.from_key);
    const toEntity = entities.find((e) => e.key === edge.to_key);
    if (!fromEntity || !toEntity) continue;

    const fromLayer = getLayerIndex(fromEntity.file_path, layerOrder);
    const toLayer = getLayerIndex(toEntity.file_path, layerOrder);

    if (fromLayer >= 0 && toLayer >= 0) {
      total++;
      if (toLayer > fromLayer) violations++;
    }
  }

  if (total >= 5) {
    const adherence = total > 0 ? 1 - violations / total : 1;
    conventions.push({
      id: "import-direction:layer-order",
      type: "import-direction",
      name: "Imports flow from high-level to low-level (no upward deps)",
      pattern: "entrypoints→commands→services→core→utils",
      examples: [],
      adherence: Math.round(adherence * 100) / 100,
      confidence: 0.8,
      entityCount: total,
    });
  }

  return conventions;
}

function getLayerIndex(filePath: string, layers: string[]): number {
  for (let i = 0; i < layers.length; i++) {
    if (filePath.includes(layers[i]!)) return i;
  }
  return -1;
}

/**
 * Run all convention detection and return combined report.
 */
export function detectAllConventions(
  entities: IndexedEntity[],
  edges: IndexedEdge[]
): ConventionReport {
  const naming = detectNamingConventions(entities);
  const structure = detectStructureConventions(entities);
  const imports = detectImportDirectionConventions(entities, edges);

  return {
    conventions: [...naming, ...structure, ...imports]
      .filter((c) => c.confidence >= 0.5)
      .sort((a, b) => b.confidence - a.confidence),
    totalEntities: entities.length,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Persist conventions to .unerr/conventions/detected.json.
 */
export function persistConventions(
  unerrDir: string,
  report: ConventionReport
): void {
  const convDir = join(unerrDir, "conventions");
  if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });
  writeFileSync(
    join(convDir, "detected.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );
}

/**
 * Load persisted conventions.
 */
export function loadConventions(unerrDir: string): ConventionReport | null {
  const path = join(unerrDir, "conventions", "detected.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConventionReport;
  } catch {
    return null;
  }
}
