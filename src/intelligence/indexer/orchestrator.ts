/**
 * Indexer Orchestrator — file discovery → plugin dispatch → results merge.
 *
 * Discovers source files, selects the appropriate language plugin, parses
 * via tree-sitter, extracts entities + edges, and returns the merged result.
 *
 * Supports both single-file and batch-file indexing.
 * Worker pool integration is optional (see worker.ts).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { createModuleLogger } from "../../utils/logger.js";
import { parseSource } from "../tree-sitter-loader.js";
import {
  type ExtractionResult,
  type ImportInfo,
  type IndexedEdge,
  type IndexedEntity,
  getPluginForFile,
} from "./plugin-interface.js";

const log = createModuleLogger("indexer");

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".unerr",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".venv",
  "vendor",
]);

/**
 * Path-prefix exclusions (relative to projectRoot). Used in addition to
 * the basename-only DEFAULT_IGNORE check above to handle agent worktrees
 * precisely without over-matching user-named `worktrees/` folders.
 */
const EXCLUDED_PATH_PREFIXES = [
  ".claude/worktrees",
  ".cursor/worktrees",
  ".idea/worktrees",
];

function isExcludedPath(relPath: string): boolean {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

const MAX_FILE_SIZE = 500 * 1024;

export interface IndexResult {
  entities: IndexedEntity[];
  edges: IndexedEdge[];
  imports: ImportInfo[];
  fileCount: number;
  errorCount: number;
  durationMs: number;
}

export interface IndexOptions {
  projectRoot: string;
  maxFileSize?: number;
  ignorePatterns?: Set<string>;
}

/**
 * Discover all indexable source files in a project.
 */
export function discoverFiles(
  projectRoot: string,
  ignorePatterns = DEFAULT_IGNORE
): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") continue;
      if (ignorePatterns.has(entry)) continue;

      const fullPath = join(dir, entry);
      // Path-aware exclusion (e.g. `.claude/worktrees/`).
      if (isExcludedPath(relative(projectRoot, fullPath))) continue;

      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const plugin = getPluginForFile(fullPath);
        if (plugin && stat.size <= MAX_FILE_SIZE) {
          files.push(relative(projectRoot, fullPath));
        }
      }
    }
  }

  walk(projectRoot);
  return files;
}

/**
 * Index a single file. Returns extraction results.
 */
export async function indexFile(
  filePath: string,
  projectRoot: string
): Promise<{ extraction: ExtractionResult; imports: ImportInfo[] } | null> {
  const plugin = getPluginForFile(filePath);
  if (!plugin) return null;

  const absolutePath = filePath.startsWith("/")
    ? filePath
    : join(projectRoot, filePath);

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }

  if (source.length > MAX_FILE_SIZE) return null;

  try {
    const tree = await parseSource(source, plugin.grammarWasmName);
    const relativePath = filePath.startsWith("/")
      ? relative(projectRoot, filePath)
      : filePath;
    const extraction = plugin.extract(tree, relativePath, source);
    const imports = plugin.resolveImports(tree, relativePath);
    tree.delete();
    return { extraction, imports };
  } catch (err) {
    log.debug(
      `Failed to index ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Index all files in a project. Returns merged results.
 */
export async function indexProject(
  options: IndexOptions
): Promise<IndexResult> {
  const start = performance.now();
  const { projectRoot, ignorePatterns } = options;

  const files = discoverFiles(projectRoot, ignorePatterns ?? DEFAULT_IGNORE);

  const allEntities: IndexedEntity[] = [];
  const allEdges: IndexedEdge[] = [];
  const allImports: ImportInfo[] = [];
  let errorCount = 0;

  for (const file of files) {
    const result = await indexFile(file, projectRoot);
    if (result) {
      allEntities.push(...result.extraction.entities);
      allEdges.push(...result.extraction.edges);
      allImports.push(...result.imports);
    } else {
      errorCount++;
    }
  }

  return {
    entities: allEntities,
    edges: allEdges,
    imports: allImports,
    fileCount: files.length,
    errorCount,
    durationMs: performance.now() - start,
  };
}
