/**
 * unerrd HTTP API — served on port 9847 by the process manager.
 *
 * Route layout:
 *   GET /api/pm — supervisor metadata (uptime, version, pid)
 *
 * All other requests return 404 JSON.
 */

import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { clearDashboardState, writeDashboardState } from "./dashboard-state.js";
import type { ProcessManager } from "./process-manager.js";
import {
  DAEMON_DASHBOARD_PORT_SCAN_RANGE,
  DAEMON_DASHBOARD_PORT as DAEMON_PORT,
} from "./protocol.js";

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

  // Public method for daemon.ts to push warm-start events (stored in-process;
  // no HTTP route exposes them — the route was removed).
  const warmStartEvents: Array<{
    repo: string;
    label: string;
    status: string;
    ms: number;
    reason?: string;
  }> = [];
  let warmStartLastRun: string | null = null;

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

  // ── Catch-all 404 ───────────────────────────────────────────

  app.all("*", (c) =>
    c.json({ error: "not_found", hint: "unerrd exposes only GET /api/pm" }, 404)
  );

  // ── Start server (sliding port discovery) ───────────────────
  // @hono/node-server surfaces EADDRINUSE asynchronously via the underlying
  // server's 'error' event, not as a synchronous throw — so a try/catch around
  // serve() can't detect an occupied port. Instead pre-scan for a free port
  // with a throwaway net server and bind serve() to the port we just confirmed
  // is free.

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
