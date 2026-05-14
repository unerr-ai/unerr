/**
 * Centralized Git Utility — simple-git based.
 *
 * Provides a single factory for creating git instances and typed helpers
 * for common operations used throughout the codebase.
 *
 * Design notes (temporal intelligence foundation):
 *   - Git log queries return structured data for bi-temporal edge construction.
 *   - Blame/history helpers enable "when did this fact become true?" queries.
 *   - Instance caching avoids re-initialization overhead on hot paths.
 */

import { type SimpleGit, type SimpleGitOptions, simpleGit } from "simple-git";

const instanceCache = new Map<string, SimpleGit>();

/**
 * Get a simple-git instance for a working directory.
 * Instances are cached per cwd to avoid repeated initialization.
 */
export function getGit(cwd: string): SimpleGit {
  const cached = instanceCache.get(cwd);
  if (cached) return cached;

  const opts: Partial<SimpleGitOptions> = {
    baseDir: cwd,
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: true,
  };

  const instance = simpleGit(opts);
  instanceCache.set(cwd, instance);
  return instance;
}

/**
 * Clear the instance cache (for testing or after cwd changes).
 */
export function clearGitCache(): void {
  instanceCache.clear();
}

/**
 * Check if a directory is inside a git work tree.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const git = getGit(cwd);
    await git.revparse(["--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit SHA.
 */
export async function getHeadSha(cwd: string): Promise<string | null> {
  try {
    const git = getGit(cwd);
    return await git.revparse(["HEAD"]);
  } catch {
    return null;
  }
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const git = getGit(cwd);
    return await git.revparse(["--abbrev-ref", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * Get the remote origin URL.
 */
export async function getRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const git = getGit(cwd);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    return origin?.refs.fetch ?? null;
  } catch {
    return null;
  }
}

/**
 * Get files changed between two refs.
 */
export async function getChangedFiles(
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  try {
    const git = getGit(cwd);
    const diff = await git.diff(["--name-only", `${fromRef}..${toRef}`]);
    return diff
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Restore a file to a specific ref's version.
 */
export async function checkoutFile(
  cwd: string,
  ref: string,
  filePath: string,
): Promise<void> {
  const git = getGit(cwd);
  await git.checkout([ref, "--", filePath]);
}

/**
 * Get staged file names (for pre-commit hooks).
 */
export async function getStagedFiles(cwd: string): Promise<string[]> {
  try {
    const git = getGit(cwd);
    const diff = await git.diff([
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
    ]);
    return diff
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get recent commit log entries.
 */
export async function getLog(
  cwd: string,
  maxCount = 5,
): Promise<
  Array<{ hash: string; date: string; message: string; author_name: string }>
> {
  try {
    const git = getGit(cwd);
    const log = await git.log({ maxCount });
    return log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author_name: entry.author_name,
    }));
  } catch {
    return [];
  }
}

/**
 * List local branches.
 */
export async function listBranches(cwd: string): Promise<string[]> {
  try {
    const git = getGit(cwd);
    const summary = await git.branchLocal();
    return summary.all;
  } catch {
    return [];
  }
}

/**
 * Write a git note under a custom ref namespace.
 */
export async function writeNote(
  cwd: string,
  ref: string,
  commitSha: string,
  content: string,
): Promise<void> {
  const git = getGit(cwd);
  await git.raw(["notes", "--ref", ref, "add", "-f", "-m", content, commitSha]);
}

/**
 * Read a git note from a custom ref namespace. Returns null if no note exists.
 */
export async function readNote(
  cwd: string,
  ref: string,
  commitSha: string,
): Promise<string | null> {
  try {
    const git = getGit(cwd);
    return await git.raw(["notes", "--ref", ref, "show", commitSha]);
  } catch {
    return null;
  }
}

export type { SimpleGit };
