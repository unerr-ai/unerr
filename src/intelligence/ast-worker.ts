/**
 * Tinypool worker entry point for parallel AST entity extraction.
 *
 * Runs in a worker thread — must not import native main-thread-only modules.
 * Receives file path + content, returns extracted entities.
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

type ExtractFn = (content: string, filePath: string) => ExtractedEntity[];

let _extractEntities: ExtractFn | null = null;

async function loadExtractor(): Promise<ExtractFn> {
  if (_extractEntities) return _extractEntities;

  try {
    const mod = await import("./ast-extractor.js");
    _extractEntities = mod.extractEntities;
  } catch {
    // @ts-expect-error .ts import used as runtime fallback in non-compiled environments
    const mod = await import("./ast-extractor.ts");
    _extractEntities = mod.extractEntities;
  }
  return _extractEntities!;
}

export default async function parse(
  input: WorkerInput
): Promise<ExtractedEntity[]> {
  try {
    const extractEntities = await loadExtractor();
    return extractEntities(input.content, input.filePath);
  } catch {
    return [];
  }
}
