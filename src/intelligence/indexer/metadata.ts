/**
 * Index Metadata Persistence — tracks indexing state in .unerr/index/metadata.json.
 *
 * Stores: last index timestamp, file hashes, entity counts per file.
 * Used by incremental indexing to determine which files need re-processing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FileMetadata {
  hash: string;
  entityCount: number;
  lastIndexed: string;
}

export interface IndexMetadata {
  version: number;
  lastFullIndex: string;
  files: Record<string, FileMetadata>;
  totalEntities: number;
  totalEdges: number;
}

const METADATA_VERSION = 1;

function defaultMetadata(): IndexMetadata {
  return {
    version: METADATA_VERSION,
    lastFullIndex: new Date().toISOString(),
    files: {},
    totalEntities: 0,
    totalEdges: 0,
  };
}

export function loadMetadata(unerrDir: string): IndexMetadata {
  const indexDir = join(unerrDir, "index");
  const metaPath = join(indexDir, "metadata.json");

  if (!existsSync(metaPath)) return defaultMetadata();

  try {
    const raw = readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as IndexMetadata;
    if (parsed.version !== METADATA_VERSION) return defaultMetadata();
    return parsed;
  } catch {
    return defaultMetadata();
  }
}

export function saveMetadata(unerrDir: string, metadata: IndexMetadata): void {
  const indexDir = join(unerrDir, "index");
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  const metaPath = join(indexDir, "metadata.json");
  try {
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
  } catch {
    /* best effort */
  }
}

export function updateFileMetadata(
  metadata: IndexMetadata,
  filePath: string,
  hash: string,
  entityCount: number
): void {
  metadata.files[filePath] = {
    hash,
    entityCount,
    lastIndexed: new Date().toISOString(),
  };
}

export function removeFileMetadata(
  metadata: IndexMetadata,
  filePath: string
): void {
  delete metadata.files[filePath];
}

export function fileNeedsReindex(
  metadata: IndexMetadata,
  filePath: string,
  currentHash: string
): boolean {
  const existing = metadata.files[filePath];
  if (!existing) return true;
  return existing.hash !== currentHash;
}
