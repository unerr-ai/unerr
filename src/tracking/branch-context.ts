/**
 * Branch Context Tracker — computes and maintains branch state.
 *
 * Tracks: current branch, base branch, merge base commit, commits ahead/behind.
 * Updated on proxy startup and on branch switch (detected via .git/HEAD polling).
 *
 * All git operations use the centralized git utility — no stdout pollution.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitQuery } from "../utils/exec.js";

export interface BranchContext {
  /** Current branch name (e.g., "feature/auth") */
  currentBranch: string;
  /** Base branch (from git config or "main" default) */
  baseBranch: string;
  /** Merge base commit SHA */
  baseCommit: string | null;
  /** Number of commits ahead of base */
  commitsAhead: number;
  /** Number of commits behind base (null if no remote) */
  commitsBehind: number | null;
  /** Current HEAD SHA */
  headSha: string;
  /** Timestamp of last computation */
  computedAt: string;
}

/**
 * Compute branch context from git state.
 * Never throws — returns safe defaults on any git failure.
 */
export async function computeBranchContext(
  cwd?: string,
): Promise<BranchContext> {
  const dir = cwd ?? process.cwd();

  const currentBranch =
    (await gitQuery(["branch", "--show-current"], dir)) || "HEAD";
  const headSha = (await gitQuery(["rev-parse", "HEAD"], dir)) || "";

  let baseBranch = "main";
  if (currentBranch && currentBranch !== "HEAD") {
    const configured = await gitQuery(
      ["config", "--get", `branch.${currentBranch}.merge`],
      dir,
    );
    if (configured) {
      baseBranch = configured.replace(/^refs\/heads\//, "");
    } else {
      const mainExists = await gitQuery(
        ["rev-parse", "--verify", "origin/main"],
        dir,
      );
      if (!mainExists) {
        const masterExists = await gitQuery(
          ["rev-parse", "--verify", "origin/master"],
          dir,
        );
        if (masterExists) baseBranch = "master";
      }
    }
  }

  let baseCommit: string | null = null;
  let commitsAhead = 0;
  let commitsBehind: number | null = null;

  const remoteBranch = `origin/${baseBranch}`;
  baseCommit = await gitQuery(["merge-base", "HEAD", remoteBranch], dir);

  if (baseCommit) {
    const ahead = await gitQuery(
      ["rev-list", "--count", `${baseCommit}..HEAD`],
      dir,
    );
    commitsAhead = ahead ? Number.parseInt(ahead, 10) : 0;

    const behind = await gitQuery(
      ["rev-list", "--count", `HEAD..${remoteBranch}`],
      dir,
    );
    commitsBehind = behind ? Number.parseInt(behind, 10) : null;
  }

  return {
    currentBranch,
    baseBranch,
    baseCommit,
    commitsAhead,
    commitsBehind,
    headSha,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Alias retained for call-site compatibility — both versions are now async.
 */
export const computeBranchContextAsync = computeBranchContext;

/**
 * Detect if a branch switch occurred by comparing .git/HEAD content.
 * Returns the new branch name if switched, null otherwise.
 */
export function detectBranchSwitch(
  previousBranch: string,
  cwd?: string,
): string | null {
  const current = getCurrentBranch(cwd);
  if (current && current !== previousBranch) {
    return current;
  }
  return null;
}

/**
 * Get the current branch name by reading .git/HEAD directly (fast, no process spawn).
 */
export function getCurrentBranch(cwd?: string): string | null {
  const gitDir = cwd ? join(cwd, ".git") : join(process.cwd(), ".git");
  const headPath = join(gitDir, "HEAD");

  if (!existsSync(headPath)) return null;

  try {
    const content = readFileSync(headPath, "utf-8").trim();
    // ref: refs/heads/feature/auth → feature/auth
    if (content.startsWith("ref: refs/heads/")) {
      return content.slice("ref: refs/heads/".length);
    }
    // Detached HEAD — return short SHA
    return content.slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * Get the current HEAD SHA via git rev-parse.
 */
export async function getHeadSha(cwd?: string): Promise<string> {
  return (await gitQuery(["rev-parse", "HEAD"], cwd ?? process.cwd())) || "";
}

/**
 * Start a branch switch poller. Calls onSwitch when branch changes.
 * Returns a dispose function to stop polling.
 */
export function startBranchPoller(
  onSwitch: (newBranch: string, context: BranchContext) => void,
  intervalMs = 5000,
  cwd?: string,
): () => void {
  let currentBranch = getCurrentBranch(cwd) ?? "unknown";

  const timer = setInterval(async () => {
    const switched = detectBranchSwitch(currentBranch, cwd);
    if (switched) {
      currentBranch = switched;
      const context = await computeBranchContext(cwd);
      onSwitch(switched, context);
    }
  }, intervalMs);

  // Don't prevent process exit
  timer.unref();

  return () => clearInterval(timer);
}
