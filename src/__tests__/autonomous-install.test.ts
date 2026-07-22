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
import { readAutonomousMode } from "../config/autonomous-mode.js";
import { VERIFIER_AGENT_RELPATH } from "../skills/junior-agent.js";

// runInstall dynamic-imports "../daemon/client.js" inside its step-7 pre-warm
// block, and the tests below dynamic-import "../commands/install.js" — so the
// mock must be declared at module scope (vi.mock is hoisted above both) with
// vi.hoisted() backing the spies referenced inside it and later in the tests.
// This simulates a LIVE daemon (probeDaemon → true) purely to prove the
// autonomous===true guard skips the pre-warm call entirely; it never opens a
// real socket.
const { ensureRepoMock, probeDaemonMock } = vi.hoisted(() => ({
  ensureRepoMock: vi.fn().mockResolvedValue({ sock: "/tmp/fake-repo.sock" }),
  probeDaemonMock: vi.fn().mockResolvedValue(true),
}));

vi.mock("../daemon/client.js", () => ({
  daemonSockPath: () => "/tmp/fake-unerrd.sock",
  probeDaemon: probeDaemonMock,
  ensureRepo: ensureRepoMock,
}));

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
    ensureRepoMock.mockClear();
    probeDaemonMock.mockClear();
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

  it("runInstall with no autonomous argument preserves autonomous mode", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, true);
    expect(readConfig().autonomous).toBe(true);
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(true);

    await runInstall(cwd, "claude-code" as any);

    expect(readAutonomousMode(cwd)).toBe(true);
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(true);
  });

  it("runInstall with no autonomous argument preserves interactive mode", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, false);
    expect(readConfig().autonomous).toBeUndefined();
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(false);

    await runInstall(cwd, "claude-code" as any);

    expect(readAutonomousMode(cwd)).toBe(false);
    expect(readConfig().autonomous).toBeUndefined();
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(false);
  });

  it("a version-upgrade refresh preserves autonomous mode", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, true);
    expect(readConfig().autonomous).toBe(true);
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(true);

    // No `.unerr/state/agent-install.json` marker exists yet at this point —
    // runInstall never writes it, only refreshAgentInstallsIfUpgraded does —
    // so the very first call below reads a null stored version, which never
    // equals the running UNERR_VERSION, and the refresh fires for real: it
    // re-runs `runInstall(cwd, "claude-code")` with no third argument, the
    // exact call shape the bug broke.
    const { refreshAgentInstallsIfUpgraded } = await import(
      "../config/agent-reinstall.js"
    );
    const result = await refreshAgentInstallsIfUpgraded(cwd);

    expect(result?.refreshed).toContain("claude-code");
    expect(readAutonomousMode(cwd)).toBe(true);
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(true);
  });

  it("explicit false still clears an autonomous repo", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, true);
    expect(readConfig().autonomous).toBe(true);
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(true);

    await runInstall(cwd, "claude-code" as any, false);

    expect(readConfig().autonomous).toBeUndefined();
    expect(existsSync(join(cwd, VERIFIER_AGENT_RELPATH))).toBe(false);
  });

  it("--autonomous install skips the step-7 pre-warm (no ensureRepo call)", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, true);

    expect(ensureRepoMock).not.toHaveBeenCalled();
  });

  it("a plain install (no autonomous argument) reaches the step-7 pre-warm path", async () => {
    const { runInstall } = await import("../commands/install.js");

    await runInstall(cwd, "claude-code" as any, undefined);

    expect(probeDaemonMock).toHaveBeenCalled();
    expect(ensureRepoMock).toHaveBeenCalled();
  });
});
