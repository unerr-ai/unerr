/**
 * macOS auto-start — launchd plist for unerrd.
 *
 * Generates and installs ~/Library/LaunchAgents/com.unerr.daemon.plist.
 * KeepAlive on crash, RunAtLoad=true, user-scoped (no sudo).
 * Loaded via `launchctl bootstrap gui/<uid>`.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function resolveUnerrBin(): string {
  try {
    return execSync("which unerr", { encoding: "utf-8" }).trim();
  } catch {
    return join(process.argv[1] || "unerr");
  }
}

function generatePlist(bin: string): string {
  const log = logPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.unerr.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
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
  const bin = resolveUnerrBin();

  try {
    mkdirSync(dir, { recursive: true });
    const logDir = join(homedir(), ".unerr", "logs");
    mkdirSync(logDir, { recursive: true });

    const plist = generatePlist(bin);
    writeFileSync(path, plist, "utf-8");

    const uid =
      process.getuid?.() ?? execSync("id -u", { encoding: "utf-8" }).trim();

    // Unload first if previously loaded (idempotent)
    try {
      execSync(
        `launchctl bootout gui/${uid}/${PLIST_NAME.replace(".plist", "")}`,
        {
          stdio: "ignore",
        },
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
        },
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
