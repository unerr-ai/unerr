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
  toRef: string
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
  filePath: string
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
 * Every path git tracks in the work tree (`git ls-files`). The full-repo
 * reviewer (`unerr review --all`) uses this to enumerate the whole source tree
 * instead of a git diff slice — each tracked file is reviewed as if freshly
 * added. Returns `[]` on any git error.
 */
export async function listTrackedFiles(cwd: string): Promise<string[]> {
  try {
    const git = getGit(cwd);
    const out = await git.raw(["ls-files"]);
    return out
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A staged path plus its index status. `kind` is normalised to the
 *  review ChangeKind vocabulary (added | modified | deleted); renames and
 *  copies are reported as `modified` on their destination path. */
export interface StagedFileStatus {
  path: string;
  kind: "added" | "modified" | "deleted";
}

/**
 * Staged files with their index status (for the commit-gate reviewer).
 * Parses `git diff --cached --name-status` so each path carries whether it
 * was added, modified, or deleted — the reviewer needs this to pick the right
 * change kind (added files have no HEAD content; deleted files have no staged
 * content). Renames (`R…`) / copies (`C…`) report the destination path as
 * `modified`. Returns `[]` on any git error.
 */
export async function getStagedFileStatuses(
  cwd: string
): Promise<StagedFileStatus[]> {
  try {
    const git = getGit(cwd);
    const out = await git.diff([
      "--cached",
      "--name-status",
      "--diff-filter=ACMRD",
    ]);
    const rows: StagedFileStatus[] = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split("\t");
      const code = parts[0]?.[0] ?? "";
      // Rename/copy lines carry `old\tnew`; the destination is the last field.
      const path = parts[parts.length - 1]?.trim();
      if (!path) continue;
      const kind =
        code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      rows.push({ path, kind });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Content of a path's STAGED (index) blob — what `git commit` would record.
 * Returns null when the path is not in the index (e.g. a deletion) or on error.
 */
export async function getStagedContent(
  cwd: string,
  filePath: string
): Promise<string | null> {
  try {
    return await getGit(cwd).show([`:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Content of a path's committed (HEAD) blob — the pre-edit baseline.
 * Returns null when the path does not exist at HEAD (e.g. a new file) or on error.
 */
export async function getHeadContent(
  cwd: string,
  filePath: string
): Promise<string | null> {
  try {
    return await getGit(cwd).show([`HEAD:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Files changed between two refs (`<from>..<to>`), with their status — for the
 * on-demand range reviewer (`unerr review --range A..B`). Same `--name-status`
 * parse + `ChangeKind` normalisation as {@link getStagedFileStatuses}; renames
 * (`R…`) / copies (`C…`) report the destination path as `modified`. Returns
 * `[]` on any git error (e.g. an unknown ref) so the caller degrades to silent.
 */
export async function getRangeFileStatuses(
  cwd: string,
  from: string,
  to: string
): Promise<StagedFileStatus[]> {
  try {
    const git = getGit(cwd);
    const out = await git.diff([
      "--name-status",
      "--diff-filter=ACMRD",
      `${from}..${to}`,
    ]);
    const rows: StagedFileStatus[] = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split("\t");
      const code = parts[0]?.[0] ?? "";
      // Rename/copy lines carry `old\tnew`; the destination is the last field.
      const path = parts[parts.length - 1]?.trim();
      if (!path) continue;
      const kind =
        code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      rows.push({ path, kind });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Content of a path's blob at an arbitrary ref (`git show <ref>:<path>`) — the
 * range reviewer's per-side content fetch (`from` = pre, `to` = post). Returns
 * null when the path does not exist at that ref (e.g. a file added in the range
 * has no blob at `from`) or on any error. {@link getHeadContent} is the
 * `ref:"HEAD"` special case kept for the commit gate's hot path.
 */
export async function getContentAtRef(
  cwd: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  try {
    return await getGit(cwd).show([`${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Get recent commit log entries.
 */
export async function getLog(
  cwd: string,
  maxCount = 5
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
  content: string
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
  commitSha: string
): Promise<string | null> {
  try {
    const git = getGit(cwd);
    return await git.raw(["notes", "--ref", ref, "show", commitSha]);
  } catch {
    return null;
  }
}

export type { SimpleGit };
