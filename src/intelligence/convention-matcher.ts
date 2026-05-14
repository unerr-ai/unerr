/**
 * Sprint 3.2: Local Convention Pattern Matching — structural checks without LLM.
 *
 * Three convention types evaluated locally:
 * 1. Naming conventions — regex patterns from CozoDB `patterns` table
 * 2. File structure conventions — expected sibling files (e.g., *.test.ts)
 * 3. Import direction conventions — forbidden dependency directions
 *
 * All checks complete in <5ms per file.
 *
 * Design authority: PHASE_CLI_ENHANCEMENT §3.2
 */

import type { CozoGraphStore, LocalEntity } from "./local-graph.js";

/** A single convention violation. */
export interface ConventionViolation {
  type: "naming" | "file_structure" | "import_direction";
  severity: "warn" | "error";
  entity?: string;
  file: string;
  message: string;
  suggestion?: string;
}

/** Naming convention definition derived from patterns table. */
export interface NamingConvention {
  kind: string;
  pattern: RegExp;
  name: string;
  message: string;
}

/** File structure convention (expected sibling patterns). */
export interface FileStructureConvention {
  /** Glob pattern for source files, e.g., "**\/*.ts" */
  sourceGlob: string;
  /** Expected sibling suffix, e.g., ".test.ts" */
  siblingSuffix: string;
  name: string;
  message: string;
}

/** Import direction convention (forbidden dependency direction). */
export interface ImportDirectionConvention {
  /** Source layer (files matching this path fragment cannot import from target) */
  fromLayer: string;
  /** Target layer (forbidden import target) */
  toLayer: string;
  name: string;
  message: string;
}

/** Default naming conventions derived from common TypeScript patterns. */
const DEFAULT_NAMING_CONVENTIONS: NamingConvention[] = [
  {
    kind: "class",
    pattern: /^[A-Z][a-zA-Z0-9]*$/,
    name: "PascalCase classes",
    message: "Class names must be PascalCase",
  },
  {
    kind: "function",
    pattern: /^[a-z_][a-zA-Z0-9]*$/,
    name: "camelCase functions",
    message: "Function names must be camelCase or snake_case",
  },
  {
    kind: "interface",
    pattern: /^[A-Z][a-zA-Z0-9]*$/,
    name: "PascalCase interfaces",
    message: "Interface names must be PascalCase",
  },
];

/** Default file structure conventions. */
const DEFAULT_FILE_STRUCTURE_CONVENTIONS: FileStructureConvention[] = [
  {
    sourceGlob: "src/**/*.ts",
    siblingSuffix: ".test.ts",
    name: "Test file sibling",
    message: "Source files should have a corresponding .test.ts file",
  },
];

/** Default import direction conventions. */
const DEFAULT_IMPORT_DIRECTION_CONVENTIONS: ImportDirectionConvention[] = [
  {
    fromLayer: "/services/",
    toLayer: "/controllers/",
    name: "Services cannot import controllers",
    message: "Service layer should not depend on controller layer",
  },
  {
    fromLayer: "/utils/",
    toLayer: "/services/",
    name: "Utils cannot import services",
    message: "Utility layer should not depend on service layer",
  },
];

/**
 * Check naming conventions against entities in a file.
 */
export function checkNamingConventions(
  entities: LocalEntity[],
  conventions?: NamingConvention[],
): ConventionViolation[] {
  const rules = conventions ?? DEFAULT_NAMING_CONVENTIONS;
  const violations: ConventionViolation[] = [];

  for (const entity of entities) {
    for (const rule of rules) {
      if (entity.kind === rule.kind && !rule.pattern.test(entity.name)) {
        violations.push({
          type: "naming",
          severity: "warn",
          entity: entity.key,
          file: entity.file_path,
          message: `${rule.message}: "${entity.name}"`,
          suggestion: `Rename to match ${rule.pattern.source}`,
        });
      }
    }
  }

  return violations;
}

/**
 * Check file structure conventions (sibling file existence).
 * Uses the graph's file index to check for expected sibling files.
 */
export async function checkFileStructure(
  filePath: string,
  graph: CozoGraphStore,
  conventions?: FileStructureConvention[],
): Promise<ConventionViolation[]> {
  const rules = conventions ?? DEFAULT_FILE_STRUCTURE_CONVENTIONS;
  const violations: ConventionViolation[] = [];

  for (const rule of rules) {
    // Check if file matches source glob (simple suffix check for performance)
    const sourceExt = rule.sourceGlob.split("*").pop() ?? "";
    if (!filePath.endsWith(sourceExt)) continue;

    // Skip if this IS a test/sibling file
    if (filePath.endsWith(rule.siblingSuffix)) continue;

    // Check for expected sibling
    const basePath = filePath.slice(0, -sourceExt.length);
    const expectedSibling = basePath + rule.siblingSuffix;
    const siblingEntities = await graph.getEntitiesByFile(expectedSibling);

    if (siblingEntities.length === 0) {
      violations.push({
        type: "file_structure",
        severity: "warn",
        file: filePath,
        message: `${rule.message}: missing ${expectedSibling}`,
        suggestion: `Create ${expectedSibling}`,
      });
    }
  }

  return violations;
}

/**
 * Check import direction conventions.
 * Uses the graph's import data to detect forbidden dependency directions.
 */
export async function checkImportDirection(
  filePath: string,
  graph: CozoGraphStore,
  conventions?: ImportDirectionConvention[],
): Promise<ConventionViolation[]> {
  const rules = conventions ?? DEFAULT_IMPORT_DIRECTION_CONVENTIONS;
  const violations: ConventionViolation[] = [];

  for (const rule of rules) {
    // Only check files in the source layer
    if (!filePath.includes(rule.fromLayer)) continue;

    // Get imports for this file
    const imports = await graph.getImports(filePath);
    for (const imp of imports) {
      const importPath = imp.imported_file;
      if (importPath?.includes(rule.toLayer)) {
        violations.push({
          type: "import_direction",
          severity: "error",
          file: filePath,
          message: `${rule.message}: ${filePath} imports from ${importPath}`,
          suggestion:
            "Move shared logic to a common layer or invert the dependency",
        });
      }
    }
  }

  return violations;
}

/**
 * Run all convention checks for a file. <5ms per file.
 */
export async function matchConventions(
  filePath: string,
  graph: CozoGraphStore,
  options?: {
    namingConventions?: NamingConvention[];
    fileStructureConventions?: FileStructureConvention[];
    importDirectionConventions?: ImportDirectionConvention[];
  },
): Promise<ConventionViolation[]> {
  const entities = await graph.getEntitiesByFile(filePath);
  const violations: ConventionViolation[] = [];

  violations.push(
    ...checkNamingConventions(entities, options?.namingConventions),
  );
  violations.push(
    ...(await checkFileStructure(
      filePath,
      graph,
      options?.fileStructureConventions,
    )),
  );
  violations.push(
    ...(await checkImportDirection(
      filePath,
      graph,
      options?.importDirectionConventions,
    )),
  );

  return violations;
}

/** Map naming style keywords to regex patterns. */
const NAMING_STYLE_REGEX: Record<string, RegExp> = {
  camelcase: /^[a-z][a-zA-Z0-9]*$/,
  pascalcase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  screaming_snake: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
  kebab: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
};

/** Resolve regex from a pattern name like "camelCase functions" or "PascalCase classes". */
function resolveNamingRegex(patternName: string): RegExp | null {
  const lower = patternName.toLowerCase();
  for (const [key, regex] of Object.entries(NAMING_STYLE_REGEX)) {
    if (lower.includes(key)) return regex;
  }
  // Try partial matches: "pascal" → PascalCase, "camel" → camelCase
  if (lower.includes("pascal")) return NAMING_STYLE_REGEX.pascalcase ?? null;
  if (lower.includes("camel")) return NAMING_STYLE_REGEX.camelcase ?? null;
  if (lower.includes("snake") && lower.includes("scream"))
    return NAMING_STYLE_REGEX.screaming_snake ?? null;
  if (lower.includes("snake")) return NAMING_STYLE_REGEX.snake_case ?? null;
  if (lower.includes("kebab")) return NAMING_STYLE_REGEX.kebab ?? null;
  return null;
}

/**
 * Derive naming conventions from CozoDB patterns table.
 * Converts pattern entries with kind="naming" into regex-based naming checks,
 * mapping pattern names to the correct regex (camelCase, PascalCase, snake_case, etc.).
 */
export async function deriveNamingConventionsFromPatterns(
  graph: CozoGraphStore,
): Promise<NamingConvention[]> {
  const patterns = await graph.getPatterns();
  const conventions: NamingConvention[] = [];

  for (const p of patterns) {
    if (p.kind === "naming" && p.confidence >= 0.7) {
      // Extract entity kind (class, function, interface, etc.)
      const kindMatch = p.name.match(
        /\b(class|function|interface|method|variable|type|enum|constant)\b/i,
      );
      if (!kindMatch) continue;

      // Resolve the correct regex from the pattern name
      const regex = resolveNamingRegex(p.name);
      if (!regex) continue;

      conventions.push({
        kind: kindMatch[1]!.toLowerCase(),
        pattern: regex,
        name: p.name,
        message: `Convention: ${p.name} (${Math.round(p.confidence * 100)}% confidence, ${p.frequency} occurrences)`,
      });
    }
  }

  return conventions.length > 0 ? conventions : DEFAULT_NAMING_CONVENTIONS;
}
