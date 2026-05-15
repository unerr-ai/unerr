/**
 * Sprint L6.1: Local Convention Pattern Detector
 *
 * Analyzes locally-indexed CozoDB entities to detect coding conventions:
 *   1. Naming conventions — regex analysis of entity names by kind
 *   2. File structure patterns — single-kind directories, barrel exports
 *   3. Import direction patterns — leaf modules (imported but never import outside)
 *
 * All detection is STRUCTURAL (regex + graph topology). Zero LLM calls.
 * Performance target: <500ms for 10K entities.
 *
 * Produces CompactPattern[] compatible with CozoDB `patterns` relation
 * and CozoGraphStore.loadPatterns().
 */

import { dirname } from "node:path";
import { isTestFile } from "./indexer/test-detector.js";
import type { CompactPattern } from "./local-graph.js";

// ── Types ────────────────────────────────────────────────────────

export interface DetectedConvention {
  key: string;
  name: string;
  kind: string; // "naming" | "structure" | "import_direction"
  frequency: number;
  confidence: number;
  exemplarKeys: string[];
  detail: string;
}

export interface ConventionDetectionResult {
  patterns: CompactPattern[];
  conventions: DetectedConvention[];
  stats: {
    naming: number;
    structure: number;
    importDirection: number;
    totalEntities: number;
    elapsedMs: number;
  };
}

/** Minimal entity shape needed for detection (avoids coupling to full LocalEntity). */
interface DetectorEntity {
  key: string;
  kind: string;
  name: string;
  file_path: string;
}

/** Minimal edge shape needed for import direction detection. */
interface DetectorEdge {
  from_key: string;
  to_key: string;
  type: string;
}

/** Minimal community shape for import direction analysis. */
interface DetectorCommunity {
  id: number;
  label: string;
  size: number;
}

// ── Naming Pattern Regexes ──────────────────────────────────────

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface NamingPattern {
  id: string;
  name: string;
  regex: RegExp;
  description: string;
}

const NAMING_PATTERNS: NamingPattern[] = [
  {
    id: "camelCase",
    name: "camelCase",
    regex: CAMEL_CASE,
    description: "camelCase naming",
  },
  {
    id: "PascalCase",
    name: "PascalCase",
    regex: PASCAL_CASE,
    description: "PascalCase naming",
  },
  {
    id: "snake_case",
    name: "snake_case",
    regex: SNAKE_CASE,
    description: "snake_case naming",
  },
  {
    id: "SCREAMING_SNAKE",
    name: "SCREAMING_SNAKE_CASE",
    regex: SCREAMING_SNAKE,
    description: "SCREAMING_SNAKE_CASE naming",
  },
  {
    id: "kebab-case",
    name: "kebab-case",
    regex: KEBAB_CASE,
    description: "kebab-case naming",
  },
];

/** Minimum entities of a kind to consider a convention meaningful. */
const MIN_SAMPLE_SIZE = 3;

/** Minimum adherence ratio to consider a naming pattern a convention. */
const MIN_ADHERENCE = 0.6;

/** Maximum exemplar keys to store per pattern. */
const MAX_EXEMPLARS = 5;

// ── CozoDB Query Interface ──────────────────────────────────────

/**
 * Minimal CozoDB interface for convention detection.
 * Avoids tight coupling to CozoGraphStore class.
 */
export interface ConventionDetectorDB {
  run(
    query: string,
    params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }>;
}

// ── Main Detection Function ─────────────────────────────────────

/**
 * Detect local conventions from the populated CozoDB graph.
 *
 * Queries entities and edges directly via Datalog for maximum performance.
 * Does NOT require getAllEntities/getAllEdges methods on CozoGraphStore.
 */
export async function detectLocalConventions(
  db: ConventionDetectorDB
): Promise<ConventionDetectionResult> {
  const start = Date.now();

  // Query all entities
  const entities = await queryAllEntities(db);
  // Query all edges
  const edges = await queryAllEdges(db);
  // Query communities
  const communities = await queryAllCommunities(db);

  const conventions: DetectedConvention[] = [];

  // 1. Naming conventions
  const namingConventions = detectNamingConventions(entities);
  conventions.push(...namingConventions);

  // 2. File structure patterns
  const structureConventions = detectFileStructurePatterns(entities);
  conventions.push(...structureConventions);

  // 3. Import direction patterns
  const importConventions = detectImportDirectionPatterns(
    entities,
    edges,
    communities
  );
  conventions.push(...importConventions);

  // Convert to CompactPattern[] for CozoDB
  const patterns: CompactPattern[] = conventions.map((c) => ({
    key: c.key,
    name: c.name,
    kind: c.kind,
    frequency: c.frequency,
    confidence: c.confidence,
    exemplar_keys: c.exemplarKeys,
    promoted_rule_key: `local-rule-${c.key}`,
  }));

  const elapsedMs = Date.now() - start;

  return {
    patterns,
    conventions,
    stats: {
      naming: namingConventions.length,
      structure: structureConventions.length,
      importDirection: importConventions.length,
      totalEntities: entities.length,
      elapsedMs,
    },
  };
}

// ── CozoDB Queries ──────────────────────────────────────────────

async function queryAllEntities(
  db: ConventionDetectorDB
): Promise<DetectorEntity[]> {
  try {
    const result = await db.run(
      "?[key, kind, name, file_path] := *entities{key, kind, name, file_path}"
    );
    if (!result?.rows) return [];
    return result.rows.map((row) => {
      const [key, kind, name, file_path] = row as [
        string,
        string,
        string,
        string,
      ];
      return { key, kind, name, file_path };
    });
  } catch {
    return [];
  }
}

async function queryAllEdges(
  db: ConventionDetectorDB
): Promise<DetectorEdge[]> {
  try {
    const result = await db.run(
      "?[from_key, to_key, type] := *edges{from_key, to_key, type}"
    );
    if (!result?.rows) return [];
    return result.rows.map((row) => {
      const [from_key, to_key, type] = row as [string, string, string];
      return { from_key, to_key, type };
    });
  } catch {
    return [];
  }
}

async function queryAllCommunities(
  db: ConventionDetectorDB
): Promise<DetectorCommunity[]> {
  try {
    const result = await db.run(
      "?[id, label, size] := *communities{id, label, size}"
    );
    if (!result?.rows) return [];
    return result.rows.map((row) => {
      const [id, label, size] = row as [number, string, number];
      return { id, label, size };
    });
  } catch {
    return [];
  }
}

// ── 1. Naming Convention Detection ──────────────────────────────

function pluralizeKind(kind: string): string {
  if (kind === "class") return "classes";
  if (kind.endsWith("s") || kind.endsWith("x") || kind.endsWith("z")) {
    return `${kind}es`;
  }
  return `${kind}s`;
}

function detectNamingConventions(
  entities: DetectorEntity[]
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];

  // Group entities by kind
  const byKind = new Map<string, DetectorEntity[]>();
  for (const e of entities) {
    const existing = byKind.get(e.kind);
    if (existing) {
      existing.push(e);
    } else {
      byKind.set(e.kind, [e]);
    }
  }

  for (const [kind, kindEntities] of byKind) {
    if (kindEntities.length < MIN_SAMPLE_SIZE) continue;

    // Test each naming pattern against this kind's entities
    for (const pattern of NAMING_PATTERNS) {
      const matching = kindEntities.filter((e) => pattern.regex.test(e.name));
      const adherence = matching.length / kindEntities.length;

      if (adherence >= MIN_ADHERENCE) {
        const exemplars = matching.slice(0, MAX_EXEMPLARS).map((e) => e.key);
        const kindPlural = pluralizeKind(kind);

        conventions.push({
          key: `naming-${kind}-${pattern.id}`,
          name: `${pattern.name} ${kindPlural}`,
          kind: "naming",
          frequency: matching.length,
          confidence: adherence,
          exemplarKeys: exemplars,
          detail: `${matching.length}/${kindEntities.length} ${kindPlural} use ${pattern.name} (${Math.round(adherence * 100)}%)`,
        });
      }
    }

    // Special: React component detection (PascalCase functions in .tsx files)
    if (kind === "function") {
      const tsxFunctions = kindEntities.filter((e) =>
        e.file_path.endsWith(".tsx")
      );
      if (tsxFunctions.length >= MIN_SAMPLE_SIZE) {
        const pascalTsx = tsxFunctions.filter((e) => PASCAL_CASE.test(e.name));
        const adherence = pascalTsx.length / tsxFunctions.length;
        if (adherence >= MIN_ADHERENCE) {
          conventions.push({
            key: "naming-component-PascalCase",
            name: "PascalCase React components",
            kind: "naming",
            frequency: pascalTsx.length,
            confidence: adherence,
            exemplarKeys: pascalTsx.slice(0, MAX_EXEMPLARS).map((e) => e.key),
            detail: `${pascalTsx.length}/${tsxFunctions.length} .tsx functions use PascalCase (${Math.round(adherence * 100)}%)`,
          });
        }
      }
    }
  }

  return conventions;
}

// ── 2. File Structure Pattern Detection ─────────────────────────

function detectFileStructurePatterns(
  entities: DetectorEntity[]
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];

  // Group entities by directory
  const byDir = new Map<string, DetectorEntity[]>();
  for (const e of entities) {
    const dir = dirname(e.file_path);
    const existing = byDir.get(dir);
    if (existing) {
      existing.push(e);
    } else {
      byDir.set(dir, [e]);
    }
  }

  // Detect single-kind directories (all entities in dir are same kind)
  const singleKindDirs: string[] = [];
  for (const [dir, dirEntities] of byDir) {
    if (dirEntities.length < MIN_SAMPLE_SIZE) continue;

    const kinds = new Set(dirEntities.map((e) => e.kind));
    if (kinds.size === 1) {
      const kind = [...kinds][0] as string;
      singleKindDirs.push(dir);
      conventions.push({
        key: `structure-single-kind-${sanitizeKey(dir)}`,
        name: `${dir}/ contains only ${kind}s`,
        kind: "structure",
        frequency: dirEntities.length,
        confidence: 1.0,
        exemplarKeys: dirEntities.slice(0, MAX_EXEMPLARS).map((e) => e.key),
        detail: `All ${dirEntities.length} entities in ${dir}/ are ${kind}s`,
      });
    }
  }

  // Detect barrel export pattern (index.ts files that re-export)
  const indexFiles = entities.filter(
    (e) =>
      e.file_path.endsWith("/index.ts") ||
      e.file_path.endsWith("/index.js") ||
      e.file_path === "index.ts" ||
      e.file_path === "index.js"
  );
  if (indexFiles.length >= MIN_SAMPLE_SIZE) {
    // Count directories that have index files
    const dirsWithIndex = new Set(indexFiles.map((e) => dirname(e.file_path)));
    const totalDirs = new Set(entities.map((e) => dirname(e.file_path))).size;

    if (totalDirs > 0) {
      const adherence = dirsWithIndex.size / totalDirs;
      if (adherence >= 0.3) {
        // 30% threshold for barrel pattern
        conventions.push({
          key: "structure-barrel-exports",
          name: "Barrel export pattern (index.ts)",
          kind: "structure",
          frequency: indexFiles.length,
          confidence: adherence,
          exemplarKeys: indexFiles.slice(0, MAX_EXEMPLARS).map((e) => e.key),
          detail: `${dirsWithIndex.size}/${totalDirs} directories use barrel exports (${Math.round(adherence * 100)}%)`,
        });
      }
    }
  }

  // Detect test file co-location pattern
  const sourceFiles = new Set<string>();
  const testFiles = new Set<string>();
  for (const e of entities) {
    if (isTestFile(e.file_path)) {
      testFiles.add(e.file_path);
    } else {
      sourceFiles.add(e.file_path);
    }
  }

  if (testFiles.size >= MIN_SAMPLE_SIZE) {
    // Check if tests are co-located (same directory) or segregated (__tests__/)
    const segregatedTests = [...testFiles].filter((f) =>
      f.includes("__tests__/")
    );
    const colocatedTests = [...testFiles].filter(
      (f) => !f.includes("__tests__/")
    );

    if (segregatedTests.length > colocatedTests.length) {
      conventions.push({
        key: "structure-test-segregated",
        name: "Tests in __tests__/ directories",
        kind: "structure",
        frequency: segregatedTests.length,
        confidence: segregatedTests.length / testFiles.size,
        exemplarKeys: [],
        detail: `${segregatedTests.length}/${testFiles.size} test files use __tests__/ pattern`,
      });
    } else if (colocatedTests.length > 0) {
      conventions.push({
        key: "structure-test-colocated",
        name: "Co-located test files (.test.ts sibling)",
        kind: "structure",
        frequency: colocatedTests.length,
        confidence: colocatedTests.length / testFiles.size,
        exemplarKeys: [],
        detail: `${colocatedTests.length}/${testFiles.size} test files are co-located with source`,
      });
    }
  }

  // Roll up single-kind directories into a convention if there are enough
  if (singleKindDirs.length >= 2) {
    conventions.push({
      key: "structure-single-kind-dirs",
      name: "Single-purpose directories",
      kind: "structure",
      frequency: singleKindDirs.length,
      confidence: singleKindDirs.length / byDir.size,
      exemplarKeys: [],
      detail: `${singleKindDirs.length}/${byDir.size} directories contain only one entity kind`,
    });
  }

  return conventions;
}

// ── 3. Import Direction Pattern Detection ───────────────────────

function detectImportDirectionPatterns(
  entities: DetectorEntity[],
  edges: DetectorEdge[],
  communities: DetectorCommunity[]
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];

  if (communities.length === 0 || edges.length === 0) return conventions;

  // Build entity → community mapping from CozoDB
  const entityCommunity = new Map<string, number>();
  for (const e of entities) {
    // Community is assigned during community detection and stored in entities
    // We query it separately for efficiency
  }

  // Query entity community assignments
  const importEdges = edges.filter((e) => e.type === "imports");
  if (importEdges.length === 0) return conventions;

  // Build file → community mapping (approximate: use entity file_path grouping)
  const fileEntities = new Map<string, string[]>();
  for (const e of entities) {
    const existing = fileEntities.get(e.file_path);
    if (existing) {
      existing.push(e.key);
    } else {
      fileEntities.set(e.file_path, [e.key]);
    }
  }

  // Track inbound and outbound imports per file directory (layer proxy)
  const dirImports = new Map<string, { inbound: number; outbound: number }>();
  for (const edge of importEdges) {
    // Find file paths for from_key and to_key
    const fromEntity = entities.find((e) => e.key === edge.from_key);
    const toEntity = entities.find((e) => e.key === edge.to_key);
    if (!fromEntity || !toEntity) continue;

    const fromDir = dirname(fromEntity.file_path);
    const toDir = dirname(toEntity.file_path);

    if (fromDir === toDir) continue; // Skip intra-directory imports

    // Count outbound from fromDir
    const fromStats = dirImports.get(fromDir) ?? { inbound: 0, outbound: 0 };
    fromStats.outbound++;
    dirImports.set(fromDir, fromStats);

    // Count inbound to toDir
    const toStats = dirImports.get(toDir) ?? { inbound: 0, outbound: 0 };
    toStats.inbound++;
    dirImports.set(toDir, toStats);
  }

  // Detect leaf modules (imported by others but never import outside)
  for (const [dir, stats] of dirImports) {
    if (stats.inbound > 0 && stats.outbound === 0) {
      conventions.push({
        key: `import-direction-leaf-${sanitizeKey(dir)}`,
        name: `${dir}/ is a leaf module`,
        kind: "import_direction",
        frequency: stats.inbound,
        confidence: 1.0,
        exemplarKeys: [],
        detail: `${dir}/ is imported ${stats.inbound} times but imports nothing outside itself`,
      });
    }
  }

  // Detect layered architecture (some dirs only import "downward")
  // A layer is identified when a dir has many outbound imports to specific target dirs
  const layerPairs = new Map<string, number>();
  for (const edge of importEdges) {
    const fromEntity = entities.find((e) => e.key === edge.from_key);
    const toEntity = entities.find((e) => e.key === edge.to_key);
    if (!fromEntity || !toEntity) continue;

    const fromDir = dirname(fromEntity.file_path);
    const toDir = dirname(toEntity.file_path);
    if (fromDir === toDir) continue;

    const pairKey = `${fromDir}->${toDir}`;
    layerPairs.set(pairKey, (layerPairs.get(pairKey) ?? 0) + 1);
  }

  // Find one-directional layer pairs (A imports B but B never imports A)
  const unidirectionalPairs: Array<{
    from: string;
    to: string;
    count: number;
  }> = [];
  for (const [pair, count] of layerPairs) {
    if (count < MIN_SAMPLE_SIZE) continue;
    const [fromDir, toDir] = pair.split("->") as [string, string];
    const reversePair = `${toDir}->${fromDir}`;
    if (!layerPairs.has(reversePair)) {
      unidirectionalPairs.push({ from: fromDir, to: toDir, count });
    }
  }

  if (unidirectionalPairs.length >= 2) {
    conventions.push({
      key: "import-direction-layered-architecture",
      name: "Layered architecture (unidirectional imports)",
      kind: "import_direction",
      frequency: unidirectionalPairs.length,
      confidence: unidirectionalPairs.length / Math.max(layerPairs.size, 1),
      exemplarKeys: [],
      detail: `${unidirectionalPairs.length} directory pairs have unidirectional import relationships`,
    });
  }

  return conventions;
}

// ── Utilities ───────────────────────────────────────────────────

/** Sanitize a directory path for use as a CozoDB key. */
function sanitizeKey(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
