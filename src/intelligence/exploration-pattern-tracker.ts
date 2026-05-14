/**
 * Session Context Enhancement — tracks exploration patterns and predicts next queries.
 *
 * S.5: Observes which files/entities the agent queries and uses the pattern
 * to predict what it will need next. Enables pre-warming the subgraph cache.
 */

export interface ExplorationPattern {
  directories: Map<string, number>;
  entities: Map<string, number>;
  recentFiles: string[];
  queryCount: number;
}

export interface SessionContext {
  recordQuery: (filePath: string, entityKey?: string) => void;
  getPattern: () => ExplorationPattern;
  predictNextFiles: (limit?: number) => string[];
  getActiveDirectory: () => string | null;
  reset: () => void;
}

export function createSessionContext(): SessionContext {
  const directories = new Map<string, number>();
  const entities = new Map<string, number>();
  const recentFiles: string[] = [];
  let queryCount = 0;

  function recordQuery(filePath: string, entityKey?: string): void {
    queryCount++;
    recentFiles.push(filePath);
    if (recentFiles.length > 50) recentFiles.shift();

    const dir = filePath.split("/").slice(0, -1).join("/");
    if (dir) directories.set(dir, (directories.get(dir) ?? 0) + 1);
    if (entityKey) entities.set(entityKey, (entities.get(entityKey) ?? 0) + 1);
  }

  function getPattern(): ExplorationPattern {
    return { directories, entities, recentFiles: [...recentFiles], queryCount };
  }

  function predictNextFiles(limit = 5): string[] {
    const activeDir = getActiveDirectory();
    if (!activeDir) return [];

    const dirFiles = recentFiles.filter((f) => f.startsWith(activeDir));
    const unique = [...new Set(dirFiles)];
    return unique.slice(-limit);
  }

  function getActiveDirectory(): string | null {
    if (directories.size === 0) return null;
    const recent = recentFiles.slice(-5);
    const recentDirs = new Map<string, number>();
    for (const f of recent) {
      const dir = f.split("/").slice(0, -1).join("/");
      if (dir) recentDirs.set(dir, (recentDirs.get(dir) ?? 0) + 1);
    }
    if (recentDirs.size === 0) return null;
    return [...recentDirs.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }

  function reset(): void {
    directories.clear();
    entities.clear();
    recentFiles.length = 0;
    queryCount = 0;
  }

  return {
    recordQuery,
    getPattern,
    predictNextFiles,
    getActiveDirectory,
    reset,
  };
}
