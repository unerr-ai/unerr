/**
 * The single consolidated upgrade flow — the ONE place that turns "a newer
 * version exists" into "the new version is installed and running". Every upgrade
 * path reuses these pieces so the logic never forks:
 *
 *  - {@link acquireBinary} — swap the running native binary (the `binary`
 *    install) via self-replace, or run a package manager's `… install -g`.
 *    Reused by the auto-apply path (apply.ts) AND the manual command.
 *  - {@link healthCheckBinary} — the freshly-installed `unerr --version` must
 *    report the target version.
 *  - {@link reinstallAllRepos} — re-run `unerr install` (via the NEW binary) for
 *    every already-configured agent in every registered repo, so each repo's MCP
 *    config / instructions / skills match the new version.
 *  - {@link restartRuntime} — stop unerrd + its per-repo `unerr` children, drop
 *    the IDE-owned `unerr --mcp` bridges (IDEs respawn them on the new binary),
 *    then start unerrd again on the new binary.
 *  - {@link performUpgrade} — the end-to-end manual flow (`unerr upgrade`):
 *    resolve target → acquire → health-check → reinstall all repos → restart.
 *
 * The auto-apply path (apply.ts) deliberately reuses only acquireBinary /
 * healthCheckBinary — it never force-restarts a live session (HR-B: never break
 * local; it converges via the bridge handshake + idle-exit). The manual command
 * is the explicit "restart everything now" path.
 *
 * Best-effort + injectable (spawn, fetch, daemon I/O), never throws out of the
 * orchestrator.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { configuredAgents } from "../config/agent-reinstall.js";
import { listRepos } from "../daemon/registry.js";
import { spawnUnerr } from "../utils/self-spawn.js";
import { UNERR_VERSION } from "../version.js";
import {
  type InstallClassification,
  classifyInstall,
  upgradeCommand,
} from "./install-manager.js";
import { selfReplace } from "./self-replace.js";
import { classifyUpdate } from "./semver.js";
import { resolveChannel } from "./update-config.js";
import { checkForUpdate } from "./version-check.js";

/** The result of running one install/replace step. */
export interface InstallRunResult {
  ok: boolean;
  output: string;
}

/** How a single repo's agent reinstall went. */
export interface RepoReinstall {
  repo: string;
  agents: string[];
  ok: boolean;
  failures: string[];
}

export interface UpgradeFlowResult {
  ok: boolean;
  from: string;
  to: string;
  /** True when nothing was newer — no work done. */
  upToDate: boolean;
  channel: "stable" | "beta";
  manager: InstallClassification["manager"];
  reposReinstalled: RepoReinstall[];
  restarted: boolean;
  /** Present when ok=false. */
  error?: string;
}

const noopLog = (_: string) => {};

/** Expand a leading `~` (the registry stores tilde-form repo paths). */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

// ── Binary acquisition (shared by auto-apply + manual) ────────────────────

/** Run a package-manager `… install -g` command to completion. */
export function runInstallCommand(cmd: string): Promise<InstallRunResult> {
  return new Promise((resolve) => {
    void import("node:child_process").then(({ spawn }) => {
      const parts = cmd.split(/\s+/).filter(Boolean);
      const child = spawn(parts[0]!, parts.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      let output = "";
      child.stdout?.on("data", (d) => {
        output += d;
      });
      child.stderr?.on("data", (d) => {
        output += d;
      });
      child.on("error", (e) => resolve({ ok: false, output: String(e) }));
      child.on("exit", (code) => resolve({ ok: code === 0, output }));
    });
  });
}

/**
 * Download the release for `version` from the unerr Release and atomically
 * swap the running native binary in place (the `binary` install channel).
 */
export function runSelfReplace(version: string): Promise<InstallRunResult> {
  return selfReplace({ version }).then((r) => ({
    ok: r.ok,
    output: r.ok
      ? `self-replaced → ${r.to}`
      : (r.error ?? "self-replace failed"),
  }));
}

/**
 * Run the upgrade for the detected manager. The `binary` install swaps the
 * native binary in place (self-replace); every package-manager install runs its
 * pinned `… install -g` command. The single branch point so the apply, rollback,
 * and manual-upgrade paths never diverge on HOW a manager is upgraded.
 */
export function acquireBinary(
  cls: InstallClassification,
  version: string,
  deps: {
    runInstall?: (cmd: string) => Promise<InstallRunResult>;
    selfReplaceImpl?: (version: string) => Promise<InstallRunResult>;
  } = {}
): Promise<InstallRunResult> {
  if (cls.manager === "binary") {
    return (deps.selfReplaceImpl ?? runSelfReplace)(version);
  }
  return (deps.runInstall ?? runInstallCommand)(
    upgradeCommand(cls.manager, version)
  );
}

/** The globally-resolved `unerr --version` must report `expected`. */
export function healthCheckBinary(expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    void import("node:child_process").then(({ execFile }) => {
      execFile(
        "unerr",
        ["--version"],
        { timeout: 15_000, encoding: "utf-8" },
        (err, stdout) => {
          resolve(
            !err && typeof stdout === "string" && stdout.includes(expected)
          );
        }
      );
    });
  });
}

// ── Per-repo agent reinstall (under the NEW binary) ───────────────────────

/** Spawn the (now-swapped) unerr binary for one subcommand; resolve its exit code. */
function runUnerr(args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawnUnerr(args, {
        cwd,
        stdio: ["ignore", "ignore", "inherit"],
      });
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 1));
    } catch {
      resolve(1);
    }
  });
}

/** Injectable seams for {@link reinstallAllRepos} (tests). */
export interface ReinstallDeps {
  /** The registry walk. Defaults to {@link listRepos}. */
  listRepos?: typeof listRepos;
  /** Per-repo configured-agent lookup. Defaults to {@link configuredAgents}. */
  configuredAgents?: typeof configuredAgents;
  /** Run one `unerr install <agent>`; resolves the exit code. Defaults to {@link runUnerr}. */
  installAgent?: (args: string[], cwd: string) => Promise<number>;
}

/**
 * Re-run `unerr install <agent>` for every already-configured agent in every
 * registered repo, using the NEW binary (this process is still the old version
 * in memory, but `spawnUnerr` re-execs the swapped file on disk). Refreshes each
 * repo's MCP config / instructions / skills to the new version. Best-effort,
 * never throws; every external seam (registry, agent lookup, spawn) is injectable.
 */
export async function reinstallAllRepos(
  log: (msg: string) => void = noopLog,
  deps: ReinstallDeps = {}
): Promise<RepoReinstall[]> {
  const list = deps.listRepos ?? listRepos;
  const agentsOf = deps.configuredAgents ?? configuredAgents;
  const install = deps.installAgent ?? runUnerr;
  const out: RepoReinstall[] = [];
  for (const repo of list()) {
    const repoPath = expandHome(repo.path);
    let agents: string[] = [];
    try {
      agents = agentsOf(repoPath);
    } catch {
      /* unreadable repo config — skip, report zero agents */
    }
    const failures: string[] = [];
    for (const agent of agents) {
      const code = await install(["install", agent], repoPath);
      if (code !== 0) failures.push(agent);
    }
    const ok = failures.length === 0;
    out.push({ repo: repoPath, agents, ok, failures });
    log(
      `  ${ok ? "✓" : "⚠"} ${repo.label ?? repoPath}: reinstalled ${agents.length} agent(s)${
        failures.length ? ` (${failures.length} failed)` : ""
      }`
    );
  }
  return out;
}

// ── Runtime restart (unerrd → per-repo unerr → unerr --mcp bridges) ───────

/**
 * Best-effort kill of the IDE-owned `unerr --mcp` bridge processes so each IDE
 * respawns its bridge on the new binary. The bridge is a stateless stdio↔UDS
 * relay, so a brief disconnect is harmless. Never throws; a failure just leaves
 * the old bridge relaying to the (new) per-repo proxy until the IDE restarts it.
 */
async function killBridges(log: (msg: string) => void): Promise<void> {
  try {
    const { spawn } = await import("node:child_process");
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process | " +
        "Where-Object { $_.CommandLine -like '*unerr*--mcp*' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      spawn("powershell", ["-NoProfile", "-Command", ps], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      // -f matches the full command line; this process is `unerr upgrade`, never
      // a match, so it won't kill itself.
      spawn("pkill", ["-f", "unerr --mcp"], { stdio: "ignore" }).unref();
    }
    log("  ✓ signalled IDE bridges to restart");
  } catch {
    /* best-effort */
  }
}

/**
 * Stop unerrd (which cascades a graceful shutdown to its per-repo `unerr`
 * children). Best-effort: a missing daemon, a failed probe, or a rejected
 * shutdown request all degrade to a log line, never a throw.
 */
async function stopDaemon(log: (msg: string) => void): Promise<void> {
  try {
    const { daemonSockPath, probeDaemon, requestDaemonShutdown } = await import(
      "../daemon/client.js"
    );
    const sock = daemonSockPath();
    if (await probeDaemon(sock)) {
      try {
        await requestDaemonShutdown(sock);
        log("  ✓ stopped unerrd + per-repo proxies");
      } catch {
        log("  ⚠ unerrd shutdown request failed (continuing)");
      }
    }
  } catch {
    /* daemon client failed to load — nothing to stop */
  }
}

/**
 * Start a fresh unerrd on the new binary. `pm start --detached` double-forks so
 * the new supervisor reparents to init and outlives this command. Best-effort.
 */
function startDaemon(log: (msg: string) => void): void {
  try {
    const child = spawnUnerr(["pm", "start", "--detached"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    log("  ✓ started unerrd on the new binary");
  } catch {
    log(
      "  ⚠ could not start unerrd — it will auto-spawn on the next IDE connect"
    );
  }
}

/** Injectable seams for {@link restartRuntime} (tests). */
export interface RestartDeps {
  /** Stop unerrd + its children. Defaults to {@link stopDaemon}. */
  stopDaemon?: (log: (msg: string) => void) => Promise<void>;
  /** Drop the IDE bridges. Defaults to {@link killBridges}. */
  killBridges?: (log: (msg: string) => void) => Promise<void>;
  /** Start a fresh unerrd. Defaults to {@link startDaemon}. */
  startDaemon?: (log: (msg: string) => void) => void;
}

/**
 * Restart the runtime end-to-end onto the new binary: stop unerrd (cascading to
 * its per-repo `unerr` children), drop the `unerr --mcp` bridges, then start a
 * fresh unerrd. The per-repo proxies re-spawn lazily on the next MCP activity
 * (new binary); the bridges relaunch when their IDE reconnects (new binary).
 * Each step is independent and best-effort — a failure in one never blocks the
 * next and the function never throws; every step is injectable.
 */
export async function restartRuntime(
  log: (msg: string) => void = noopLog,
  deps: RestartDeps = {}
): Promise<void> {
  // Each step is isolated: a throw in one is swallowed so the next still runs.
  const step = async (fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch {
      /* best-effort — a failed step never blocks the rest of the restart */
    }
  };
  await step(() => (deps.stopDaemon ?? stopDaemon)(log));
  await step(() => (deps.killBridges ?? killBridges)(log));
  await step(() => (deps.startDaemon ?? startDaemon)(log));
}

// ── The end-to-end manual flow ────────────────────────────────────────────

export interface UpgradeFlowOptions {
  /** Pin a specific version; default = the channel's latest. */
  version?: string;
  /** Release channel; default = the local `update.channel` setting. */
  channel?: "stable" | "beta";
  /** Override the detected install classification (tests). */
  classification?: InstallClassification;
  /** Restart the runtime after install (default true). */
  restart?: boolean;
  /** Reinstall agents across all registered repos (default true). */
  reinstallRepos?: boolean;
  log?: (msg: string) => void;
  /** Injectable binary acquisition (tests). */
  runInstall?: (cmd: string) => Promise<InstallRunResult>;
  selfReplaceImpl?: (version: string) => Promise<InstallRunResult>;
  /** Injectable health check (tests). Defaults to {@link healthCheckBinary}. */
  healthCheck?: (expected: string) => Promise<boolean>;
}

/**
 * The consolidated `unerr upgrade`: resolve the target version for the channel,
 * acquire the new binary, health-check it, reinstall every registered repo under
 * the new binary, then restart the runtime end-to-end. Returns a structured
 * result; the CLI renders it. Never throws.
 */
export async function performUpgrade(
  opts: UpgradeFlowOptions = {}
): Promise<UpgradeFlowResult> {
  const log = opts.log ?? noopLog;
  const channel = opts.channel ?? resolveChannel();
  const cls = opts.classification ?? classifyInstall();
  const current = UNERR_VERSION;
  const restart = opts.restart !== false;
  const reinstall = opts.reinstallRepos !== false;

  const base: Omit<UpgradeFlowResult, "ok" | "to" | "upToDate"> = {
    from: current,
    channel,
    manager: cls.manager,
    reposReinstalled: [],
    restarted: false,
  };

  // Resolve the target version.
  let target = opts.version;
  if (!target) {
    const chk = await checkForUpdate({ force: true, channel });
    if (
      !chk.latest ||
      classifyUpdate(current, chk.latest, {
        allowPrerelease: channel === "beta",
      }) === "none"
    ) {
      log(`unerr ${current} — already up to date (channel ${channel})`);
      return { ...base, ok: true, to: current, upToDate: true };
    }
    target = chk.latest;
  }

  log(`upgrading unerr ${current} → ${target} (${cls.manager}, ${channel})`);

  // 1. Acquire the new binary.
  const acq = await acquireBinary(cls, target, opts);
  if (!acq.ok) {
    log(`  ✗ install failed: ${acq.output}`);
    if (cls.mode === "notify_only") {
      log(`  run manually: ${upgradeCommand(cls.manager, target)}`);
    }
    return {
      ...base,
      ok: false,
      to: target,
      upToDate: false,
      error: acq.output,
    };
  }
  log("  ✓ binary installed");

  // 2. Health-check the freshly-installed binary.
  if (!(await (opts.healthCheck ?? healthCheckBinary)(target))) {
    log(
      `  ⚠ new binary did not report ${target} — verify with \`unerr --version\``
    );
  }

  // 3. Reinstall agents across all registered repos (under the new binary).
  const reposReinstalled = reinstall ? await reinstallAllRepos(log) : [];

  // 4. Restart the runtime end-to-end.
  if (restart) await restartRuntime(log);

  log(`✓ unerr upgraded ${current} → ${target}`);
  return {
    ...base,
    ok: true,
    to: target,
    upToDate: false,
    reposReinstalled,
    restarted: restart,
  };
}
