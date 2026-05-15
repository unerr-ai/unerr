/**
 * HTTP Transport — Hono-based HTTP server for the intelligence proxy.
 *
 * Provides an alternative transport to stdio MCP. Disabled by default,
 * enabled via `unerr --http` or `unerr serve --http-port 3141`.
 *
 * Endpoints:
 *   GET  /health   → { status, version, uptime_ms }
 *   GET  /ui/*     → Static files from packages/ui/dist/ (dashboard)
 *   GET  /ui       → Redirect to /ui/
 *
 * Invariant: The HTTP server never interferes with MCP stdio transport.
 * Both can run simultaneously — HTTP on a port, MCP on stdin/stdout.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("http");

export interface HttpTransportOptions {
  port?: number;
  hostname?: string;
}

export interface HttpTransport {
  app: Hono;
  start: () => ServerType;
  port: number;
}

const startedAt = Date.now();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveUiDistDir(): string | null {
  const candidates = [
    join(process.cwd(), "packages", "ui", "dist"),
    join(process.cwd(), "..", "packages", "ui", "dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

export function createHttpTransport(
  options: HttpTransportOptions = {}
): HttpTransport {
  const port = options.port ?? 3141;
  const hostname = options.hostname ?? "127.0.0.1";

  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: "0.1.3",
      uptime_ms: Date.now() - startedAt,
    })
  );

  app.get("/ui", (c) => c.redirect("/ui/"));

  app.get("/ui/*", async (c) => {
    const uiDir = resolveUiDistDir();
    if (!uiDir) {
      return c.json(
        { error: "UI not built. Run: pnpm --filter @unerr/ui build" },
        404
      );
    }

    let filePath = c.req.path.replace(/^\/ui\/?/, "");
    if (!filePath || filePath === "/") filePath = "index.html";

    const fullPath = join(uiDir, filePath);

    if (!fullPath.startsWith(uiDir)) {
      return c.json({ error: "forbidden" }, 403);
    }

    try {
      const content = await readFile(fullPath);
      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    } catch {
      const indexPath = join(uiDir, "index.html");
      try {
        const indexContent = await readFile(indexPath);
        return new Response(indexContent, {
          headers: { "Content-Type": "text/html" },
        });
      } catch {
        return c.json({ error: "not_found" }, 404);
      }
    }
  });

  app.onError((err, c) => {
    log.error("Unhandled HTTP error:", err.message);
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  app.notFound((c) =>
    c.json(
      {
        error: "not_found",
        message: `${c.req.method} ${c.req.path} not found`,
      },
      404
    )
  );

  const start = (): ServerType => {
    const server = serve({ fetch: app.fetch, port, hostname });
    log.info(`HTTP transport listening on http://${hostname}:${port}`);
    return server;
  };

  return { app, start, port };
}
