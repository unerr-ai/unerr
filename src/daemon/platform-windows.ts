/**
 * Windows auto-start — two-path approach.
 *
 * (a) Preferred: Scheduled Task `Unerr Daemon` via schtasks.
 * (b) Fallback: .cmd shim in %APPDATA%\...\Startup.
 *
 * Both run as current user (no admin).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    "Startup",
  );
}

function startupCmdPath(): string {
  return join(startupDir(), STARTUP_CMD_NAME);
}

function resolveUnerrBin(): string {
  try {
    return execSync("where unerr", { encoding: "utf-8" })
      .trim()
      .split("\n")[0]!
      .trim();
  } catch {
    return process.argv[1] || "unerr";
  }
}

export function installWindows(): PlatformInstallResult {
  const bin = resolveUnerrBin();

  // Attempt scheduled task first
  const taskResult = installScheduledTask(bin);
  if (taskResult.installed) return taskResult;

  // Fallback to startup folder
  return installStartupCmd(bin);
}

function installScheduledTask(bin: string): PlatformInstallResult {
  const cmd = `"${bin}" daemon start --foreground`;

  try {
    // Delete existing task first (idempotent)
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
    } catch {
      // Didn't exist
    }

    execSync(
      `schtasks /Create /SC ONLOGON /TN "${TASK_NAME}" /TR ${cmd} /RI 5 /DU 0000:00 /F`,
      { stdio: "ignore" },
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

function installStartupCmd(bin: string): PlatformInstallResult {
  const path = startupCmdPath();

  try {
    const dir = startupDir();
    mkdirSync(dir, { recursive: true });

    const script = `@echo off\r\n"${bin}" daemon start --foreground\r\n`;
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
