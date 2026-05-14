/**
 * Layer 7: System status and configuration routes.
 *
 * GET /api/system/status  — Proxy state, uptime, PID, graph info
 * GET /api/system/config  — Repo config, IDE, installed skills
 */

import { Hono } from "hono";
import type { SessionStats } from "../../proxy/session-stats.js";

export interface SystemRouteDeps {
  /** Session stats (live counters) */
  stats: SessionStats;
  /** Current working directory */
  cwd: string;
  /** Dashboard server port */
  dashboardPort: number;
  /** Proxy start timestamp */
  startedAt: number;
  /** Graph entity count getter */
  getGraphStats: () => Promise<{
    entities: number;
    edges: number;
    rules: number;
  }>;
  /** IDE type detected */
  ide: string;
}

export function createSystemRoutes(deps: SystemRouteDeps): Hono {
  const app = new Hono();

  app.get("/status", async (c) => {
    const start = performance.now();
    const uptime = Math.round((Date.now() - deps.startedAt) / 1000);
    const graphStats = await deps.getGraphStats();

    return c.json({
      data: {
        status: "running",
        pid: process.pid,
        uptime_s: uptime,
        mode: "local",
        dashboard_port: deps.dashboardPort,
        cwd: deps.cwd,
        ide: deps.ide,
        graph: graphStats,
        session: {
          tool_calls: deps.stats.toolCallsLocal,
          tokens_saved: deps.stats.estimatedTokensSaved,
          violations_caught: deps.stats.violationsCaught,
          started_at: new Date(deps.stats.sessionStartedAt).toISOString(),
        },
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/config", async (c) => {
    const start = performance.now();
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    let config: Record<string, unknown> = {};
    const configPath = join(deps.cwd, ".unerr", "config.json");
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        config = { error: "unreadable" };
      }
    }

    // Detect installed skills
    let skills: string[] = [];
    try {
      const { listInstalledSkills } = await import("../../skills/resolver.js");
      skills = listInstalledSkills(
        deps.ide as "claude-code" | "cursor" | "vscode" | "windsurf" | "zed",
        deps.cwd,
      ).map((s) => s.name);
    } catch {
      // Skills module may not be available
    }

    return c.json({
      data: {
        repo_config: config,
        ide: deps.ide,
        skills_installed: skills,
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
