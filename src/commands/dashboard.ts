/**
 * unerr dashboard — open the local intelligence dashboard in the default browser.
 *
 * Reads `.unerr/state/server.json` written by the in-process Hono server when the
 * proxy starts. If the proxy is not running, the file is absent and this command
 * explains how to start it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { openUrlInDefaultBrowser } from "../utils/exec.js";
import { isGitRepo } from "../utils/git.js";
import { startupLog } from "../utils/startup-log.js";

interface ServerJson {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
}

function readServerJson(cwd: string): ServerJson | null {
  const p = join(cwd, ".unerr", "state", "server.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as ServerJson;
  } catch {
    return null;
  }
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Open the local web dashboard in your browser")
    .action(async () => {
      const cwd = process.cwd();

      if (!(await isGitRepo(cwd))) {
        startupLog.error(
          "Not inside a git repository. Run from your project root.",
        );
        process.exit(1);
      }

      const server = readServerJson(cwd);
      if (!server?.url) {
        startupLog.warn("No dashboard metadata found.");
        startupLog.detail("Start the proxy with: unerr");
        startupLog.detail(
          "The dashboard URL appears when the HTTP server binds.",
        );
        process.exit(1);
      }

      try {
        await openUrlInDefaultBrowser(server.url);
        startupLog.done(`Opened ${server.url}`);
      } catch (err) {
        startupLog.error(
          err instanceof Error ? err.message : "Could not open browser.",
        );
        startupLog.detail(`Open manually: ${server.url}`);
        process.exit(1);
      }
    });
}
