/**
 * Unified auto-start installer — dispatches to the correct platform module.
 *
 * Gated by:
 *   - ~/.unerr/.autostart-installed sentinel (never re-runs)
 *   - isCI() check (never installs in CI/containers)
 *
 * Called automatically on first `unerr install <agent>` or `unerr daemon add`.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isCI } from "./detect-ci.js";
import type { PlatformInstallResult } from "./platform-macos.js";

const SENTINEL_PATH = join(homedir(), ".unerr", ".autostart-installed");

export function isAutostartInstalled(): boolean {
  return existsSync(SENTINEL_PATH);
}

/**
 * Install platform auto-start if not already done.
 * Returns null if skipped (already installed, CI, or unsupported platform).
 */
export async function autoInstallIfNeeded(): Promise<PlatformInstallResult | null> {
  if (isAutostartInstalled()) return null;
  if (isCI()) return null;

  const result = await installForCurrentPlatform();

  if (result.installed) {
    const dir = join(homedir(), ".unerr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(SENTINEL_PATH, new Date().toISOString(), "utf-8");
  }

  return result;
}

export async function installForCurrentPlatform(): Promise<PlatformInstallResult> {
  const plat = process.platform;

  if (plat === "darwin") {
    const { installLaunchd } = await import("./platform-macos.js");
    return installLaunchd();
  }

  if (plat === "linux") {
    const { installSystemd } = await import("./platform-linux.js");
    return installSystemd();
  }

  if (plat === "win32") {
    const { installWindows } = await import("./platform-windows.js");
    return installWindows();
  }

  return {
    installed: false,
    path: "",
    error: `Unsupported platform: ${plat}. Auto-start is available on macOS, Linux, and Windows.`,
  };
}

export async function uninstallForCurrentPlatform(): Promise<PlatformInstallResult> {
  const plat = process.platform;

  if (plat === "darwin") {
    const { uninstallLaunchd } = await import("./platform-macos.js");
    return uninstallLaunchd();
  }

  if (plat === "linux") {
    const { uninstallSystemd } = await import("./platform-linux.js");
    return uninstallSystemd();
  }

  if (plat === "win32") {
    const { uninstallWindows } = await import("./platform-windows.js");
    return uninstallWindows();
  }

  return {
    installed: false,
    path: "",
    error: `Unsupported platform: ${plat}`,
  };
}

export async function getAutostartStatus(): Promise<{
  platform: string;
  installed: boolean;
  sentinelExists: boolean;
  details: Record<string, unknown>;
}> {
  const plat = process.platform;
  const sentinelExists = isAutostartInstalled();

  if (plat === "darwin") {
    const { getLaunchdStatus } = await import("./platform-macos.js");
    return {
      platform: "macOS (launchd)",
      installed: sentinelExists,
      sentinelExists,
      details: getLaunchdStatus(),
    };
  }

  if (plat === "linux") {
    const { getSystemdStatus } = await import("./platform-linux.js");
    return {
      platform: "Linux (systemd)",
      installed: sentinelExists,
      sentinelExists,
      details: getSystemdStatus(),
    };
  }

  if (plat === "win32") {
    const { isWindowsInstalled } = await import("./platform-windows.js");
    return {
      platform: "Windows (schtasks/startup)",
      installed: sentinelExists,
      sentinelExists,
      details: { registered: isWindowsInstalled() },
    };
  }

  return { platform: plat, installed: false, sentinelExists, details: {} };
}

/**
 * Remove the sentinel to allow re-installation.
 * Used by `unerr daemon autostart off`.
 */
export function removeSentinel(): void {
  try {
    if (existsSync(SENTINEL_PATH)) unlinkSync(SENTINEL_PATH);
  } catch {
    // Best-effort
  }
}
