/**
 * `unerr daemon` — CLI surface for daemon management.
 *
 * Subcommands:
 *   start            Start the unerrd supervisor
 *   stop             Stop the unerrd supervisor
 *   add <path>       Register a repo with unerrd
 *   remove <path>    Unregister a repo
 *   status           List all registered repos + state
 *   config <path>    View/modify per-repo settings
 *
 * Registry operations (add/remove/config/status) work without a running unerrd.
 * Process management (start/stop) spawns or terminates the supervisor.
 */

import { resolve } from "node:path";
import type { Command } from "commander";
import { verifyUnerrOnPath } from "./doctor.js";
import {
  addRepo,
  findRepo,
  listRepos,
  readNeedsInput,
  removeRepo,
  updateRepoSettings,
} from "../daemon/registry.js";
import {
  SETTINGS_SCHEMA,
  parseSettingsFlags,
} from "../daemon/settings-schema.js";

const write = (msg: string) => process.stderr.write(msg);
const PACKAGE_NAME = "unerr";

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the unerr daemon registry");

  // ── daemon initialize ────────────────────────────────────────
  // One-time setup: registers unerrd at system boot + starts it now.

  daemon
    .command("initialize")
    .description(
      "One-time daemon setup: register at boot (launchd/systemd/schtasks) and start unerrd"
    )
    .action(async () => {
      verifyUnerrOnPath();

      const { installForCurrentPlatform } = await import(
        "../daemon/autostart.js"
      );
      const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");

      write("\x1b[38;2;139;92;246m▸\x1b[0m Initializing unerr daemon...\n");

      // 1. Register at boot
      const result = await installForCurrentPlatform();
      if (result.installed) {
        const sentinel = join(homedir(), ".unerr", ".autostart-installed");
        const dir = join(homedir(), ".unerr");
        mkdirSync(dir, { recursive: true });
        writeFileSync(sentinel, new Date().toISOString(), "utf-8");
        write(
          `\x1b[38;2;52;211;153m✓\x1b[0m Registered at boot: ${result.path}\n`
        );
      } else if (result.error) {
        write(
          `\x1b[38;2;251;191;36m⚠\x1b[0m Boot registration failed: ${result.error}\n`
        );
        write("  You can still use `unerr daemon start` to start manually.\n");
      }

      // 2. Check if daemon is already running (idempotent)
      const { daemonSockPath, probeDaemon } = await import(
        "../daemon/client.js"
      );
      const sock = daemonSockPath();
      if (await probeDaemon(sock)) {
        // Read the actual PID from the PID file
        const pidPath = join(homedir(), ".unerr", "unerrd.pid");
        let pidStr = "";
        try {
          const { readFileSync: readPid } = await import("node:fs");
          pidStr = readPid(pidPath, "utf-8").trim();
        } catch {
          /* fall through */
        }
        write(
          `\x1b[38;2;52;211;153m✓\x1b[0m unerrd is already running${pidStr ? ` (PID ${pidStr})` : ""}.\n\n`
        );
        write(
          "  Next steps:\n" +
            "    cd /path/to/your-project\n" +
            "    unerr install <agent>       # registers repo + installs MCP config\n\n"
        );
        return;
      }

      // 3. Spawn unerrd as a detached background process
      write("\x1b[38;2;139;92;246m▸\x1b[0m Starting unerrd...\n");
      const { spawn } = await import("node:child_process");
      const unerrBin = process.argv[1]!;
      const child = spawn(
        process.execPath,
        [unerrBin, "daemon", "start", "--foreground"],
        { detached: true, stdio: "ignore", env: { ...process.env } }
      );
      child.unref();

      // 4. Poll until socket is reachable
      const maxWait = 5000;
      const start = Date.now();
      let running = false;
      while (Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 150));
        if (await probeDaemon(sock)) {
          running = true;
          break;
        }
      }

      if (running) {
        // Read the actual PID from the PID file (not child.pid, which is the
        // spawner process — the real daemon may have a different PID)
        const pidPath = join(homedir(), ".unerr", "unerrd.pid");
        let daemonPid = String(child.pid);
        try {
          const { readFileSync: readPid } = await import("node:fs");
          daemonPid = readPid(pidPath, "utf-8").trim();
        } catch {
          /* fall back to child.pid */
        }
        write(
          `\x1b[38;2;52;211;153m✓\x1b[0m unerrd is running (PID ${daemonPid}).\n\n`
        );
        write(
          "  Next steps:\n" +
            "    cd /path/to/your-project\n" +
            "    unerr install <agent>       # registers repo + installs MCP config\n\n"
        );
      } else {
        write(
          "\x1b[38;2;248;113;113m✗\x1b[0m unerrd did not start in time. Check: ~/.unerr/logs/unerrd.log\n"
        );
        process.exitCode = 1;
      }
    });

  // ── daemon start ──────────────────────────────────────────

  daemon
    .command("start")
    .description("Start the unerrd supervisor (without boot registration)")
    .option("--foreground", "Run in foreground (blocks terminal)")
    .action(async (opts: { foreground?: boolean }) => {
      if (opts.foreground) {
        // Run in-process (for debugging or launchd/systemd which manage the lifecycle)
        const { startDaemon } = await import("../entrypoints/daemon.js");
        await startDaemon({ background: false });
        return;
      }

      // Default: spawn detached and return immediately
      const { spawn } = await import("node:child_process");
      const unerrBin = process.argv[1]!;
      const child = spawn(
        process.execPath,
        [unerrBin, "daemon", "start", "--foreground"],
        { detached: true, stdio: "ignore", env: { ...process.env } }
      );
      child.unref();

      // Poll until ready
      const { daemonSockPath, probeDaemon } = await import(
        "../daemon/client.js"
      );
      const sock = daemonSockPath();
      const maxWait = 5000;
      const startTime = Date.now();
      let running = false;
      while (Date.now() - startTime < maxWait) {
        await new Promise((r) => setTimeout(r, 150));
        if (await probeDaemon(sock)) {
          running = true;
          break;
        }
      }

      if (running) {
        // Read the actual PID from the PID file
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const pidPath = join(homedir(), ".unerr", "unerrd.pid");
        let daemonPid = String(child.pid);
        try {
          const { readFileSync } = await import("node:fs");
          daemonPid = readFileSync(pidPath, "utf-8").trim();
        } catch {
          /* fall back to child.pid */
        }
        write(
          `\x1b[38;2;52;211;153m✓\x1b[0m unerrd started (PID ${daemonPid}).\n`
        );
      } else {
        write(
          "\x1b[38;2;248;113;113m✗\x1b[0m unerrd did not start in time. Check: ~/.unerr/logs/unerrd.log\n"
        );
        process.exitCode = 1;
      }
    });

  // ── daemon stop ───────────────────────────────────────────

  daemon
    .command("stop")
    .description("Stop the unerrd supervisor")
    .action(async () => {
      const { createConnection } = await import("node:net");
      const { globalDir } = await import("../daemon/registry.js");
      const { join } = await import("node:path");
      const sock = join(globalDir(), "unerrd.sock");

      const { existsSync } = await import("node:fs");
      if (!existsSync(sock)) {
        write("unerrd is not running (no socket found).\n");
        return;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const conn = createConnection(sock, () => {
            conn.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
          });
          conn.on("data", () => {
            conn.destroy();
            resolve();
          });
          conn.on("error", (err) => reject(err));
          setTimeout(() => {
            conn.destroy();
            resolve();
          }, 3000);
        });
        write("\x1b[38;2;52;211;153m\u2713\x1b[0m unerrd stopped.\n");
      } catch {
        write(
          "\x1b[38;2;248;113;113m\u2717\x1b[0m Failed to connect to unerrd.\n"
        );
        process.exitCode = 1;
      }
    });

  // ── daemon teardown ──────────────────────────────────────────
  // Full inverse of `daemon initialize`: stop + deregister boot + optionally purge state.

  daemon
    .command("teardown")
    .description(
      "Remove unerr daemon completely: stop unerrd, deregister from boot, remove state"
    )
    .option("--purge", "Also delete ~/.unerr (logs, registry, cached data)")
    .action(async (opts: { purge?: boolean }) => {
      const { createConnection } = await import("node:net");
      const { existsSync, rmSync, unlinkSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");

      const home = join(homedir(), ".unerr");
      const sock = join(home, "unerrd.sock");
      let stopped = false;

      // 1. Stop unerrd if running
      if (existsSync(sock)) {
        write("\x1b[38;2;139;92;246m▸\x1b[0m Stopping unerrd...\n");
        try {
          await new Promise<void>((resolve, reject) => {
            const conn = createConnection(sock, () => {
              conn.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
            });
            conn.on("data", () => {
              conn.destroy();
              resolve();
            });
            conn.on("error", (err) => reject(err));
            setTimeout(() => {
              conn.destroy();
              resolve();
            }, 3000);
          });
          stopped = true;
          write("\x1b[38;2;52;211;153m✓\x1b[0m unerrd stopped.\n");
        } catch {
          write(
            "\x1b[38;2;251;191;36m⚠\x1b[0m Could not connect to unerrd (may already be stopped).\n"
          );
        }
      } else {
        write(
          "\x1b[38;2;34;211;238m▸\x1b[0m unerrd not running (no socket found).\n"
        );
      }

      // 2. Remove boot-time service registration
      write("\x1b[38;2;139;92;246m▸\x1b[0m Removing boot registration...\n");
      try {
        const { uninstallForCurrentPlatform, removeSentinel } = await import(
          "../daemon/autostart.js"
        );
        const result = await uninstallForCurrentPlatform();
        removeSentinel();
        if (result.error) {
          write(
            `\x1b[38;2;251;191;36m⚠\x1b[0m Boot service removal note: ${result.error}\n`
          );
        } else {
          write("\x1b[38;2;52;211;153m✓\x1b[0m Boot registration removed.\n");
        }
      } catch {
        write("\x1b[38;2;251;191;36m⚠\x1b[0m No boot registration found.\n");
      }

      // 3. Clean up PID file and socket
      const pidFile = join(home, "unerrd.pid");
      for (const f of [sock, pidFile]) {
        if (existsSync(f)) {
          try {
            unlinkSync(f);
          } catch {
            // best-effort
          }
        }
      }

      // 4. Optionally purge all state
      if (opts.purge) {
        write("\x1b[38;2;139;92;246m▸\x1b[0m Purging ~/.unerr...\n");
        if (existsSync(home)) {
          rmSync(home, { recursive: true, force: true });
          write("\x1b[38;2;52;211;153m✓\x1b[0m ~/.unerr removed.\n");
        }
      }

      write(
        `\n\x1b[38;2;52;211;153m✓\x1b[0m Daemon teardown complete.${
          opts.purge
            ? ""
            : " Registry and logs preserved in ~/.unerr (use --purge to remove)."
        }\n`
      );

      if (!opts.purge) {
        write("\n  To re-initialize: \x1b[1munerr daemon initialize\x1b[0m\n");
      }
    });

  // ── daemon add <path> ───────────────────────────────────────

  const addCmd = daemon
    .command("add [path]")
    .description("Register a repo with unerrd")
    .option(
      "--skip-parent-check",
      "Allow registration even if parent dir is registered"
    )
    .option(
      "--skip-child-check",
      "Allow registration even if subdirectories are registered"
    );

  for (const s of SETTINGS_SCHEMA) {
    addCmd.option(`--${s.flag} <value>`, s.description);
  }

  addCmd.action(
    async (
      pathArg: string | undefined,
      opts: Record<string, string | undefined> & {
        skipParentCheck?: boolean;
        skipChildCheck?: boolean;
      }
    ) => {
      const targetPath = resolve(pathArg ?? ".");

      // Parse and validate settings flags
      const settingsRaw: Record<string, string | undefined> = {};
      for (const s of SETTINGS_SCHEMA) {
        const camelFlag = s.flag.replace(/-([a-z])/g, (_, c: string) =>
          c.toUpperCase()
        );
        if (opts[camelFlag] !== undefined) {
          settingsRaw[s.flag] = opts[camelFlag];
        }
      }

      let settings: Record<string, string | number | boolean>;
      try {
        settings = parseSettingsFlags(settingsRaw);
      } catch (err) {
        write(
          `\x1b[38;2;248;113;113m\u2717\x1b[0m ${(err as Error).message}\n`
        );
        process.exitCode = 1;
        return;
      }

      const result = addRepo(targetPath, settings, {
        skipParentCheck: opts.skipParentCheck,
        skipChildCheck: opts.skipChildCheck,
      });

      if (!result.ok) {
        write(`\x1b[38;2;248;113;113m\u2717\x1b[0m ${result.error}\n`);
        if (result.parentConflict) {
          write(
            `  Parent: ${result.parentConflict}\n  Use --skip-parent-check to override.\n`
          );
        }
        if (result.childConflicts) {
          write(
            `  Children: ${result.childConflicts.join(", ")}\n  Use --skip-child-check to override.\n`
          );
        }
        process.exitCode = 1;
        return;
      }

      if (result.created) {
        write(
          `\x1b[38;2;52;211;153m\u2713\x1b[0m Registered \x1b[1m${result.entry.label}\x1b[0m (${result.entry.path})\n`
        );
        const keys = Object.keys(settings);
        if (keys.length > 0) {
          write(
            `  Settings: ${keys.map((k) => `${k}=${settings[k]}`).join(", ")}\n`
          );
        }
      } else {
        write(
          `\x1b[38;2;251;191;36m\u25c6\x1b[0m Already registered: \x1b[1m${result.entry.label}\x1b[0m\n`
        );
      }
    }
  );

  // ── daemon remove <path> ────────────────────────────────────

  daemon
    .command("remove [path]")
    .description("Unregister a repo from unerrd")
    .action((pathArg: string | undefined) => {
      const targetPath = resolve(pathArg ?? ".");
      const removed = removeRepo(targetPath);
      if (removed) {
        write(`\x1b[38;2;52;211;153m\u2713\x1b[0m Removed ${targetPath}\n`);
      } else {
        write(
          `\x1b[38;2;248;113;113m\u2717\x1b[0m Not registered: ${targetPath}\n`
        );
        process.exitCode = 1;
      }
    });

  // ── daemon status ───────────────────────────────────────────

  daemon
    .command("status")
    .description("List all registered repos and their state")
    .action(async () => {
      // Show update banner if available
      try {
        const { getCachedUpdateInfo } = await import(
          "../daemon/version-checker.js"
        );
        const info = getCachedUpdateInfo();
        if (info.available && !info.dismissed) {
          write(
            `\n  \x1b[38;2;34;211;238m▸\x1b[0m Update available: \x1b[1m${info.current}\x1b[0m → \x1b[1m${info.latest}\x1b[0m — run \x1b[38;2;139;92;246munerr daemon update\x1b[0m\n`
          );
        }
      } catch {
        // Non-blocking
      }

      const repos = listRepos();
      if (repos.length === 0) {
        write("No repos registered. Use `unerr daemon add .` to register.\n");
        return;
      }

      // Try to get live status from daemon API when daemon is running
      let liveStatus: Map<
        string,
        {
          status: string;
          pid: number | null;
          connections: number;
          idle: number | null;
          memory: number | null;
        }
      > | null = null;
      try {
        const { daemonSockPath, probeDaemon } = await import(
          "../daemon/client.js"
        );
        const sock = daemonSockPath();
        if (await probeDaemon(sock)) {
          const { request } = await import("node:http");
          const body = await new Promise<string>((resolveReq, rejectReq) => {
            const req = request(
              {
                hostname: "127.0.0.1",
                port: 9847,
                path: "/api/repos",
                method: "GET",
                timeout: 2000,
              },
              (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => {
                  data += chunk.toString();
                });
                res.on("end", () => resolveReq(data));
              }
            );
            req.on("error", rejectReq);
            req.on("timeout", () => {
              req.destroy();
              rejectReq(new Error("timeout"));
            });
            req.end();
          });
          const parsed = JSON.parse(body) as {
            repos: Array<{
              path: string;
              status: string;
              pid: number | null;
              connections: number;
              idle: number | null;
              memory: number | null;
            }>;
          };
          liveStatus = new Map();
          for (const r of parsed.repos) {
            liveStatus.set(r.path, {
              status: r.status,
              pid: r.pid,
              connections: r.connections,
              idle: r.idle,
              memory: r.memory,
            });
          }
        }
      } catch {
        // Daemon API unavailable — fall back to file-based display
      }

      write(
        `\n  \x1b[1munerr daemon\x1b[0m — ${repos.length} repo${repos.length === 1 ? "" : "s"} registered\n\n`
      );

      for (const repo of repos) {
        const needsInput = readNeedsInput(repo.path);
        const idleLabel =
          repo.idleTimeout === 0 ? "never" : `${repo.idleTimeout}s`;

        const live = liveStatus?.get(repo.path);
        const isRunning =
          live?.status === "running" || live?.status === "starting";
        const statusIcon = isRunning
          ? "\x1b[38;2;52;211;153m●\x1b[0m"
          : "\u25cb";
        const statusSuffix = live
          ? ` \x1b[2m(${live.status}${live.pid ? `, PID ${live.pid}` : ""}${live.connections ? `, ${live.connections} conn` : ""}${live.idle != null ? `, idle ${live.idle}s` : ""})\x1b[0m`
          : "";

        write(
          `  ${statusIcon} \x1b[1m${repo.label}\x1b[0m${statusSuffix}\n` +
            `    Path: ${repo.path}\n` +
            `    Idle timeout: ${idleLabel}\n` +
            `    Added: ${repo.addedAt}\n`
        );

        const settingsEntries = Object.entries(repo.settings).filter(
          ([, v]) => v !== undefined
        );
        if (settingsEntries.length > 0) {
          write(
            `    Settings: ${settingsEntries.map(([k, v]) => `${k}=${v}`).join(", ")}\n`
          );
        }

        if (needsInput.length > 0) {
          write("    \x1b[38;2;251;191;36m⚠\x1b[0m Needs input:\n");
          for (const ni of needsInput) {
            write(
              `      ${ni.key}: auto-selected \x1b[1m${ni.auto}\x1b[0m (${ni.reason})\n` +
                `        Alternatives: ${ni.alternatives.join(", ")}\n` +
                `        Override: unerr daemon config ${repo.path} --${toKebab(ni.key)}=${ni.alternatives[0]}\n`
            );
          }
        }

        write("\n");
      }
    });

  // ── daemon config <path> ────────────────────────────────────

  const configCmd = daemon
    .command("config [path]")
    .description("View or modify per-repo settings")
    .option("--show", "Show current settings without modifying");

  for (const s of SETTINGS_SCHEMA) {
    configCmd.option(`--${s.flag} <value>`, s.description);
  }

  configCmd.action(
    (
      pathArg: string | undefined,
      opts: Record<string, string | undefined> & { show?: boolean }
    ) => {
      const targetPath = resolve(pathArg ?? ".");

      // Collect setting flags
      const settingsRaw: Record<string, string | undefined> = {};
      for (const s of SETTINGS_SCHEMA) {
        const camelFlag = s.flag.replace(/-([a-z])/g, (_, c: string) =>
          c.toUpperCase()
        );
        if (opts[camelFlag] !== undefined) {
          settingsRaw[s.flag] = opts[camelFlag];
        }
      }

      const hasSettingFlags = Object.keys(settingsRaw).length > 0;

      if (opts.show || !hasSettingFlags) {
        // Show mode
        const entry = findRepo(targetPath);
        if (!entry) {
          write(
            `\x1b[38;2;248;113;113m\u2717\x1b[0m Not registered: ${targetPath}\n` +
              `  Register first: unerr daemon add ${targetPath}\n`
          );
          process.exitCode = 1;
          return;
        }

        write(
          `\n  \x1b[1m${entry.label}\x1b[0m — ${entry.path}\n\n` +
            `  Idle timeout: ${entry.idleTimeout === 0 ? "never" : `${entry.idleTimeout}s`}\n` +
            `  Added: ${entry.addedAt}\n`
        );

        const settingsEntries = Object.entries(entry.settings).filter(
          ([, v]) => v !== undefined
        );
        if (settingsEntries.length > 0) {
          write("  Settings:\n");
          for (const [k, v] of settingsEntries) {
            write(`    ${k}: ${v}\n`);
          }
        }

        const needsInput = readNeedsInput(entry.path);
        if (needsInput.length > 0) {
          write(
            "\n  \x1b[38;2;251;191;36m⚠ Auto-detected picks (override with flags):\x1b[0m\n"
          );
          for (const ni of needsInput) {
            write(
              `    ${ni.key}: ${ni.auto} (${ni.reason})\n` +
                `      Override: --${toKebab(ni.key)}=${ni.alternatives[0]}\n`
            );
          }
        }

        write("\n");
        return;
      }

      // Modify mode
      let parsed: Record<string, string | number | boolean>;
      try {
        parsed = parseSettingsFlags(settingsRaw);
      } catch (err) {
        write(
          `\x1b[38;2;248;113;113m\u2717\x1b[0m ${(err as Error).message}\n`
        );
        process.exitCode = 1;
        return;
      }

      const updated = updateRepoSettings(targetPath, parsed);
      if (!updated) {
        write(
          `\x1b[38;2;248;113;113m\u2717\x1b[0m Not registered: ${targetPath}\n` +
            `  Register first: unerr daemon add ${targetPath}\n`
        );
        process.exitCode = 1;
        return;
      }

      write(
        `\x1b[38;2;52;211;153m\u2713\x1b[0m Updated \x1b[1m${updated.label}\x1b[0m: ${Object.entries(
          parsed
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}\n`
      );
    }
  );

  // ── daemon autostart on|off|status ──────────────────────────

  daemon
    .command("autostart <action>")
    .description("Manage platform auto-start (on|off|status)")
    .action(async (action: string) => {
      const validActions = ["on", "off", "status"];
      if (!validActions.includes(action)) {
        write(
          `\x1b[38;2;248;113;113m\u2717\x1b[0m Invalid action "${action}". Valid: ${validActions.join(", ")}\n`
        );
        process.exitCode = 1;
        return;
      }

      if (action === "status") {
        const { getAutostartStatus, isAutostartInstalled } = await import(
          "../daemon/autostart.js"
        );
        const status = await getAutostartStatus();
        const { loadWarmStartConfig } = await import("../daemon/warm-start.js");
        const config = loadWarmStartConfig();
        const repos = listRepos();
        const autostartRepos = repos.filter(
          (r) => (r.settings?.autostart ?? "auto") !== "never"
        );

        write("\n  \x1b[1munerr daemon autostart\x1b[0m\n\n");
        write(`  Platform:     ${status.platform}\n`);
        write(
          `  Service:      ${status.installed ? "\x1b[38;2;52;211;153m●\x1b[0m installed" : "\x1b[38;2;248;113;113m●\x1b[0m not installed"}\n`
        );
        write(`  Warm budget:  ${config.warmStartBudget}\n`);
        write(`  Idle cutoff:  ${config.warmStartIdleDays} days\n`);
        write(`  Boot delay:   ${config.warmStartDelayMs}ms\n`);
        write(
          `  Repos:        ${autostartRepos.length}/${repos.length} eligible\n\n`
        );

        if (repos.length > 0) {
          write("  Per-repo autostart policies:\n");
          for (const r of repos) {
            const policy = r.settings?.autostart ?? "auto";
            const icon =
              policy === "never"
                ? "\x1b[38;2;248;113;113m●\x1b[0m"
                : policy === "eager"
                  ? "\x1b[38;2;52;211;153m●\x1b[0m"
                  : "\x1b[38;2;251;191;36m●\x1b[0m";
            write(`    ${icon} ${r.label}: ${policy}\n`);
          }
          write("\n");
        }
        return;
      }

      if (action === "on") {
        const { installForCurrentPlatform } = await import(
          "../daemon/autostart.js"
        );
        const result = await installForCurrentPlatform();
        if (result.installed) {
          // Write sentinel
          const {
            existsSync: ex,
            mkdirSync: mk,
            writeFileSync: wf,
          } = await import("node:fs");
          const { homedir: hd } = await import("node:os");
          const { join: jn } = await import("node:path");
          const sentinel = jn(hd(), ".unerr", ".autostart-installed");
          mk(jn(hd(), ".unerr"), { recursive: true });
          wf(sentinel, new Date().toISOString(), "utf-8");
          write(
            `\x1b[38;2;52;211;153m\u2713\x1b[0m Auto-start enabled (${result.path})\n`
          );
        } else {
          write(
            `\x1b[38;2;248;113;113m\u2717\x1b[0m Failed: ${result.error}\n`
          );
          process.exitCode = 1;
        }
        return;
      }

      if (action === "off") {
        const { uninstallForCurrentPlatform, removeSentinel } = await import(
          "../daemon/autostart.js"
        );
        const result = await uninstallForCurrentPlatform();
        removeSentinel();
        write(
          `\x1b[38;2;52;211;153m\u2713\x1b[0m Auto-start disabled${result.error ? ` (note: ${result.error})` : ""}\n`
        );
      }
    });

  // ── daemon logs ──────────────────────────────────────────────

  daemon
    .command("logs")
    .description("Tail daemon and repo log files")
    .option("--repo <label>", "Filter to a specific repo by label")
    .option("--bridge", "Include bridge session logs")
    .option("--follow", "Follow log output (tail -f)")
    .option("-n <lines>", "Number of lines to show", "50")
    .option("--boot", "Show only entries from this boot cycle")
    .action(
      async (opts: {
        repo?: string;
        bridge?: boolean;
        follow?: boolean;
        n?: string;
        boot?: boolean;
      }) => {
        const {
          existsSync: ex,
          readFileSync: rf,
          readdirSync: rd,
        } = await import("node:fs");
        const { homedir: hd } = await import("node:os");
        const { join: jn } = await import("node:path");
        const { spawn } = await import("node:child_process");

        const lines = Number.parseInt(opts.n ?? "50", 10) || 50;
        const logFiles: string[] = [];

        // Supervisor log
        const daemonLog = jn(hd(), ".unerr", "logs", "unerrd.log");
        if (!opts.repo && ex(daemonLog)) logFiles.push(daemonLog);

        // Per-repo logs
        const repos = listRepos();
        const filteredRepos = opts.repo
          ? repos.filter((r) => r.label === opts.repo)
          : repos;

        for (const r of filteredRepos) {
          const repoLog = jn(r.path, ".unerr", "logs", "unerr.log");
          if (ex(repoLog)) logFiles.push(repoLog);

          if (opts.bridge) {
            const logsDir = jn(r.path, ".unerr", "logs");
            if (ex(logsDir)) {
              try {
                const bridgeLogs = rd(logsDir).filter((f: string) =>
                  f.startsWith("mcp-")
                );
                for (const bl of bridgeLogs) {
                  logFiles.push(jn(logsDir, bl));
                }
              } catch {
                // Permission or read error
              }
            }
          }
        }

        if (logFiles.length === 0) {
          write("No log files found.\n");
          return;
        }

        if (opts.follow) {
          const child = spawn(
            "tail",
            ["-f", "-n", String(lines), ...logFiles],
            {
              stdio: ["ignore", "inherit", "inherit"],
            }
          );
          await new Promise<void>((resolve) => {
            child.on("close", () => resolve());
            process.on("SIGINT", () => {
              child.kill("SIGTERM");
              resolve();
            });
          });
          return;
        }

        // Static mode — read last N lines from each file
        for (const file of logFiles) {
          try {
            const content = rf(file, "utf-8");
            let fileLines = content.split("\n");

            if (opts.boot) {
              // Find last boot marker
              const bootIdx = fileLines.findLastIndex((l: string) =>
                l.includes("Started (PID")
              );
              if (bootIdx >= 0) fileLines = fileLines.slice(bootIdx);
            }

            const tail = fileLines.slice(-lines).join("\n");
            write(`\x1b[38;2;139;92;246m▸\x1b[0m ${file}\n${tail}\n\n`);
          } catch {
            write(
              `\x1b[38;2;248;113;113m\u2717\x1b[0m Could not read: ${file}\n`
            );
          }
        }
      }
    );

  // ── daemon dashboard ────────────────────────────────────────

  daemon
    .command("dashboard")
    .description("Open the unerr dashboard in browser")
    .option("--port <port>", "Dashboard port (default: 9847)")
    .action(async (opts: { port?: string }) => {
      const port = opts.port ?? "9847";
      const url = `http://localhost:${port}`;

      const { platform } = await import("node:os");
      const { execSync: ex } = await import("node:child_process");

      try {
        const plat = platform();
        if (plat === "darwin") {
          ex(`open "${url}"`, { stdio: "ignore" });
        } else if (plat === "linux") {
          ex(`xdg-open "${url}"`, { stdio: "ignore" });
        } else if (plat === "win32") {
          ex(`start "" "${url}"`, { stdio: "ignore" });
        } else {
          write(`Open ${url} in your browser.\n`);
          return;
        }
        write(`\x1b[38;2;52;211;153m\u2713\x1b[0m Opening ${url}\n`);
      } catch {
        write(`Open ${url} in your browser.\n`);
      }
    });

  // ── daemon config (global warm-start flags) ─────────────────

  daemon
    .command("set")
    .description("Set global daemon configuration")
    .option(
      "--warm-start-budget <n>",
      "Max repos to warm-start on boot (0=disabled)"
    )
    .option("--warm-start-idle-days <n>", "Skip repos inactive for N+ days")
    .option("--warm-start-delay-ms <n>", "Delay after boot before warm-start")
    .action(
      async (opts: {
        warmStartBudget?: string;
        warmStartIdleDays?: string;
        warmStartDelayMs?: string;
      }) => {
        const { saveWarmStartConfig } = await import("../daemon/warm-start.js");

        const partial: Record<string, number> = {};
        let anySet = false;

        if (opts.warmStartBudget !== undefined) {
          const n = Number.parseInt(opts.warmStartBudget, 10);
          if (!Number.isFinite(n) || n < 0) {
            write(
              `\x1b[38;2;248;113;113m\u2717\x1b[0m Invalid warm-start-budget: ${opts.warmStartBudget}\n`
            );
            process.exitCode = 1;
            return;
          }
          partial.warmStartBudget = n;
          anySet = true;
        }

        if (opts.warmStartIdleDays !== undefined) {
          const n = Number.parseInt(opts.warmStartIdleDays, 10);
          if (!Number.isFinite(n) || n < 0) {
            write(
              `\x1b[38;2;248;113;113m\u2717\x1b[0m Invalid warm-start-idle-days: ${opts.warmStartIdleDays}\n`
            );
            process.exitCode = 1;
            return;
          }
          partial.warmStartIdleDays = n;
          anySet = true;
        }

        if (opts.warmStartDelayMs !== undefined) {
          const n = Number.parseInt(opts.warmStartDelayMs, 10);
          if (!Number.isFinite(n) || n < 0) {
            write(
              `\x1b[38;2;248;113;113m\u2717\x1b[0m Invalid warm-start-delay-ms: ${opts.warmStartDelayMs}\n`
            );
            process.exitCode = 1;
            return;
          }
          partial.warmStartDelayMs = n;
          anySet = true;
        }

        if (!anySet) {
          // Show current config
          const { loadWarmStartConfig } = await import(
            "../daemon/warm-start.js"
          );
          const config = loadWarmStartConfig();
          write("\n  \x1b[1mGlobal daemon config\x1b[0m\n\n");
          write(`  warmStartBudget:   ${config.warmStartBudget}\n`);
          write(`  warmStartIdleDays: ${config.warmStartIdleDays}\n`);
          write(`  warmStartDelayMs:  ${config.warmStartDelayMs}\n\n`);
          return;
        }

        saveWarmStartConfig(partial);
        write(
          `\x1b[38;2;52;211;153m\u2713\x1b[0m Updated: ${Object.entries(partial)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}\n`
        );
      }
    );

  // ── daemon update ───────────────────────────────────────────

  daemon
    .command("update")
    .description("Check for and apply unerr updates")
    .option("--check", "Only check, don't install")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { check?: boolean; yes?: boolean }) => {
      const { checkForUpdate, getInstalledVersion } = await import(
        "../daemon/version-checker.js"
      );

      write("\x1b[38;2;139;92;246m▸\x1b[0m Checking for updates...\n");
      const info = await checkForUpdate();

      if (!info.available) {
        write(
          `\x1b[38;2;52;211;153m\u2713\x1b[0m unerr is up to date (${info.current})\n`
        );
        return;
      }

      write(
        `\n  \x1b[1mUpdate available\x1b[0m\n\n  Current: ${info.current}\n  Latest:  \x1b[38;2;34;211;238m${info.latest}\x1b[0m\n  Behind:  ${info.behindMinor} minor version${info.behindMinor !== 1 ? "s" : ""}\n\n`
      );

      if (opts.check) return;

      // Confirmation prompt (skip with --yes)
      if (!opts.yes) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(
            `  Update unerr ${info.current} → ${info.latest}? [y/N] `,
            (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            }
          );
        });

        if (answer !== "y" && answer !== "yes") {
          write("  Cancelled.\n");
          return;
        }
      }

      write("\n");

      // Step 1: Stop unerrd if running
      write("  [1/5] Stopping unerrd...\n");
      try {
        const { createConnection } = await import("node:net");
        const { globalDir } = await import("../daemon/registry.js");
        const { join } = await import("node:path");
        const sock = join(globalDir(), "unerrd.sock");
        const { existsSync } = await import("node:fs");

        if (existsSync(sock)) {
          await new Promise<void>((resolve) => {
            const conn = createConnection(sock, () => {
              conn.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
            });
            conn.on("data", () => {
              conn.destroy();
              resolve();
            });
            conn.on("error", () => resolve());
            setTimeout(() => {
              conn.destroy();
              resolve();
            }, 5000);
          });
          // Wait for process to fully exit
          await new Promise<void>((r) => setTimeout(r, 2000));
        }
        write("        \x1b[38;2;52;211;153m\u2713\x1b[0m stopped\n");
      } catch {
        write("        \x1b[38;2;251;191;36m⚠\x1b[0m already stopped\n");
      }

      // Step 2: Detect package manager and install
      write("  [2/5] Installing update...\n");
      const { execSync } = await import("node:child_process");
      const { existsSync: exists } = await import("node:fs");

      let installCmd: string;
      const target = `${PACKAGE_NAME}@${info.latest}`;

      // Detect how unerr was installed
      if (process.env.npm_config_global_prefix) {
        installCmd = `npm install -g ${target}`;
      } else {
        try {
          const pnpmGlobal = execSync("pnpm root -g", {
            encoding: "utf-8",
          }).trim();
          if (pnpmGlobal && process.argv[1]?.includes("pnpm")) {
            installCmd = `pnpm add -g ${target}`;
          } else {
            installCmd = `npm install -g ${target}`;
          }
        } catch {
          installCmd = `npm install -g ${target}`;
        }
      }

      try {
        execSync(installCmd, { stdio: "pipe", timeout: 120_000 });
        write(`        \x1b[38;2;52;211;153m\u2713\x1b[0m ${installCmd}\n`);
      } catch (err) {
        write(
          `        \x1b[38;2;248;113;113m\u2717\x1b[0m Install failed: ${(err as Error).message}\n` +
            `        Try manually: ${installCmd}\n`
        );
        process.exitCode = 1;
        return;
      }

      // Step 3: Verify new version
      write("  [3/5] Verifying...\n");
      try {
        const unerrBin = process.argv[1] ?? "unerr";
        const newVer = execSync(`"${unerrBin}" --version`, {
          encoding: "utf-8",
        }).trim();
        write(`        \x1b[38;2;52;211;153m\u2713\x1b[0m ${newVer}\n`);
      } catch {
        write(
          "        \x1b[38;2;251;191;36m⚠\x1b[0m Could not verify version\n"
        );
      }

      // Step 4: Restart unerrd
      write("  [4/5] Restarting unerrd...\n");
      try {
        const { spawn } = await import("node:child_process");
        const child = spawn(
          process.execPath,
          [process.argv[1]!, "daemon", "start", "--background"],
          { detached: true, stdio: "ignore" }
        );
        child.unref();
        await new Promise<void>((r) => setTimeout(r, 3000));
        write("        \x1b[38;2;52;211;153m\u2713\x1b[0m started\n");
      } catch {
        write(
          "        \x1b[38;2;251;191;36m⚠\x1b[0m Manual restart: unerr daemon start\n"
        );
      }

      // Step 5: Health check
      write("  [5/5] Health check...\n");
      try {
        const { probeDaemon } = await import("../daemon/client.js");
        const { globalDir } = await import("../daemon/registry.js");
        const { join } = await import("node:path");
        const sock = join(globalDir(), "unerrd.sock");
        const healthy = await probeDaemon(sock);
        if (healthy) {
          write("        \x1b[38;2;52;211;153m\u2713\x1b[0m healthy\n");
        } else {
          write(
            "        \x1b[38;2;251;191;36m⚠\x1b[0m daemon not yet responsive\n"
          );
        }
      } catch {
        write("        \x1b[38;2;251;191;36m⚠\x1b[0m could not reach daemon\n");
      }

      write(
        `\n  \x1b[38;2;52;211;153m\u2713\x1b[0m Updated to \x1b[1m${info.latest}\x1b[0m\n\n`
      );
    });

  // ── daemon dismiss-update ───────────────────────────────────

  daemon
    .command("dismiss-update <version>")
    .description("Dismiss update notification for a specific version")
    .action(async (version: string) => {
      const { dismissVersion } = await import("../daemon/version-checker.js");
      dismissVersion(version);
      write(
        `\x1b[38;2;52;211;153m\u2713\x1b[0m Dismissed update notification for v${version.replace(/^v/, "")}\n`
      );
    });
}

/** Convert camelCase key to kebab-case for CLI flags. */
function toKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
