/**
 * Sprint 5.3: HTTP/SSE Transport for Main Proxy
 *
 * Adds Streamable HTTP transport alongside STDIO for remote/CI access.
 * Endpoints:
 *   POST /mcp   — MCP Streamable HTTP (recommended)
 *   GET  /mcp   — SSE stream for server-initiated messages
 *   GET  /health — Health check (no auth)
 *
 * Bearer token auth required on /mcp (uses proxy credentials).
 * All output to stderr — stdout reserved for STDIO MCP.
 */

import {
  type Server as HttpServer,
  createServer as createHttpServer,
} from "node:http";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpTransportOptions {
  /** Port to listen on (0 = OS-assigned) */
  port: number;
  /** Bearer token for auth (if set, all /mcp requests require it) */
  apiKey?: string;
  /** MCP server instance to connect transports to */
  mcpServer: McpServer;
  /** Callback for logging */
  log?: (msg: string) => void;
}

export interface HttpTransportHandle {
  /** The HTTP server instance */
  server: HttpServer;
  /** Resolved port after listen */
  port: number;
  /** Shutdown the HTTP transport */
  close: () => void;
}

/**
 * Start an HTTP server that serves MCP via Streamable HTTP transport.
 * Returns a handle for shutdown.
 */
export async function startHttpTransport(
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const { port, apiKey, mcpServer, log = () => {} } = opts;

  // Create a stateful transport (session-aware)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  // Connect to MCP server
  await mcpServer.connect(transport);

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health — no auth
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "streamable-http",
          pid: process.pid,
        }),
      );
      return;
    }

    // Auth check for /mcp
    if (url.pathname === "/mcp") {
      if (apiKey) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;
        if (token !== apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      // Delegate to StreamableHTTPServerTransport
      await transport.handleRequest(req, res);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not found",
        endpoints: ["/mcp", "/health"],
      }),
    );
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      const resolvedPort = typeof addr === "object" && addr ? addr.port : port;
      log(`HTTP transport listening on http://127.0.0.1:${resolvedPort}/mcp`);

      resolve({
        server: httpServer,
        port: resolvedPort,
        close: () => {
          transport.close().catch(() => {});
          httpServer.close();
        },
      });
    });

    // Don't block process exit
    httpServer.unref();
  });
}
