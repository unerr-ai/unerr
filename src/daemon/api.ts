/**
 * unerrd HTTP API — served on port 9847 by the daemon supervisor.
 *
 * Route layout:
 *   /api/daemon          — supervisor metadata (uptime, version, pid)
 *   /api/repos           — all registered repos with status
 *   /api/repos/aggregate — aggregated metrics across all running repos
 *   /api/repo/:label/*   — proxy to the per-repo HTTP API (token-flow, reasoning, etc.)
 *
 * Static assets (the React SPA) are served from the same dist/ui/ directory
 * used by per-repo dashboards. The SPA detects whether it's served by unerrd
 * (via /api/daemon) and shows the global overview vs per-repo view.
 */

import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProcessManager } from "./process-manager.js";
import { listRepos, readNeedsInput } from "./registry.js";

const DAEMON_PORT = 9847;

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

export function startDaemonApi(pm: ProcessManager): DaemonApiHandle | null {
  const app = new Hono();
  const startedAt = Date.now();

  app.use("*", cors({ origin: "*" }));

  // ── /api/daemon — supervisor metadata ───────────────────────

  app.get("/api/daemon", (c) => {
    return c.json({
      pid: process.pid,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      version: "0.1.0",
      port: DAEMON_PORT,
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
          "server.json",
        );
        if (!existsSync(serverJsonPath)) return null;

        try {
          const serverInfo = JSON.parse(
            readFileSync(serverJsonPath, "utf-8"),
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
      }),
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

  // ── /api/daemon/warm-start — warm-start status ───────────────

  const warmStartEvents: Array<{
    repo: string;
    label: string;
    status: string;
    ms: number;
    reason?: string;
  }> = [];
  let warmStartLastRun: string | null = null;

  app.get("/api/daemon/warm-start", async (c) => {
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

  // ── /api/daemon/version — update notification ────────────────

  app.get("/api/daemon/version", async (c) => {
    try {
      const { getCachedUpdateInfo } = await import("./version-checker.js");
      return c.json(getCachedUpdateInfo());
    } catch {
      return c.json({
        available: false,
        current: "0.0.1",
        latest: "0.0.1",
        behindMinor: 0,
        dismissed: false,
      });
    }
  });

  app.post("/api/daemon/version/dismiss", async (c) => {
    try {
      const body = await c.req.json<{ version: string }>();
      if (body.version) {
        const { dismissVersion } = await import("./version-checker.js");
        dismissVersion(body.version);
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 400);
    }
  });

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
        503,
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
    const remaining = c.req.path.replace(`/api/repo/${label}`, "");
    const targetPath = `/api${remaining || "/"}`;

    try {
      const proxyResponse = await proxyToRepoHttp(
        repoPort,
        targetPath,
        c.req.method,
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
          daemon: "/api/daemon",
          repos: "/api/repos",
          aggregate: "/api/repos/aggregate",
          proxy: "/api/repo/<label>/api/...",
        },
      });
    });
  }

  // ── Start server ────────────────────────────────────────────

  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      fetch: app.fetch,
      port: DAEMON_PORT,
      hostname: "127.0.0.1",
    });
  } catch {
    process.stderr.write(
      `[unerrd] Port ${DAEMON_PORT} occupied, skipping dashboard.\n`,
    );
    return null;
  }

  return {
    port: DAEMON_PORT,
    close: () => {
      try {
        (server as unknown as { close: () => void }).close();
      } catch {
        /* already closed */
      }
    },
    pushWarmStartEvent,
  };
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
      },
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
  method: string,
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
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Proxy timeout"));
    });
    req.end();
  });
}
