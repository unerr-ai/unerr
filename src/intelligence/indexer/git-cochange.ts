/**
 * R.4: Compute file→file co-change edges from git log.
 *
 * Two files that frequently change together in the same commit are likely
 * structurally coupled (even if no import edge exists). This creates
 * "co_changes" edges between file entities in the graph.
 *
 * Algorithm:
 *   1. Read last N commits (default 100)
 *   2. For each commit, extract the list of changed files
 *   3. For each pair of files in the same commit, increment co-occurrence count
 *   4. Normalize by individual file change counts (Jaccard-like)
 *   5. Return top K pairs with highest correlation as edges
 */

import { execSync } from "node:child_process";

export interface CoChangeEdge {
  from_file: string;
  to_file: string;
  /** Number of commits where both files changed together. */
  co_occurrences: number;
  /** Normalized correlation: co_occurrences / min(changes_a, changes_b). */
  correlation: number;
}

/**
 * Compute co-change file pairs from git history.
 *
 * @param projectRoot - Absolute path to the git repo root
 * @param maxCommits - Number of recent commits to analyze (default 100)
 * @param topK - Maximum number of co-change pairs to return (default 20)
 * @param minCoOccurrences - Minimum co-occurrences to include (default 3)
 */
export function computeCoChangeEdges(
  projectRoot: string,
  maxCommits = 100,
  topK = 20,
  minCoOccurrences = 3,
): CoChangeEdge[] {
  const commits = getCommitFileLists(projectRoot, maxCommits);
  if (commits.length === 0) return [];

  // Count individual file changes and pair co-occurrences
  const fileChanges = new Map<string, number>();
  const pairCount = new Map<string, number>();

  for (const files of commits) {
    // Skip very large commits (merges, bulk renames) — they add noise
    if (files.length > 30) continue;

    for (const file of files) {
      fileChanges.set(file, (fileChanges.get(file) ?? 0) + 1);
    }

    // Count co-occurrences for all pairs in this commit
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = pairKey(files[i]!, files[j]!);
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  // Build edges for pairs that meet the threshold
  const edges: CoChangeEdge[] = [];
  for (const [key, count] of pairCount) {
    if (count < minCoOccurrences) continue;
    const [a, b] = key.split("\0") as [string, string];
    const changesA = fileChanges.get(a) ?? 1;
    const changesB = fileChanges.get(b) ?? 1;
    const correlation = count / Math.min(changesA, changesB);
    edges.push({
      from_file: a,
      to_file: b,
      co_occurrences: count,
      correlation,
    });
  }

  // Sort by correlation descending, take top K
  edges.sort((a, b) => b.correlation - a.correlation);
  return edges.slice(0, topK);
}

/** Canonical pair key (sorted to ensure A-B == B-A). */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/**
 * Get file lists per commit from git log.
 * Returns array of arrays, each inner array is the list of changed files in one commit.
 */
function getCommitFileLists(
  projectRoot: string,
  maxCommits: number,
): string[][] {
  let output: string;
  try {
    output = execSync(
      `git log --name-only --pretty=format:"" -n ${maxCommits}`,
      { cwd: projectRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    return [];
  }

  // Split by double newlines (commit boundaries) then filter
  const commits: string[][] = [];
  let currentFiles: string[] = [];

  for (const line of output.split("\n")) {
    if (line === "") {
      if (currentFiles.length > 0) {
        commits.push(currentFiles);
        currentFiles = [];
      }
    } else {
      // Only include source files (skip binary, lockfiles, etc.)
      if (isSourceFile(line)) {
        currentFiles.push(line);
      }
    }
  }
  if (currentFiles.length > 0) {
    commits.push(currentFiles);
  }

  return commits;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".html",
]);

function isSourceFile(path: string): boolean {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return SOURCE_EXTENSIONS.has(path.slice(dotIdx));
}
