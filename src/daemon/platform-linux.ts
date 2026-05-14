/**
 * Linux auto-start — systemd user unit for unerrd.
 *
 * Generates ~/.config/systemd/user/unerrd.service.
 * Enables with `systemctl --user enable --now`.
 * Runs `loginctl enable-linger` for headless/server boxes.
 * Skips WSL (no boot phase).
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
import type { PlatformInstallResult } from "./platform-macos.js";

const UNIT_NAME = "unerrd.service";

function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
}

function resolveUnerrBin(): string {
  try {
    return execSync("which unerr", { encoding: "utf-8" }).trim();
  } catch {
    return join(process.argv[1] || "unerr");
  }
}

function isWSL(): boolean {
  try {
    const version = readFileSync("/proc/version", "utf-8");
    return version.toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function generateUnit(bin: string): string {
  return `[Unit]
Description=unerr daemon supervisor
After=network.target

[Service]
Type=simple
ExecStart=${bin} daemon start --foreground
Restart=on-failure
RestartSec=5
Environment=HOME=${homedir()}
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

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
    const bin = resolveUnerrBin();
    const dir = unitDir();
    mkdirSync(dir, { recursive: true });

    writeFileSync(path, generateUnit(bin), "utf-8");

    execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    execSync("systemctl --user enable --now unerrd.service", {
      stdio: "ignore",
    });

    // Enable lingering so the unit starts at boot, not just at first login
    try {
      execSync("loginctl enable-linger $USER", { stdio: "ignore" });
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
