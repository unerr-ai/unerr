/**
 * Smart Default State Detector — pure function that inspects the local
 * environment and determines what action the CLI should take.
 *
 * State priority (checked top-to-bottom):
 *   1. Not inside a git repo     → not_git_repo
 *   2. No .unerr/config.json     → needs_setup
 *   3. PID file present + alive  → already_running
 *   4. PID file present + dead   → stale_pid (cleaned, becomes ready)
 *   5. Everything good            → ready
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { isGitRepo as isGitRepoAsync } from "./utils/git.js";

export type ProxyState =
  | "not_git_repo"
  | "needs_setup"
  | "already_running"
  | "stale_pid"
  | "ready";

export interface StateResult {
  state: ProxyState;
  /** PID of the running proxy, if already_running */
  pid?: number;
  /** Repo ID from .unerr/config.json, if available */
  repoId?: string;
}

export interface StateDetectorDeps {
  /** Check if cwd is inside a git repo. Default: isGitRepo from git.ts */
  isGitRepo?: () => Promise<boolean> | boolean;
  /** Get the cwd. Default: process.cwd() */
  cwd?: string;
}

/**
 * Inspect environment → return state.
 * All I/O is read-only (except stale PID cleanup).
 */
export async function detectState(
  deps: StateDetectorDeps = {},
): Promise<StateResult> {
  const cwd = deps.cwd ?? process.cwd();

  // 1. Git repo
  const checkGitRepo = deps.isGitRepo ?? (() => isGitRepoAsync(cwd));
  if (!(await checkGitRepo())) {
    return { state: "not_git_repo" };
  }

  // 2. Config
  const configPath = join(cwd, ".unerr", "config.json");
  if (!existsSync(configPath)) {
    return { state: "needs_setup" };
  }

  let repoId: string | undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      repoId?: string;
    };
    repoId = config.repoId;
  } catch {
    return { state: "needs_setup" };
  }

  // 3/4. PID check — supports both JSON { pid, startedAt, healthPort } and legacy plain number
  const pidPath = join(cwd, ".unerr", "state", "proxy.pid");
  if (existsSync(pidPath)) {
    try {
      const raw = readFileSync(pidPath, "utf-8").trim();
      let pid: number | undefined;
      if (raw.startsWith("{")) {
        const data = JSON.parse(raw) as { pid?: number };
        pid = data.pid;
      } else {
        pid = Number.parseInt(raw, 10);
      }
      if (pid && !Number.isNaN(pid) && isProcessAlive(pid)) {
        return { state: "already_running", pid, repoId };
      }
      // Stale PID — clean up
      unlinkSync(pidPath);
      return { state: "stale_pid", pid, repoId };
    } catch {
      // PID file unreadable — treat as stale
      try {
        unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
  }

  // 5. All good
  return { state: "ready", repoId };
}

/**
 * Check if a process is alive via kill(pid, 0).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
