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

    // A4: the Tier-2 passive auth surface for the dashboard header banner.
    // Same state machine the in-band signal and CLI status read — one truth.
    // Best-effort: a derivation failure must never break the status payload.
    let auth: {
      state: string;
      badge: string;
      plan: string;
      line: string;
      reconnect_by?: string;
      organization_id?: string;
      machine_name?: string;
    } | null = null;
    try {
      const { authState } = await import("../../cloud/auth-state.js");
      const { authBadge, authStateLine } = await import(
        "../../cloud/auth-surface.js"
      );
      const s = authState();
      auth = {
        state: s.state,
        badge: authBadge(s.state),
        plan: s.plan,
        line: authStateLine(s),
        reconnect_by: s.reconnect_by,
        organization_id: s.organization_id,
        machine_name: s.machine_name,
      };
    } catch {
      /* auth surface is additive — omit it rather than fail status */
    }

    // U3: the Tier-2 passive auto-update surface for the dashboard. Same
    // persisted state the in-band signal and CLI status read — one truth.
    // Best-effort: a derivation failure must never break the status payload.
    let update:
      | (ReturnType<
          typeof import("../../update/update-surface.js").updateStatusPanel
        > & { line: string })
      | null = null;
    try {
      const { updateStatusPanel, updateStatusLine } = await import(
        "../../update/update-surface.js"
      );
      update = { ...updateStatusPanel(), line: updateStatusLine() };
    } catch {
      /* update surface is additive — omit it rather than fail status */
    }

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
        auth,
        update,
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
        deps.cwd
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
