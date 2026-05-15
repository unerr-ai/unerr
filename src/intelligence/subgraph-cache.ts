/**
 * Pre-emptive Subgraph Cache — preloads 1-hop neighbors on first directory access.
 *
 * S.3: When an agent first queries a file in a directory, pre-warm the cache
 * with intelligence for all sibling files in that directory. This eliminates
 * latency on subsequent queries within the same module.
 */

export interface CachedFileIntelligence {
  filePath: string;
  cachedAt: number;
  data: unknown;
}

export interface SubgraphCache {
  get: (filePath: string) => CachedFileIntelligence | null;
  warmDirectory: (
    dirPath: string,
    files: string[],
    loader: (filePath: string) => unknown
  ) => void;
  has: (filePath: string) => boolean;
  invalidate: (filePath: string) => void;
  invalidateDirectory: (dirPath: string) => void;
  size: () => number;
  clear: () => void;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
/** RC-5: Maximum tracked directories before eviction. */
const MAX_DIRECTORIES = 200;

export function createSubgraphCache(): SubgraphCache {
  const cache = new Map<string, CachedFileIntelligence>();
  const directoriesWarmed = new Set<string>();

  function get(filePath: string): CachedFileIntelligence | null {
    const entry = cache.get(filePath);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > TTL_MS) {
      cache.delete(filePath);
      return null;
    }
    return entry;
  }

  function warmDirectory(
    dirPath: string,
    files: string[],
    loader: (filePath: string) => unknown
  ): void {
    if (directoriesWarmed.has(dirPath)) return;
    directoriesWarmed.add(dirPath);
    // RC-5: Evict oldest directories if set exceeds limit
    if (directoriesWarmed.size > MAX_DIRECTORIES) {
      const iter = directoriesWarmed.values();
      for (let i = 0; i < 50; i++) {
        const v = iter.next().value;
        if (v !== undefined) directoriesWarmed.delete(v);
      }
    }

    for (const file of files.slice(0, 20)) {
      if (cache.has(file)) continue;
      if (cache.size >= MAX_ENTRIES) break;

      try {
        const data = loader(file);
        cache.set(file, { filePath: file, cachedAt: Date.now(), data });
      } catch {
        /* skip failed loads */
      }
    }
  }

  function has(filePath: string): boolean {
    const entry = cache.get(filePath);
    if (!entry) return false;
    if (Date.now() - entry.cachedAt > TTL_MS) {
      cache.delete(filePath);
      return false;
    }
    return true;
  }

  function invalidate(filePath: string): void {
    cache.delete(filePath);
  }

  function invalidateDirectory(dirPath: string): void {
    directoriesWarmed.delete(dirPath);
    for (const [key] of cache) {
      if (key.startsWith(dirPath)) cache.delete(key);
    }
  }

  function size(): number {
    return cache.size;
  }

  function clear(): void {
    cache.clear();
    directoriesWarmed.clear();
  }

  return {
    get,
    warmDirectory,
    has,
    invalidate,
    invalidateDirectory,
    size,
    clear,
  };
}
