/**
 * Layer 7: Hono HTTP server factory for the intelligence dashboard.
 *
 * Serves:
 *   /api/system/*       — Proxy status and configuration
 *   /api/intelligence/* — Graph, health, entity, causal, durability
 *   /api/session/*      — Session stats, efficiency, intents, ledger
 *   /api/stream         — SSE real-time event transport
 *   /assets/*      — Vite-built SPA static assets (production)
 *   /*             — SPA fallback (index.html)
 *
 * Bound strictly to 127.0.0.1 — localhost only, no network exposure.
 * Runs inside the same process as the MCP proxy for direct memory access.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  cacheMiddleware,
  corsMiddleware,
  errorMiddleware,
  timingMiddleware,
} from "./middleware.js";
import { createDriftRoutes } from "./routes/drift.js";
import {
  type IntelligenceRouteDeps,
  createIntelligenceRoutes,
} from "./routes/intelligence.js";
import {
  type ReasoningQualityRouteDeps,
  createReasoningQualityRoutes,
} from "./routes/reasoning-quality.js";
import {
  type SessionRouteDeps,
  createSessionRoutes,
} from "./routes/session.js";
import { type StreamRouteDeps, createStreamRoutes } from "./routes/stream.js";
import { type SystemRouteDeps, createSystemRoutes } from "./routes/system.js";
import {
  type TemporalRouteDeps,
  createTemporalRoutes,
} from "./routes/temporal.js";
import {
  type TimelineRouteDeps,
  createTimelineRoutes,
} from "./routes/timeline.js";
import {
  type TokenFlowRouteDeps,
  createTokenFlowRoutes,
} from "./routes/token-flow.js";

export interface DashboardServerOptions {
  /** Dependencies for system routes */
  system: SystemRouteDeps;
  /** Dependencies for SSE stream */
  stream: StreamRouteDeps;
  /** Dependencies for intelligence API */
  intelligence: IntelligenceRouteDeps;
  /** Dependencies for session API */
  session: SessionRouteDeps;
  /** Layer 9: Dependencies for temporal intelligence API (facts, sessions) */
  temporal?: TemporalRouteDeps;
  /** ST-1d: Timeline subsystem (mounted only if UNERR_TIMELINE_V2 != "0") */
  timeline?: TimelineRouteDeps;
  /** Layer 10: Dependencies for token flow API */
  tokenFlow?: TokenFlowRouteDeps;
  /** Dependencies for reasoning quality API (reuses token flow deps) */
  reasoningQuality?: ReasoningQualityRouteDeps;
  /** Path to .unerr/state/ for server.json */
  stateDir: string;
  /** When true, skip SPA static files — serve API routes only (daemon children). */
  apiOnly?: boolean;
}

export interface DashboardServerHandle {
  /** Resolved port the server is listening on */
  port: number;
  /** Graceful shutdown */
  close: () => void;
}

const PORT_START = 7600;
const PORT_END = 7700;

/**
 * Find an available port in the 7655-7660 range.
 * Returns 0 if all ports are occupied.
 */
async function findAvailablePort(): Promise<number> {
  for (let port = PORT_START; port <= PORT_END; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  return 0;
}

/**
 * Create and start the dashboard HTTP server.
 * Non-blocking: returns null if no port available (dashboard is non-critical).
 */
export async function startDashboardServer(
  opts: DashboardServerOptions
): Promise<DashboardServerHandle | null> {
  const port = await findAvailablePort();
  if (port === 0) {
    process.stderr.write(
      "[dashboard] All ports 7655-7660 occupied, skipping dashboard server.\n"
    );
    return null;
  }

  // Update the system route deps with the resolved port
  opts.system.dashboardPort = port;

  const app = new Hono();

  // Middleware stack
  app.use("*", corsMiddleware);
  app.use("*", cacheMiddleware);
  app.use("*", timingMiddleware);
  app.use("*", errorMiddleware);

  // API routes
  app.route("/api/system", createSystemRoutes(opts.system));
  app.route("/api/drift", createDriftRoutes({ cwd: opts.system.cwd }));
  app.route("/api/intelligence", createIntelligenceRoutes(opts.intelligence));
  app.route("/api/session", createSessionRoutes(opts.session));
  app.route("/api/stream", createStreamRoutes(opts.stream));
  if (opts.temporal) {
    app.route("", createTemporalRoutes(opts.temporal));
  }
  if (opts.timeline) {
    app.route("/api/timeline", createTimelineRoutes(opts.timeline));
  }
  if (opts.tokenFlow) {
    app.route("/api/token-flow", createTokenFlowRoutes(opts.tokenFlow));
  }
  if (opts.reasoningQuality) {
    app.route(
      "/api/reasoning-quality",
      createReasoningQualityRoutes(opts.reasoningQuality)
    );
  }

  // SPA serving — skipped for daemon children (supervisor serves UI on :9847)
  if (!opts.apiOnly) {
    const distDir = join(dirname(fileURLToPath(import.meta.url)), "ui");
    const spaIndex = join(distDir, "index.html");

    if (existsSync(spaIndex)) {
      const spaHtml = readFileSync(spaIndex, "utf-8");

      app.use("*", serveStatic({ root: distDir }));

      app.get("*", (c) => {
        const path = c.req.path;
        if (path.startsWith("/api/")) {
          return c.notFound();
        }
        return c.html(spaHtml);
      });
    } else {
      app.get("/", (c) => {
        return c.json({
          message: "unerr dashboard API is running. UI not built yet.",
          hint: "Run 'pnpm run build:ui' to build the dashboard SPA.",
          api: {
            status: "/api/system/status",
            config: "/api/system/config",
            intelligence:
              "/api/intelligence/{graph-stats,health,top-entities,...}",
            session: "/api/session/{stats,efficiency,intents,ledger}",
            stream: "/api/stream (SSE)",
          },
        });
      });
    }
  } else {
    app.get("/", (c) => c.json({ status: "ok", mode: "api-only" }));
  }

  // Start server
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  });

  // Write server.json atomically
  const serverJsonPath = join(opts.stateDir, "server.json");
  const serverInfo = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    url: `http://localhost:${port}`,
  };
  const tmpPath = `${serverJsonPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(serverInfo, null, 2));
  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, serverJsonPath);

  const close = (): void => {
    try {
      (server as unknown as { close: () => void }).close();
    } catch {
      // Server may already be closed
    }
    try {
      unlinkSync(serverJsonPath);
    } catch {
      // File may not exist
    }
  };

  return { port, close };
}
