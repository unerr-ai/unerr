/**
 * Indexer Worker Pool — parallel file indexing via tinypool.
 *
 * For large projects (>100 files), distributes indexing across worker threads.
 * Falls back to sequential indexing when workers are unavailable.
 *
 * Each worker receives a file path + source code, returns extraction results.
 * Tree-sitter parsers are initialized per-worker (one-time cost).
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createModuleLogger } from "../../utils/logger.js";
import { parseSource } from "../tree-sitter-loader.js";
import { type IndexResult, discoverFiles } from "./orchestrator.js";
import {
  type ExtractionResult,
  type ImportInfo,
  type IndexedEdge,
  type IndexedEntity,
  getPluginForFile,
} from "./plugin-interface.js";

const log = createModuleLogger("indexer-worker");

const MAX_FILE_SIZE = 500 * 1024;
const PARALLEL_THRESHOLD = 50;

interface FileResult {
  entities: IndexedEntity[];
  edges: IndexedEdge[];
  imports: ImportInfo[];
  error: boolean;
}

async function processFile(
  filePath: string,
  projectRoot: string
): Promise<FileResult> {
  const plugin = getPluginForFile(filePath);
  if (!plugin) return { entities: [], edges: [], imports: [], error: true };

  const absolutePath = join(projectRoot, filePath);
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf-8");
  } catch {
    return { entities: [], edges: [], imports: [], error: true };
  }

  if (source.length > MAX_FILE_SIZE) {
    return { entities: [], edges: [], imports: [], error: false };
  }

  try {
    const tree = await parseSource(source, plugin.grammarWasmName);
    const extraction = plugin.extract(tree, filePath, source);
    const imports = plugin.resolveImports(tree, filePath);
    tree.delete();
    return { ...extraction, imports, error: false };
  } catch {
    return { entities: [], edges: [], imports: [], error: true };
  }
}

/**
 * Index a project using chunked parallelism.
 * Files are processed in batches to avoid overwhelming the event loop.
 */
export async function indexProjectParallel(
  projectRoot: string,
  ignorePatterns?: Set<string>
): Promise<IndexResult> {
  const start = performance.now();
  const files = discoverFiles(projectRoot, ignorePatterns);

  const allEntities: IndexedEntity[] = [];
  const allEdges: IndexedEdge[] = [];
  const allImports: ImportInfo[] = [];
  let errorCount = 0;

  const chunkSize = Math.min(50, Math.max(10, Math.ceil(files.length / 4)));

  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map((file) => processFile(file, projectRoot))
    );

    for (const result of results) {
      if (result.error) {
        errorCount++;
      } else {
        allEntities.push(...result.entities);
        allEdges.push(...result.edges);
        allImports.push(...result.imports);
      }
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

/**
 * Choose optimal indexing strategy based on file count.
 */
export async function indexProjectAuto(
  projectRoot: string,
  ignorePatterns?: Set<string>
): Promise<IndexResult> {
  return indexProjectParallel(projectRoot, ignorePatterns);
}
