/**
 * macOS auto-start — launchd plist for unerrd.
 *
 * Generates and installs ~/Library/LaunchAgents/com.unerr.daemon.plist.
 * KeepAlive on crash (with throttle), RunAtLoad=true, user-scoped (no sudo).
 * Loaded via `launchctl bootstrap gui/<uid>`.
 *
 * Critical design: launchd runs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
 * nvm/fnm/pnpm-managed node binaries are NOT on that PATH. The plist therefore
 * uses absolute paths to both node and the CLI entry point, resolved at install time
 * via `process.execPath` and the dist entry point. This bypasses shell shims entirely.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveAutostartExec, UnresolvedExecError } from "./resolve-exec.js";

const PLIST_NAME = "com.unerr.daemon.plist";

function plistDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function plistPath(): string {
  return join(plistDir(), PLIST_NAME);
}

function logPath(): string {
  return join(homedir(), ".unerr", "logs", "unerrd.boot.log");
}

/** Escape special XML characters in plist string values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generatePlist(nodeBin: string, cliEntry: string): string {
  const log = logPath();
  const nodeBinDir = dirname(nodeBin);
  // All interpolated values must be XML-escaped — paths may contain & or other special chars
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.unerr.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(nodeBin)}</string>
    <string>${e(cliEntry)}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${e(nodeBinDir)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${e(log)}</string>
  <key>StandardErrorPath</key>
  <string>${e(log)}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityBackgroundIO</key>
  <true/>
</dict>
</plist>`;
}

export interface PlatformInstallResult {
  installed: boolean;
  path: string;
  error?: string;
}

export function installLaunchd(): PlatformInstallResult {
  const dir = plistDir();
  const path = plistPath();

  let nodeBin: string;
  let cliEntry: string;
  try {
    const exec = resolveAutostartExec(import.meta.url);
    nodeBin = exec.nodeBin;
    cliEntry = exec.cliEntry;
  } catch (err) {
    return {
      installed: false,
      path,
      error:
        err instanceof UnresolvedExecError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  try {
    mkdirSync(dir, { recursive: true });
    const logDir = join(homedir(), ".unerr", "logs");
    mkdirSync(logDir, { recursive: true });

    const plist = generatePlist(nodeBin, cliEntry);
    writeFileSync(path, plist, "utf-8");

    const uid =
      process.getuid?.() ?? execSync("id -u", { encoding: "utf-8" }).trim();

    // Unload first if previously loaded (idempotent)
    try {
      execSync(
        `launchctl bootout gui/${uid}/${PLIST_NAME.replace(".plist", "")}`,
        {
          stdio: "ignore",
        }
      );
    } catch {
      // Not loaded — fine
    }

    execSync(`launchctl bootstrap gui/${uid} "${path}"`, { stdio: "ignore" });

    return { installed: true, path };
  } catch (err) {
    return {
      installed: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function uninstallLaunchd(): PlatformInstallResult {
  const path = plistPath();

  try {
    const uid =
      process.getuid?.() ?? execSync("id -u", { encoding: "utf-8" }).trim();

    try {
      execSync(
        `launchctl bootout gui/${uid}/${PLIST_NAME.replace(".plist", "")}`,
        {
          stdio: "ignore",
        }
      );
    } catch {
      // Not loaded
    }

    if (existsSync(path)) unlinkSync(path);
    return { installed: false, path };
  } catch (err) {
    return {
      installed: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isLaunchdInstalled(): boolean {
  return existsSync(plistPath());
}

export function getLaunchdStatus(): { loaded: boolean; plistExists: boolean } {
  const plistExists = existsSync(plistPath());
  let loaded = false;

  if (plistExists) {
    try {
      const out = execSync("launchctl list", { encoding: "utf-8" });
      loaded = out.includes("com.unerr.daemon");
    } catch {
      // launchctl failed
    }
  }

  return { loaded, plistExists };
}
