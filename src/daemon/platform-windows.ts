/**
 * Windows auto-start — Scheduled Task only (no Startup folder fallback).
 *
 * Creates a per-user Scheduled Task `Unerr Daemon` via schtasks /XML so the
 * task carries Author / Description / URI metadata that EDR can attribute.
 *
 * Design notes:
 *  - No Startup-folder .cmd fallback. Dropping a .cmd into %APPDATA%\...\Startup
 *    is the textbook user-mode persistence signature; AV scanners flag any
 *    package that does it regardless of intent.
 *  - Executable paths come from import.meta.url, not process.argv[1] or `where unerr`.
 *    A scanner red flag for persistence is "exec path influenced by runtime
 *    invocation"; the resolver in ./resolve-exec.ts removes that.
 *  - Runs as the current user with LeastPrivilege (no admin) at logon only.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformInstallResult } from "./platform-macos.js";
import { resolveAutostartExec, UnresolvedExecError } from "./resolve-exec.js";

const TASK_NAME = "Unerr Daemon";
const TASK_AUTHOR = "@unerr-ai/unerr";
const TASK_URI = "https://www.npmjs.com/package/@unerr-ai/unerr";
const TASK_DESCRIPTION =
  "unerr local code-intelligence daemon. Runs in user context at logon. " +
  "Manage via: unerr daemon disable-autostart";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * schtasks expects the XML file as UTF-16 LE with a BOM. Anything else and
 * it silently fails with "ERROR: The task XML contains a value that is incorrectly formatted".
 */
function encodeUtf16Le(s: string): Buffer {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(s, "utf16le");
  return Buffer.concat([bom, body]);
}

function generateTaskXml(nodeBin: string, cliEntry: string): string {
  const e = xmlEscape;
  // Arguments string: schtasks XML wants the command in <Command> and the
  // rest in <Arguments>. Inner quotes around cliEntry handle spaces in path.
  const args = `"${cliEntry}" daemon start --foreground`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${e(TASK_AUTHOR)}</Author>
    <Description>${e(TASK_DESCRIPTION)}</Description>
    <URI>\\${e(TASK_NAME)}</URI>
    <Source>${e(TASK_URI)}</Source>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${e(nodeBin)}</Command>
      <Arguments>${e(args)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

export function installWindows(): PlatformInstallResult {
  let exec: { nodeBin: string; cliEntry: string };
  try {
    exec = resolveAutostartExec(import.meta.url);
  } catch (err) {
    return {
      installed: false,
      path: `Scheduled Task: ${TASK_NAME}`,
      error:
        err instanceof UnresolvedExecError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  const xml = generateTaskXml(exec.nodeBin, exec.cliEntry);
  const tmpDir = mkdtempSync(join(tmpdir(), "unerr-autostart-"));
  const xmlPath = join(tmpDir, "task.xml");

  try {
    writeFileSync(xmlPath, encodeUtf16Le(xml));

    // Idempotent: drop any existing registration before creating.
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
    } catch {
      // Task didn't exist — that's fine.
    }

    execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${xmlPath}" /F`, {
      stdio: "ignore",
    });

    return { installed: true, path: `Scheduled Task: ${TASK_NAME}` };
  } catch (err) {
    return {
      installed: false,
      path: `Scheduled Task: ${TASK_NAME}`,
      error:
        err instanceof Error
          ? `schtasks failed: ${err.message}`
          : `schtasks failed: ${String(err)}`,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

export function uninstallWindows(): PlatformInstallResult {
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
  } catch {
    // Didn't exist — uninstall is idempotent.
  }
  return { installed: false, path: `Scheduled Task: ${TASK_NAME}` };
}

export function isWindowsInstalled(): boolean {
  try {
    execSync(`schtasks /Query /TN "${TASK_NAME}" /FO CSV /NH`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
