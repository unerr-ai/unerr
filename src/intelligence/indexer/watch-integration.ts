/**
 * File Watcher Integration — connects @parcel/watcher events to the
 * incremental indexing pipeline.
 *
 * Receives file change events from the native watcher (Sprint B.4),
 * triggers targeted re-indexing, and applies graph patches.
 */

import path from "node:path";
import type { WatchEvent } from "../../tracking/native-watcher.js";
import { createModuleLogger } from "../../utils/logger.js";

const log = createModuleLogger("watch-integration");

export type WatchReindexCallback = (filePaths: string[]) => Promise<void>;

/** Extensions that the indexer can process — mirrors local-indexer.ts INDEXABLE_EXTENSIONS. */
const INDEXABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
]);

/**
 * Filter watch events to only indexable source files.
 * Ignores non-source files, build artifacts, and lockfiles.
 */
export function filterIndexableEvents(events: WatchEvent[]): string[] {
  const paths = new Set<string>();

  for (const event of events) {
    if (event.type === "delete") {
      paths.add(event.path);
      continue;
    }

    const ext = path.extname(event.path).toLowerCase();
    if (INDEXABLE_EXTENSIONS.has(ext)) {
      paths.add(event.path);
    }
  }

  return [...paths];
}

/**
 * Create a watcher callback that triggers incremental reindexing.
 */
export function createWatchReindexHook(
  onReindex: WatchReindexCallback
): (events: WatchEvent[]) => void {
  return (events: WatchEvent[]) => {
    const indexable = filterIndexableEvents(events);
    if (indexable.length === 0) return;

    log.debug(`Reindexing ${indexable.length} files from watch events`);

    onReindex(indexable).catch((err) => {
      log.warn(
        `Watch-triggered reindex failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  };
}
