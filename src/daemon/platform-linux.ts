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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PlatformInstallResult } from "./platform-macos.js";
import { resolveAutostartExec, UnresolvedExecError } from "./resolve-exec.js";

const UNIT_NAME = "unerrd.service";

function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
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
