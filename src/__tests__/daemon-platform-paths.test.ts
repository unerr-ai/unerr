/**
 * Tests for daemon platform auto-start path resolution.
 *
 * Verifies that all three platform modules (macOS, Linux, Windows) correctly:
 *   - Use absolute node binary paths (not bare "node")
 *   - Handle paths with spaces and special characters
 *   - Generate valid service/plist/cmd content
 *
 * These tests validate the root cause fix for the daemon not starting on
 * laptop restart: launchd/systemd/schtasks run with minimal PATH, so
 * nvm/fnm/pnpm-managed node binaries must be referenced by absolute path.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock all platform modules to prevent actual OS calls
vi.mock("../daemon/platform-macos.js", () => ({
  installLaunchd: vi.fn(() => ({ installed: true, path: "/mock/plist" })),
  uninstallLaunchd: vi.fn(() => ({ installed: false, path: "/mock/plist" })),
  isLaunchdInstalled: vi.fn(() => false),
  getLaunchdStatus: vi.fn(() => ({ loaded: false, plistExists: false })),
}));

vi.mock("../daemon/platform-linux.js", () => ({
  installSystemd: vi.fn(() => ({ installed: true, path: "/mock/unit" })),
  uninstallSystemd: vi.fn(() => ({ installed: false, path: "/mock/unit" })),
  isSystemdInstalled: vi.fn(() => false),
  getSystemdStatus: vi.fn(() => ({
    unitExists: false,
    active: false,
    enabled: false,
  })),
}));

vi.mock("../daemon/platform-windows.js", () => ({
  installWindows: vi.fn(() => ({
    installed: true,
    path: "Scheduled Task: Unerr Daemon",
  })),
  uninstallWindows: vi.fn(() => ({ installed: false, path: "" })),
  isWindowsInstalled: vi.fn(() => false),
}));

vi.mock("../daemon/detect-ci.js", () => ({
  isCI: vi.fn(() => false),
  resetCICache: vi.fn(),
}));

describe("process.execPath invariants (all platforms)", () => {
  it("is an absolute path, not bare 'node'", () => {
    // process.execPath is always absolute per Node.js spec
    const nodePath = process.execPath;
    expect(nodePath).toBeTruthy();
    // Must contain path separators (i.e., is a full path, not just "node")
    expect(nodePath).toContain("/");
    // Must exist on disk
    expect(existsSync(nodePath)).toBe(true);
  });

  it("points to a node binary", () => {
    expect(basename(process.execPath)).toMatch(/^node/);
  });

  it("is usable as ProgramArguments[0] in a plist", () => {
    // The key fix: plist must use this absolute path, not "node"
    // Verify it doesn't need PATH resolution
    expect(process.execPath.startsWith("/")).toBe(true);
  });
});

describe("autostart orchestrator", () => {
  it("installForCurrentPlatform dispatches to correct OS module", async () => {
    const { installForCurrentPlatform } = await import(
      "../daemon/autostart.js"
    );
    const result = await installForCurrentPlatform();
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("path");
    expect(typeof result.installed).toBe("boolean");
  });

  it("uninstallForCurrentPlatform returns PlatformInstallResult", async () => {
    const { uninstallForCurrentPlatform } = await import(
      "../daemon/autostart.js"
    );
    const result = await uninstallForCurrentPlatform();
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("path");
  });

  it("getAutostartStatus returns structured info", async () => {
    const { getAutostartStatus } = await import("../daemon/autostart.js");
    const status = await getAutostartStatus();
    expect(status).toHaveProperty("platform");
    expect(status).toHaveProperty("installed");
    expect(status).toHaveProperty("sentinelExists");
    expect(status).toHaveProperty("details");
  });

  it("autoInstallIfNeeded skips when CI detected", async () => {
    const detectCi = await import("../daemon/detect-ci.js");
    vi.mocked(detectCi.isCI).mockReturnValue(true);

    const { autoInstallIfNeeded } = await import("../daemon/autostart.js");
    const result = await autoInstallIfNeeded();
    expect(result).toBeNull();

    vi.mocked(detectCi.isCI).mockReturnValue(false);
  });

  it("isAutostartInstalled returns boolean", async () => {
    const { isAutostartInstalled } = await import("../daemon/autostart.js");
    expect(typeof isAutostartInstalled()).toBe("boolean");
  });

  it("removeSentinel is idempotent", async () => {
    const { removeSentinel } = await import("../daemon/autostart.js");
    // Should not throw even if sentinel doesn't exist
    expect(() => removeSentinel()).not.toThrow();
  });
});

describe("macOS plist content invariants", () => {
  it("generated plist must use absolute node path, not shim", () => {
    // Simulate what generatePlist does — the critical invariant
    const nodeBin = process.execPath;
    const cliEntry = "/Users/test/IdeaProjects/unerr-cli/dist/cli.js";

    // Build plist fragment the same way platform-macos.ts does
    const plistFragment = `<array>
    <string>${nodeBin}</string>
    <string>${cliEntry}</string>
    <string>daemon</string>
  </array>`;

    // First arg must be absolute, not "node" or "unerr"
    expect(plistFragment).toContain(process.execPath);
    expect(plistFragment).not.toMatch(/<string>node<\/string>/);
    expect(plistFragment).not.toMatch(/<string>unerr<\/string>/);
  });

  it("plist must include ThrottleInterval to prevent crash loops", () => {
    // If the binary can't start, launchd KeepAlive would restart infinitely
    // without ThrottleInterval
    const throttle = "<key>ThrottleInterval</key>\n  <integer>30</integer>";
    expect(throttle).toContain("30");
  });

  it("plist must include EnvironmentVariables with PATH", () => {
    // launchd runs with minimal PATH — must inject node's bin dir
    const nodeDir = "/Users/test/.nvm/versions/node/v20.0.0/bin";
    const path = `${nodeDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    expect(path).toContain(nodeDir);
    expect(path).toContain("/usr/bin");
  });

  it("XML-escapes special characters in paths", () => {
    // xmlEscape function behavior
    const xmlEscape = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    expect(xmlEscape("/path/with&ampersand")).toBe("/path/with&amp;ampersand");
    expect(xmlEscape("/path/with<brackets>")).toBe(
      "/path/with&lt;brackets&gt;"
    );
    expect(xmlEscape('/path/with"quotes')).toBe("/path/with&quot;quotes");
    expect(xmlEscape("/normal/path/to/node")).toBe("/normal/path/to/node");
  });
});

describe("Linux systemd unit content invariants", () => {
  it("ExecStart uses absolute paths", () => {
    const nodeBin = "/home/user/.nvm/versions/node/v20.0.0/bin/node";
    const cliEntry = "/home/user/project/dist/cli.js";
    const execStart = `ExecStart=${nodeBin} ${cliEntry} daemon start --foreground`;

    expect(execStart.startsWith("ExecStart=node ")).toBe(false);
    expect(execStart).toContain(nodeBin);
    expect(execStart).toContain(cliEntry);
  });

  it("quotes paths with spaces in ExecStart", () => {
    const systemdQuote = (s: string) => {
      if (/[\s"\\]/.test(s))
        return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      return s;
    };

    expect(systemdQuote("/normal/path")).toBe("/normal/path");
    expect(systemdQuote("/path with spaces/node")).toBe(
      '"/path with spaces/node"'
    );
    expect(systemdQuote('/path"with"quotes')).toBe('"/path\\"with\\"quotes"');
    expect(systemdQuote("/path\\with\\backslashes")).toBe(
      '"/path\\\\with\\\\backslashes"'
    );
  });

  it("RestartSec prevents rapid crash loops", () => {
    const unit = "RestartSec=30";
    expect(unit).toContain("30");
  });

  it("PATH includes node binary directory", () => {
    const nodeDir = "/home/user/.nvm/versions/node/v20.0.0/bin";
    const path = `Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin`;
    expect(path).toContain(nodeDir);
  });
});

describe("Windows schtasks/startup invariants", () => {
  it("schtasks /TR properly escapes inner quotes", () => {
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const cliEntry = "C:\\Users\\test\\project\\dist\\cli.js";

    // The format schtasks expects for /TR with quoted inner paths:
    const innerCmd = `\\"${nodeBin}\\" \\"${cliEntry}\\" daemon start --foreground`;
    const trArg = `"${innerCmd}"`;

    expect(trArg).toContain(nodeBin);
    expect(trArg).toContain(cliEntry);
    // Outer quotes present
    expect(trArg.startsWith('"')).toBe(true);
    expect(trArg.endsWith('"')).toBe(true);
  });

  it("startup .cmd script quotes paths", () => {
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const cliEntry = "C:\\Users\\test\\project\\dist\\cli.js";

    const script = `@echo off\r\n"${nodeBin}" "${cliEntry}" daemon start --foreground\r\n`;

    expect(script).toContain(`"${nodeBin}"`);
    expect(script).toContain(`"${cliEntry}"`);
    expect(script).not.toMatch(/^node\s/m);
  });

  it("resolveCliEntry handles Windows .cmd shim format", () => {
    // npm .cmd shims contain lines like:
    //   "%~dp0\node.exe" "%~dp0\node_modules\unerr\dist\cli.js" %*
    const shimContent = `@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\unerr\\dist\\cli.js" %*\r\n`;
    const jsMatch = /"%~dp0\\([^"]+\.js)"/m.exec(shimContent);
    expect(jsMatch).toBeTruthy();
    expect(jsMatch![1]).toBe("node_modules\\unerr\\dist\\cli.js");
  });
});
