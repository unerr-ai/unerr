/**
 * HTTP Transport — MCP over Streamable HTTP via Hono.
 *
 * Provides:
 *   POST /mcp → MCP JSON-RPC requests (Streamable HTTP)
 *   GET  /mcp → SSE stream for server-initiated messages
 *   GET  /health → Health check
 *
 * Uses MCP SDK's StreamableHTTPServerTransport for protocol compliance.
 * Localhost-only by default (no auth, no CORS).
 */

import {
  type Server as HttpServer,
  createServer as createHttpServer,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerInstance } from "../types.js";

export interface HttpTransportOptions {
  port?: number;
  hostname?: string;
}

export interface HttpTransportHandle {
  server: HttpServer;
  port: number;
  close: () => void;
}

/**
 * Start an HTTP server serving MCP via Streamable HTTP transport.
 */
export async function connectHttp(
  instance: McpServerInstance,
  options: HttpTransportOptions = {},
): Promise<HttpTransportHandle> {
  const port = options.port ?? 3141;
  const hostname = options.hostname ?? "127.0.0.1";

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await instance.server.connect(transport);

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: instance.config.name,
          version: instance.config.version,
          tools: instance.config.tools.length,
        }),
      );
      return;
    }

    if (url.pathname === "/mcp") {
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve) => {
    httpServer.listen(port, hostname, () => {
      const addr = httpServer.address();
      const resolvedPort = typeof addr === "object" && addr ? addr.port : port;

      resolve({
        server: httpServer,
        port: resolvedPort,
        close: () => {
          transport.close().catch(() => {});
          httpServer.close();
        },
      });
    });

    httpServer.unref();
  });
}
