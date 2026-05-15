/**
 * Layer 7: Hono middleware stack for the dashboard HTTP server.
 *
 * Order: CORS → Cache-Control → Request ID + Timing → Error Boundary
 */

import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

/**
 * Strict localhost-only CORS. Rejects any origin that isn't
 * http://localhost:* or http://127.0.0.1:*
 */
export const corsMiddleware = createMiddleware(
  async (c: Context, next: Next) => {
    const origin = c.req.header("origin");

    if (origin) {
      const isLocalhost =
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1");

      if (!isLocalhost) {
        return c.json({ data: null, error: "CORS: origin not allowed" }, 403);
      }

      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type");
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    await next();
  }
);

/**
 * Cache-Control headers based on path.
 * /assets/* → immutable (content-hashed by Vite)
 * /api/* → no-cache
 */
export const cacheMiddleware = createMiddleware(
  async (c: Context, next: Next) => {
    await next();

    const path = c.req.path;
    if (path.startsWith("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    } else if (path.startsWith("/api/")) {
      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
);

/**
 * Request ID and timing. Adds X-Request-Id and logs to stderr.
 */
export const timingMiddleware = createMiddleware(
  async (c: Context, next: Next) => {
    const reqId = Math.random().toString(36).slice(2, 10);
    const start = performance.now();

    c.set("reqId", reqId);
    c.header("X-Request-Id", reqId);

    await next();

    const ms = (performance.now() - start).toFixed(1);
    process.stderr.write(
      `[dashboard] ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)\n`
    );
  }
);

/**
 * Global error boundary. Never crash — return structured error envelope.
 */
export const errorMiddleware = createMiddleware(
  async (c: Context, next: Next) => {
    try {
      await next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[dashboard] ERROR: ${message}\n`);
      return c.json(
        {
          data: null,
          _meta: { source: "local", latency_ms: 0, error: message },
        },
        500
      );
    }
  }
);
