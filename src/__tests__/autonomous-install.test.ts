/**
 * Autonomous-mode install slice (W1): `unerr install claude-code
 * --autonomous` persists an `autonomous` flag in `.unerr/config.json`; the
 * flag is claude-code only, and both a plain reinstall and `unerr uninstall`
 * clear it back to interactive mode.
 *
 * Isolated via UNERR_HOME (redirects the daemon registry + probe socket path
 * away from the real machine's ~/.unerr) — runInstall's best-effort pre-warm
 * probes a daemon that never exists at this path, so it no-ops without
 * touching a live unerrd. `bootAutonomousBackend` (the process-spawning warm
 * path) is never invoked here — it lives in the install command's action,
 * not in runInstall, specifically so these tests stay process-free.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("autonomous install", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    homeDir = join(tmpdir(), `autonomous-install-home-${stamp}`);
    cwd = join(tmpdir(), `autonomous-install-project-${stamp}`);
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("UNERR_HOME", homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function readConfig(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(cwd, ".unerr", "config.json"), "utf-8")
    );
  }

  it("(a) --autonomous with a non-claude-code agent fails and writes nothing", async () => {
    const { runInstall, AutonomousModeUnsupportedError } = await import(
      "../commands/install.js"
    );

    await expect(runInstall(cwd, "cursor" as any, true)).rejects.toThrow(
      AutonomousModeUnsupportedError
    );
    expect(existsSync(join(cwd, ".unerr", "config.json"))).toBe(false);
  });

  it("(b) --autonomous claude-code install writes autonomous:true", async () => {
    const { runInstall } = await import("../commands/install.js");

    const result = await runInstall(cwd, "claude-code" as any, true);

    expect(result.agent).toBeTruthy();
    expect(readConfig().autonomous).toBe(true);
  });

  it("(c) a subsequent plain claude-code install clears the flag", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, true);
    expect(readConfig().autonomous).toBe(true);

    await runInstall(cwd, "claude-code" as any, false);
    expect(readConfig().autonomous).toBeUndefined();
  });

  it("(d) uninstall clears the autonomous flag", async () => {
    const { runInstall } = await import("../commands/install.js");
    await runInstall(cwd, "claude-code" as any, true);
    expect(readConfig().autonomous).toBe(true);

    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const { registerUninstallCommand } = await import(
        "../commands/uninstall.js"
      );
      const program = new Command().exitOverride();
      registerUninstallCommand(program);
      await program.parseAsync(["node", "unerr", "uninstall", "claude-code"]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(readConfig().autonomous).toBeUndefined();
  });
});
