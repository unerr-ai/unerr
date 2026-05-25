/**
 * unerrd HTTP API — served on port 9847 by the process manager.
 *
 * Route layout:
 *   /api/pm              — supervisor metadata (uptime, version, pid)
 *   /api/repos           — all registered repos with status
 *   /api/repos/aggregate — aggregated metrics across all running repos
 *   /api/repo/:label/*   — proxy to the per-repo HTTP API (token-flow, reasoning, etc.)
 *
 * Static assets (the React SPA) are served from the same dist/ui/ directory
 * used by per-repo dashboards. The SPA detects whether it's served by unerrd
 * (via /api/pm) and shows the global overview vs per-repo view.
 */

import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { clearDashboardState, writeDashboardState } from "./dashboard-state.js";
import type { ProcessManager } from "./process-manager.js";
import {
  DAEMON_DASHBOARD_PORT_SCAN_RANGE,
  DAEMON_DASHBOARD_PORT as DAEMON_PORT,
} from "./protocol.js";
import { listRepos, readNeedsInput } from "./registry.js";

export interface DaemonApiHandle {
  port: number;
  close: () => void;
  pushWarmStartEvent: (event: {
    repo: string;
    label: string;
    status: string;
    ms: number;
    reason?: string;
  }) => void;
}

export async function startDaemonApi(
  pm: ProcessManager
): Promise<DaemonApiHandle | null> {
  const app = new Hono();
  const startedAt = Date.now();
  // Set to the actually-bound port after the sliding-port scan; the /api/pm
  // route reads it lazily at request time, so it always reports reality.
  let boundPort = DAEMON_PORT;

  app.use("*", cors({ origin: "*" }));

  // ── /api/pm — supervisor metadata ───────────────────────────

  app.get("/api/pm", (c) => {
    return c.json({
      pid: process.pid,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      version: "0.1.0",
      port: boundPort,
    });
  });

  // ── /api/repos — all repos with live status ─────────────────

  app.get("/api/repos", (c) => {
    const repos = pm.getStatus();
    return c.json({ repos });
  });

  // ── /api/repos/aggregate — cross-repo metrics ───────────────

  app.get("/api/repos/aggregate", async (c) => {
    const repos = pm.getStatus();
    const running = repos.filter((r) => r.status === "running");

    let totalEntities = 0;
    let totalEdges = 0;
    let totalMemory = 0;
    let totalConnections = 0;
    let totalNeedsInput = 0;

    // Aggregate token-flow and reasoning data from running repos
    const tokenFlowAgg = { saved: 0, total: 0, violations: 0 };
    const reasoningAgg = { sessions: 0, avgQuality: 0, totalQualities: 0 };

    for (const repo of repos) {
      totalEntities += repo.entityCount ?? 0;
      totalEdges += repo.edgeCount ?? 0;
      totalMemory += repo.memory ?? 0;
      totalConnections += repo.connections;
      totalNeedsInput += repo.needsInput.length;
    }

    // Fetch per-repo stats from running processes' HTTP APIs
    const perRepoStats = await Promise.allSettled(
      running.map(async (repo) => {
        if (!repo.pid) return null;
        const managed = pm.getManaged(repo.path);
        if (!managed?.sock) return null;

        // Try to read server.json from the repo's .unerr/state/ to get its HTTP port
        const serverJsonPath = join(
          repo.path,
          ".unerr",
          "state",
          "server.json"
        );
        if (!existsSync(serverJsonPath)) return null;

        try {
          const serverInfo = JSON.parse(
            readFileSync(serverJsonPath, "utf-8")
          ) as {
            port: number;
          };

          const [sessionStats, tokenFlow] = await Promise.allSettled([
            fetchRepoApi(serverInfo.port, "/api/session/stats"),
            fetchRepoApi(serverInfo.port, "/api/token-flow/summary"),
          ]);

          return {
            label: repo.label,
            port: serverInfo.port,
            sessionStats:
              sessionStats.status === "fulfilled" ? sessionStats.value : null,
            tokenFlow:
              tokenFlow.status === "fulfilled" ? tokenFlow.value : null,
          };
        } catch {
          return null;
        }
      })
    );

    for (const result of perRepoStats) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const stats = result.value;

      if (stats.sessionStats) {
        const s = stats.sessionStats as {
          data?: {
            toolCallsLocal?: number;
            estimatedTokensSaved?: number;
            violationsCaught?: number;
          };
        };
        tokenFlowAgg.saved += s.data?.estimatedTokensSaved ?? 0;
        tokenFlowAgg.total += s.data?.toolCallsLocal ?? 0;
        tokenFlowAgg.violations += s.data?.violationsCaught ?? 0;
      }
    }

    return c.json({
      summary: {
        totalRepos: repos.length,
        runningRepos: running.length,
        stoppedRepos: repos.length - running.length,
        totalEntities,
        totalEdges,
        totalMemoryMb: totalMemory,
        totalConnections,
        totalNeedsInput,
      },
      tokenFlow: tokenFlowAgg,
      reasoning: reasoningAgg,
    });
  });

  // ── /api/pm/warm-start — warm-start status ──────────────────

  const warmStartEvents: Array<{
    repo: string;
    label: string;
    status: string;
    ms: number;
    reason?: string;
  }> = [];
  let warmStartLastRun: string | null = null;

  app.get("/api/pm/warm-start", async (c) => {
    let config = {
      warmStartBudget: 3,
      warmStartIdleDays: 14,
      warmStartDelayMs: 30_000,
    };
    try {
      const mod = await import("./warm-start.js");
      config = mod.loadWarmStartConfig();
    } catch {
      // Module not available
    }
    return c.json({
      lastRun: warmStartLastRun,
      events: warmStartEvents,
      config,
    });
  });

  // Public method for daemon.ts to push warm-start events
  const pushWarmStartEvent = (event: {
    repo: string;
    label: string;
    status: string;
    ms: number;
    reason?: string;
  }) => {
    warmStartEvents.push(event);
    warmStartLastRun = new Date().toISOString();
  };

  // ── /api/repo/:label/* — proxy to per-repo HTTP ─────────────

  app.all("/api/repo/:label/*", async (c) => {
    const label = c.req.param("label");
    const repos = listRepos();
    const repo = repos.find((r) => r.label === label);

    if (!repo) {
      return c.json({ error: `Unknown repo: ${label}` }, 404);
    }

    const managed = pm.getManaged(repo.path);
    if (!managed || managed.status !== "running") {
      return c.json(
        {
          error: `Repo ${label} is not running`,
          status: managed?.status ?? "stopped",
        },
        503
      );
    }

    // Read the repo's server.json for its HTTP port
    const serverJsonPath = join(repo.path, ".unerr", "state", "server.json");
    if (!existsSync(serverJsonPath)) {
      return c.json({ error: `Repo ${label} has no dashboard server` }, 503);
    }

    let repoPort: number;
    try {
      const info = JSON.parse(readFileSync(serverJsonPath, "utf-8")) as {
        port: number;
      };
      repoPort = info.port;
    } catch {
      return c.json({ error: `Cannot read server.json for ${label}` }, 500);
    }

    // Strip /api/repo/:label prefix and prepend /api so that
    // /api/repo/label/stats → /api/stats on the per-repo server.
    // Preserve query string — date filters, pagination, etc. are passed through.
    const remaining = c.req.path.replace(`/api/repo/${label}`, "");
    const qs = new URL(c.req.url).search;
    const targetPath = `/api${remaining || "/"}${qs}`;

    try {
      const proxyResponse = await proxyToRepoHttp(
        repoPort,
        targetPath,
        c.req.method
      );
      return c.json(proxyResponse);
    } catch (err) {
      return c.json({ error: `Proxy error: ${(err as Error).message}` }, 502);
    }
  });

  // ── Static SPA serving ──────────────────────────────────────

  const distDir = join(dirname(fileURLToPath(import.meta.url)), "ui");
  const spaIndex = join(distDir, "index.html");

  if (existsSync(spaIndex)) {
    const spaHtml = readFileSync(spaIndex, "utf-8");
    app.use("*", serveStatic({ root: distDir }));
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      return c.html(spaHtml);
    });
  } else {
    app.get("/", (c) => {
      return c.json({
        message: "unerrd dashboard API is running. UI not built yet.",
        hint: "Run 'pnpm run build' to build the dashboard SPA.",
        api: {
          pm: "/api/pm",
          repos: "/api/repos",
          aggregate: "/api/repos/aggregate",
          proxy: "/api/repo/<label>/api/...",
        },
      });
    });
  }

  // ── Start server (sliding port discovery) ───────────────────
  // @hono/node-server surfaces EADDRINUSE asynchronously via the underlying
  // server's 'error' event, not as a synchronous throw — so a try/catch around
  // serve() can't detect an occupied port. Instead pre-scan for a free port
  // with a throwaway net server (same pattern as src/server/http.ts) and bind
  // serve() to the port we just confirmed is free.

  const port = await findDaemonPort();
  if (port === 0) {
    process.stderr.write(
      `[unerrd] No free port in ${DAEMON_PORT}-${DAEMON_PORT + DAEMON_DASHBOARD_PORT_SCAN_RANGE}, skipping dashboard.\n`
    );
    return null;
  }
  boundPort = port;

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  });

  // Persist the bound port so `pm status`, `pm dashboard`, and the bridge
  // start message can surface the real URL even when the port slid off 9847.
  writeDashboardState(port);

  return {
    port,
    close: () => {
      try {
        (server as unknown as { close: () => void }).close();
      } catch {
        /* already closed */
      }
      clearDashboardState();
    },
    pushWarmStartEvent,
  };
}

/**
 * Scan from DAEMON_PORT upward for the first free loopback port. Returns 0 if
 * every port in the range is occupied (dashboard is non-critical — the daemon
 * still serves MCP over UDS without it).
 */
async function findDaemonPort(): Promise<number> {
  const end = DAEMON_PORT + DAEMON_DASHBOARD_PORT_SCAN_RANGE;
  for (let port = DAEMON_PORT; port <= end; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return 0;
}

// ── Helpers ───────────────────────────────────────────────────────

function fetchRepoApi(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", timeout: 3000 },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function proxyToRepoHttp(
  port: number,
  path: string,
  method: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method, timeout: 10_000 },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Proxy timeout"));
    });
    req.end();
  });
}
