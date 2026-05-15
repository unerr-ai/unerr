/**
 * Linux auto-start — systemd user unit for unerrd.
 *
 * Generates ~/.config/systemd/user/unerrd.service.
 * Enables with `systemctl --user enable --now`.
 * Runs `loginctl enable-linger` for headless/server boxes.
 * Skips WSL (no boot phase).
 *
 * Critical: uses absolute paths to node + CLI entry (nvm/fnm binaries
 * are not on the default systemd PATH).
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

const UNIT_NAME = "unerrd.service";

function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
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

  // Fallback: parse the shell shim installed by pnpm/npm
  try {
    const shimPath = execSync("which unerr", { encoding: "utf-8" }).trim();
    if (shimPath && existsSync(shimPath)) {
      const shimContent = readFileSync(shimPath, "utf-8");
      const jsMatch = /"\$basedir\/((?:\.\.\/)*[^"]+\.js)"/m.exec(shimContent);
      if (jsMatch?.[1]) {
        const basedir = dirname(shimPath);
        const abs = resolve(basedir, jsMatch[1]);
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

function isWSL(): boolean {
  try {
    const version = readFileSync("/proc/version", "utf-8");
    return version.toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Escape systemd ExecStart value — paths with spaces need quoting. */
function systemdQuote(s: string): string {
  if (/[\s"\\]/.test(s))
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return s;
}

function generateUnit(nodeBin: string, cliEntry: string): string {
  const nodeBinDir = dirname(nodeBin);
  const home = homedir();
  return `[Unit]
Description=unerr daemon supervisor
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(cliEntry)} daemon start --foreground
Restart=on-failure
RestartSec=30
Environment=HOME=${home}
Environment=PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

export function installSystemd(): PlatformInstallResult {
  const path = unitPath();

  if (isWSL()) {
    return {
      installed: false,
      path,
      error:
        "WSL detected — systemd user units have no boot phase. Use Windows auto-start instead.",
    };
  }

  try {
    const nodeBin = resolveNodeBin();
    const cliEntry = resolveCliEntry();
    const dir = unitDir();
    mkdirSync(dir, { recursive: true });

    writeFileSync(path, generateUnit(nodeBin, cliEntry), "utf-8");

    execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    execSync("systemctl --user enable --now unerrd.service", {
      stdio: "ignore",
    });

    // Enable lingering so the unit starts at boot, not just at first login
    try {
      const username =
        process.env.USER || execSync("whoami", { encoding: "utf-8" }).trim();
      execSync(`loginctl enable-linger ${username}`, { stdio: "ignore" });
    } catch {
      // loginctl may not be available (containers, minimal installs)
    }

    return { installed: true, path };
  } catch (err) {
    return {
      installed: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function uninstallSystemd(): PlatformInstallResult {
  const path = unitPath();

  try {
    try {
      execSync("systemctl --user disable --now unerrd.service", {
        stdio: "ignore",
      });
    } catch {
      // Not enabled
    }

    if (existsSync(path)) unlinkSync(path);

    try {
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    } catch {
      // Best-effort
    }

    return { installed: false, path };
  } catch (err) {
    return {
      installed: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isSystemdInstalled(): boolean {
  return existsSync(unitPath());
}

export function getSystemdStatus(): {
  unitExists: boolean;
  active: boolean;
  enabled: boolean;
} {
  const unitExists = existsSync(unitPath());
  let active = false;
  let enabled = false;

  if (unitExists) {
    try {
      const out = execSync("systemctl --user is-active unerrd.service", {
        encoding: "utf-8",
      }).trim();
      active = out === "active";
    } catch {
      // inactive or failed
    }

    try {
      const out = execSync("systemctl --user is-enabled unerrd.service", {
        encoding: "utf-8",
      }).trim();
      enabled = out === "enabled";
    } catch {
      // not enabled
    }
  }

  return { unitExists, active, enabled };
}
