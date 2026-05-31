/**
 * Tinypool worker entry point for parallel AST entity extraction.
 *
 * Runs in a worker thread — must not import native main-thread-only modules.
 * Receives file path + content, returns extracted entities.
 *
 * Uses the tree-sitter extractor (`extractEntitiesAsync`) so the parallel
 * full-index path produces the same AST-accurate entities (class scopes,
 * dotted `Class.method` names, no control-flow/template false positives) as
 * the single-file incremental path (`reindexFile`). `extractEntitiesAsync`
 * itself falls back to regex extraction when WASM is unavailable or a parse
 * throws, so robustness is preserved. web-tree-sitter is WASM (not a native
 * main-thread-only module) and each worker lazily inits + caches its own
 * parser on first file.
 *
 * Uses dynamic import with fallback to handle both production (.js) and
 * development (.ts) environments since worker threads don't inherit
 * TypeScript loaders.
 */

import type { ExtractedEntity } from "./ast-extractor.js";

export interface WorkerInput {
  filePath: string;
  content: string;
}

type ExtractFn = (
  content: string,
  filePath: string
) => Promise<ExtractedEntity[]>;

let _extractEntities: ExtractFn | null = null;

async function loadExtractor(): Promise<ExtractFn> {
  if (_extractEntities) return _extractEntities;

  try {
    const mod = await import("./ast-extractor.js");
    _extractEntities = mod.extractEntitiesAsync;
  } catch {
    // @ts-expect-error .ts import used as runtime fallback in non-compiled environments
    const mod = await import("./ast-extractor.ts");
    _extractEntities = mod.extractEntitiesAsync;
  }
  return _extractEntities!;
}

export default async function parse(
  input: WorkerInput
): Promise<ExtractedEntity[]> {
  try {
    const extractEntities = await loadExtractor();
    return await extractEntities(input.content, input.filePath);
  } catch {
    return [];
  }
}
