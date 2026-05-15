/**
 * Windows auto-start — two-path approach.
 *
 * (a) Preferred: Scheduled Task `Unerr Daemon` via schtasks.
 * (b) Fallback: .cmd shim in %APPDATA%\...\Startup.
 *
 * Both run as current user (no admin).
 * Uses absolute paths to node + CLI entry to avoid PATH issues.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PlatformInstallResult } from "./platform-macos.js";

const TASK_NAME = "Unerr Daemon";
const STARTUP_CMD_NAME = "unerrd.cmd";

function startupDir(): string {
  return join(
    process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
}

function startupCmdPath(): string {
  return join(startupDir(), STARTUP_CMD_NAME);
}

function resolveNodeBin(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function resolveCliEntry(): string {
  if (process.argv[1]) {
    const resolved = resolve(process.argv[1]);
    if (existsSync(resolved)) return resolved;
  }

  // Fallback: find unerr via `where` (Windows equivalent of `which`)
  try {
    const whereLine = execSync("where unerr", { encoding: "utf-8" })
      .trim()
      .split("\n")[0]
      ?.trim();
    if (whereLine && existsSync(whereLine)) {
      // npm/pnpm on Windows creates .cmd shims — parse the target JS file from them
      const shimContent = readFileSync(whereLine, "utf-8");
      // npm .cmd shims contain: "%~dp0\node.exe" "%~dp0\node_modules\unerr\dist\cli.js" %*
      const jsMatch = /"%~dp0\\([^"]+\.js)"/m.exec(shimContent);
      if (jsMatch?.[1]) {
        const abs = resolve(dirname(whereLine), jsMatch[1]);
        if (existsSync(abs)) return abs;
      }
    }
  } catch {
    // non-fatal
  }

  const fallbackBase = process.argv[1]
    ? dirname(resolve(process.argv[1]))
    : process.cwd();
  return join(fallbackBase, "cli.js");
}

export function installWindows(): PlatformInstallResult {
  const nodeBin = resolveNodeBin();
  const cliEntry = resolveCliEntry();

  // Attempt scheduled task first
  const taskResult = installScheduledTask(nodeBin, cliEntry);
  if (taskResult.installed) return taskResult;

  // Fallback to startup folder
  return installStartupCmd(nodeBin, cliEntry);
}

function installScheduledTask(
  nodeBin: string,
  cliEntry: string
): PlatformInstallResult {
  // schtasks /TR requires the entire command wrapped in outer quotes,
  // with inner paths also quoted for spaces. The expected format is:
  //   /TR "\"C:\path to\node.exe\" \"C:\path to\cli.js\" daemon start --foreground"
  const innerCmd = `\\"${nodeBin}\\" \\"${cliEntry}\\" daemon start --foreground`;
  const trArg = `"${innerCmd}"`;

  try {
    // Delete existing task first (idempotent)
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
    } catch {
      // Didn't exist
    }

    execSync(
      `schtasks /Create /SC ONLOGON /TN "${TASK_NAME}" /TR ${trArg} /RL LIMITED /F`,
      { stdio: "ignore" }
    );

    return { installed: true, path: `Scheduled Task: ${TASK_NAME}` };
  } catch {
    return {
      installed: false,
      path: `Scheduled Task: ${TASK_NAME}`,
      error: "schtasks unavailable — falling back to Startup folder",
    };
  }
}

function installStartupCmd(
  nodeBin: string,
  cliEntry: string
): PlatformInstallResult {
  const path = startupCmdPath();

  try {
    const dir = startupDir();
    mkdirSync(dir, { recursive: true });

    const script = `@echo off\r\n"${nodeBin}" "${cliEntry}" daemon start --foreground\r\n`;
    writeFileSync(path, script, "utf-8");

    return { installed: true, path };
  } catch (err) {
    return {
      installed: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function uninstallWindows(): PlatformInstallResult {
  const errors: string[] = [];

  // Remove scheduled task
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
  } catch {
    // Didn't exist
  }

  // Remove startup cmd
  const cmdPath = startupCmdPath();
  try {
    if (existsSync(cmdPath)) unlinkSync(cmdPath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    installed: false,
    path: cmdPath,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

export function isWindowsInstalled(): boolean {
  // Check scheduled task
  try {
    execSync(`schtasks /Query /TN "${TASK_NAME}" /FO CSV /NH`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    // Not a scheduled task
  }

  // Check startup cmd
  return existsSync(startupCmdPath());
}
