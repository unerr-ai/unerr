/**
 * `unerr pm` — CLI surface for process-manager management.
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
import { runEnvironmentChecks } from "./doctor.js";
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

export function registerPmCommand(program: Command): void {
  const pm = program
    .command("pm")
    .description("Manage the unerr process manager");

  // ── pm start ──────────────────────────────────────────

  pm
    .command("start")
    .description("Start the unerr process manager")
    .option("--foreground", "Run in foreground (blocks terminal — useful for debugging)")
    .option("--detached", "Run in-process as a detached supervisor (used by auto-spawn)")
    .action(async (opts: { foreground?: boolean; detached?: boolean }) => {
      if (opts.foreground || opts.detached) {
        // Run in-process. --detached is set when auto-spawn by the bridge; identical
        // behavior to --foreground except the parent (bridge) is already gone.
        process.title = "unerrd";
        const { startDaemon } = await import("../entrypoints/daemon.js");
        await startDaemon({ background: false });
        return;
      }

      // Default: spawn detached and return immediately
      const { spawn } = await import("node:child_process");
      const unerrBin = process.argv[1]!;
      const child = spawn(
        process.execPath,
        [unerrBin, "pm", "start", "--detached"],
        { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env } }
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

  // ── pm stop ───────────────────────────────────────────

  pm
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

  // ── pm add <path> ───────────────────────────────────────

  const addCmd = pm
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

  // ── pm remove <path> ────────────────────────────────────

  pm
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

  // ── pm status ───────────────────────────────────────────

  pm
    .command("status")
    .description("List all registered repos and their state")
    .action(async () => {
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

  // ── pm config <path> ────────────────────────────────────

  const configCmd = pm
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

  // ── pm logs ──────────────────────────────────────────────

  pm
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

  // ── pm dashboard ────────────────────────────────────────

  pm
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

  // ── pm config (global warm-start flags) ─────────────────

  pm
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

}

/** Convert camelCase key to kebab-case for CLI flags. */
function toKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
