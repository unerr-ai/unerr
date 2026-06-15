/**
 * Shell Execution Utility — tinyexec-based async command runner.
 *
 * Replaces all raw child_process.execSync / exec usage in the codebase.
 * Provides type-safe, async, argument-array-based execution (no shell injection).
 *
 * For git operations specifically, prefer the higher-level helpers in git.ts
 * which wrap simple-git. This module is for arbitrary shell commands and
 * low-level git plumbing where simple-git's API doesn't reach.
 */

import { constants as osConstants } from "node:os";
import { x } from "tinyexec";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Signal that killed the process (e.g. "SIGTERM"); null/absent on normal exit. */
  signal?: string | null;
}

/**
 * Shell convention for signal deaths: 128 + signal number (SIGTERM → 143,
 * SIGINT → 130). Uses os.constants.signals so the number is correct for the
 * running platform. Unknown names map to SIGTERM's 143 — the common case.
 */
export function signalExitCode(signal: string): number {
  const num = (osConstants.signals as Record<string, number | undefined>)[
    signal
  ];
  return 128 + (typeof num === "number" ? num : 15);
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  throwOnError?: boolean;
}

/**
 * Execute a command with args (no shell interpolation — safe by construction).
 * Returns structured result. Throws only if throwOnError is true and exit code != 0.
 */
export async function exec(
  command: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  // Hold the Result handle before awaiting: `await x(...)` resolves to the
  // plain Output {stdout, stderr, exitCode} — signalCode is only reachable
  // through the handle's underlying ChildProcess.
  const proc = x(command, args, {
    nodeOptions: {
      cwd: options.cwd,
      timeout: options.timeout,
    },
    throwOnError: false,
  });
  const result = await proc;

  // tinyexec leaves exitCode undefined when the child died by signal — map
  // that to the shell convention (128+signum) instead of masking it as 0,
  // so callers checking `exitCode === 0` don't treat a SIGTERM'd run as success.
  const signal = proc.process?.signalCode ?? null;
  const execResult: ExecResult = {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.exitCode ?? (signal ? signalExitCode(signal) : 0),
    signal,
  };

  if (options.throwOnError && execResult.exitCode !== 0) {
    const msg =
      execResult.stderr ||
      execResult.stdout ||
      `Command failed: ${command} ${args.join(" ")}`;
    throw new Error(msg);
  }

  return execResult;
}

/**
 * Execute a git command. Convenience wrapper that prefixes args with the git subcommand.
 *
 * Example: gitExec(["rev-parse", "--is-inside-work-tree"], { cwd })
 */
export async function gitExec(
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return exec("git", args, options);
}

/**
 * Quick git query — returns stdout as trimmed string.
 * Returns null on non-zero exit code instead of throwing.
 */
export async function gitQuery(
  args: string[],
  cwd?: string
): Promise<string | null> {
  const result = await gitExec(args, { cwd });
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * Open a `http(s):` URL in the system default browser (no shell interpolation).
 * `unerr dashboard` uses this to open the cloud dashboard URL.
 */
export async function openUrlInDefaultBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("openUrlInDefaultBrowser: only http(s) URLs are allowed");
  }
  const platform = process.platform;
  if (platform === "darwin") {
    await exec("open", [url], { throwOnError: true });
    return;
  }
  if (platform === "win32") {
    await exec("rundll32", ["url.dll,FileProtocolHandler", url], {
      throwOnError: true,
    });
    return;
  }
  await exec("xdg-open", [url], { throwOnError: true });
}
