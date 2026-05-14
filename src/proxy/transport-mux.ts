/**
 * Sprint 7.2: Transport Multiplexer — multiple IDE sessions via Unix domain socket.
 *
 * Architecture:
 *   IDE 1 (Claude Code) ──stdio──→ ┐
 *                                   ├── Proxy Process
 *   IDE 2 (Cursor)      ──UDS───→  ┘     ├── CozoDB (shared)
 *                                         ├── QueryRouter (shared)
 *                                         └── ShadowLedger (session_id per client)
 *
 * Primary client connects via stdio (backward compatible).
 * Secondary clients connect via Unix domain socket at `.unerr/state/proxy.sock`.
 * Each client gets an independent session_id in the Shadow Ledger.
 */

import { existsSync, unlinkSync } from "node:fs";
import { type Server as NetServer, type Socket, createServer } from "node:net";

/** stderr-only logger. stdout is MCP territory. */
const _log = {
  info: (msg: string) => process.stderr.write(`[unerr:mux] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerr:mux] WARN: ${msg}\n`),
};

/** Message handler callback — processes a JSON-RPC request and returns a response. */
export type MuxMessageHandler = (
  clientId: string,
  message: JsonRpcRequest,
) => Promise<JsonRpcResponse>;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface MuxClient {
  id: string;
  transport: "stdio" | "uds";
  connectedAt: string;
  socket?: Socket;
}

export class TransportMux {
  private sockPath: string;
  private server: NetServer | null = null;
  private clients = new Map<string, MuxClient>();
  private handler: MuxMessageHandler | null = null;
  private customHttpHandlers = new Map<string, (url: string) => string>();
  private nextClientId = 1;

  constructor(sockPath: string) {
    this.sockPath = sockPath;
  }

  /**
   * Set the message handler for incoming JSON-RPC requests.
   */
  setHandler(handler: MuxMessageHandler): void {
    this.handler = handler;
  }

  /**
   * Register a custom HTTP handler for a path prefix.
   * When an HTTP GET/POST request comes in on the UDS, this handler responds.
   * Handler receives the full URL (including query string) for param parsing.
   */
  setCustomHttpHandler(path: string, handler: (url: string) => string): void {
    this.customHttpHandlers.set(path, handler);
  }

  /**
   * Start listening for secondary clients on the Unix domain socket.
   */
  start(): void {
    // Clean up stale socket file
    if (existsSync(this.sockPath)) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        _log.warn(`Could not remove stale socket: ${this.sockPath}`);
        return;
      }
    }

    this.server = createServer((socket) => {
      this.onClientConnect(socket);
    });

    this.server.on("error", (err) => {
      _log.warn(`UDS server error: ${err.message}`);
    });

    this.server.listen(this.sockPath, () => {
      _log.info(`UDS transport listening at ${this.sockPath}`);
    });

    // Don't prevent process exit
    this.server.unref();
  }

  /**
   * Stop the UDS server and disconnect all secondary clients.
   */
  stop(): void {
    // Close all client connections
    for (const [id, client] of this.clients) {
      if (client.socket && !client.socket.destroyed) {
        client.socket.destroy();
      }
      this.clients.delete(id);
    }

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file
    if (existsSync(this.sockPath)) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        /* ignore */
      }
    }

    _log.info("UDS transport stopped");
  }

  /**
   * Get connected client count (excludes stdio primary).
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Get all connected clients.
   */
  getClients(): MuxClient[] {
    return [...this.clients.values()];
  }

  private onClientConnect(socket: Socket): void {
    const clientId = `uds-${this.nextClientId++}`;
    const client: MuxClient = {
      id: clientId,
      transport: "uds",
      connectedAt: new Date().toISOString(),
      socket,
    };

    this.clients.set(clientId, client);
    _log.info(`Client connected: ${clientId}`);

    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();

      // Sprint 10.5: Detect HTTP requests (from curl --unix-socket)
      if (buffer.startsWith("GET ") || buffer.startsWith("POST ")) {
        const httpMatch = buffer.match(/^(GET|POST) (\S+)/);
        if (httpMatch) {
          const fullUrl = httpMatch[2] ?? "";
          // Match by path prefix (strip query string for matching)
          const pathOnly = fullUrl.split("?")[0] ?? fullUrl;
          const httpHandler = this.customHttpHandlers.get(pathOnly);
          if (httpHandler) {
            try {
              const body = httpHandler(fullUrl);
              const httpResponse = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
              socket.write(httpResponse);
            } catch {
              socket.write(
                "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n",
              );
            }
            socket.end();
            return;
          }
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.end();
          return;
        }
      }

      // Process complete JSON-RPC messages (newline-delimited)
      let newlineIdx: number = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        this.processMessage(clientId, line, socket).catch((err) => {
          _log.warn(
            `Error processing message from ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        newlineIdx = buffer.indexOf("\n");
      }
    });

    socket.on("close", () => {
      this.clients.delete(clientId);
      _log.info(`Client disconnected: ${clientId}`);
    });

    socket.on("error", (err) => {
      _log.warn(`Client ${clientId} error: ${err.message}`);
      this.clients.delete(clientId);
    });
  }

  private async processMessage(
    clientId: string,
    raw: string,
    socket: Socket,
  ): Promise<void> {
    if (!this.handler) {
      _log.warn("No message handler set — dropping message");
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
      };
      this.sendResponse(socket, errorResponse);
      return;
    }

    // Heartbeat: respond to bridge health pings without forwarding to MCP handler
    if (request.method === "unerr/ping") {
      this.sendResponse(socket, {
        jsonrpc: "2.0",
        method: "unerr/pong",
        params: { ts: Date.now() },
      } as unknown as JsonRpcResponse);
      return;
    }

    try {
      const response = await this.handler(clientId, request);
      // JSON-RPC: notifications (no id) don't get responses
      if (request.id === undefined || request.id === null) {
        return;
      }
      // Preserve the request id in the response
      response.id = request.id;
      this.sendResponse(socket, response);
    } catch (err) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
      };
      this.sendResponse(socket, errorResponse);
    }
  }

  private sendResponse(socket: Socket, response: JsonRpcResponse): void {
    if (socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      /* client disconnected */
    }
  }
}
