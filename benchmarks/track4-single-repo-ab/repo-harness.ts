/**
 * Sets up an isolated git worktree per arm of the target repo, applies a task's
 * break, and runs its test oracle. Worktree isolation means the three arms never
 * see each other's edits, and resetting to `baseCommit` between tasks keeps the
 * oracle deterministic. The unerr arms get unerr installed into the worktree; the
 * baseline arm does not.
 *
 * @sem domain=benchmark role=harness
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { armUsesUnerr, type ArmId, type TaskSpec } from "./types.js";

/** Where one arm's worktree + scratch state live. */
export interface ArmWorkspace {
  arm: ArmId;
  /** Absolute path to the arm's git worktree (the agent's cwd). */
  worktreeDir: string;
  /** Absolute path to the arm's `.unerr` dir (where metrics.db lands). */
  unerrDir: string;
}

/** Result of running one task's gate test. */
export interface OracleResult {
  resolved: boolean;
  exitCode: number;
}

const RUN_OPTS = { stdio: "inherit" as const, encoding: "utf-8" as const };

/** Run a shell command in `cwd`, throwing on non-zero exit (setup must succeed). */
function sh(command: string, cwd: string): void {
  execSync(command, { ...RUN_OPTS, cwd });
}

/**
 * Run the gate test for a task. Exit 0 = resolved; any other exit = unresolved.
 * Never throws on a failing test — a red test is data, not an error.
 */
export function runOracle(task: TaskSpec, worktreeDir: string): OracleResult {
  try {
    execSync(task.testCommand, { ...RUN_OPTS, cwd: worktreeDir });
    return { resolved: true, exitCode: 0 };
  } catch (err) {
    const code =
      typeof (err as { status?: number }).status === "number"
        ? (err as { status: number }).status
        : 1;
    return { resolved: false, exitCode: code };
  }
}

/** Apply a task's break command (if any) so the gate test starts red. */
export function applyBreak(task: TaskSpec, worktreeDir: string): void {
  if (task.breakCommand) {
    sh(task.breakCommand, worktreeDir);
  }
}

/**
 * Create a fresh worktree for `arm` under `<workRoot>/<arm>`, checked out at
 * `baseCommit`. Removes any prior worktree at that path first so a re-run starts
 * clean. For the unerr arms, runs `installUnerr` to wire the worktree's `.mcp.json`.
 */
export function setupArmWorkspace(
  repoDir: string,
  workRoot: string,
  arm: ArmId,
  baseCommit: string | undefined,
  installUnerr: (worktreeDir: string) => void
): ArmWorkspace {
  const worktreeDir = resolve(join(workRoot, arm));
  // Tear down a stale worktree from a previous run (git refuses to reuse a path).
  if (existsSync(worktreeDir)) {
    try {
      execSync(`git worktree remove --force ${worktreeDir}`, {
        ...RUN_OPTS,
        cwd: repoDir,
      });
    } catch {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  }
  mkdirSync(workRoot, { recursive: true });

  const ref = baseCommit ?? "HEAD";
  sh(`git worktree add --detach ${worktreeDir} ${ref}`, repoDir);

  if (armUsesUnerr(arm)) {
    installUnerr(worktreeDir);
  }

  return { arm, worktreeDir, unerrDir: join(worktreeDir, ".unerr") };
}

/**
 * Reset a worktree back to `baseCommit` between tasks — discards the agent's
 * edits and any break so the next task's oracle is independent. Keeps `.unerr`
 * (and thus metrics history) unless `wipeUnerr` is set.
 */
export function resetWorktree(
  ws: ArmWorkspace,
  baseCommit: string | undefined,
  wipeUnerr: boolean
): void {
  const ref = baseCommit ?? "HEAD";
  sh("git reset --hard", ws.worktreeDir);
  sh("git clean -fd", ws.worktreeDir);
  sh(`git checkout --detach ${ref}`, ws.worktreeDir);
  if (wipeUnerr && existsSync(ws.unerrDir)) {
    rmSync(ws.unerrDir, { recursive: true, force: true });
  }
}

/**
 * Wipe only the unerr memory surface (anchored notes + facts) for the
 * `unerr-nomemory` arm, while keeping the graph and metrics.db. Removing the
 * facts DB forces the next task to start with no carried-over memory.
 */
export function wipeUnerrMemory(ws: ArmWorkspace): void {
  for (const rel of ["facts.db", "notes.db"]) {
    const p = join(ws.unerrDir, rel);
    if (existsSync(p)) {
      rmSync(p, { force: true });
    }
  }
}

/** Write an empty MCP config (used to neutralize the baseline arm). */
export function writeEmptyMcpConfig(path: string): string {
  const resolved = resolve(path);
  writeFileSync(resolved, JSON.stringify({ mcpServers: {} }, null, 2));
  return resolved;
}
