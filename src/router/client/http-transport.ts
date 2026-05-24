/**
 * HTTP transport for downstream MCP servers.
 *
 * Simple JSON-RPC over HTTP POST. No persistent connection — each
 * request is a standalone POST. Server notifications are not supported
 * over plain HTTP; this transport is for servers that only expose
 * a request-response API without streaming.
 */

import type {
  HttpTransportConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  TransportState,
} from "./transport.js";

const REQUEST_TIMEOUT_MS = 30_000;

export class HttpTransport implements McpTransport {
  private readonly config: HttpTransportConfig;
  private _state: TransportState = "disconnected";

  constructor(config: HttpTransportConfig) {
    this.config = config;
  }

  get state(): TransportState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === "connected") return;
    this.setState("connecting");

    try {
      const probe = await fetch(this.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "unerr-gateway", version: "1.0.0" },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!probe.ok) {
        throw new Error(`HTTP probe failed: ${probe.status}`);
      }

      this.setState("connected");
    } catch (err) {
      this.setState("error");
      this.config.events.onError?.(err as Error);
      throw err;
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this._state !== "connected") {
      throw new Error(`[${this.config.serverId}] HTTP transport not connected`);
    }

    const response = await fetch(this.config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `[${this.config.serverId}] HTTP ${response.status}: ${response.statusText}`
      );
    }

    return (await response.json()) as JsonRpcResponse;
  }

  async close(): Promise<void> {
    this.setState("disconnected");
  }

  private setState(s: TransportState): void {
    this._state = s;
    this.config.events.onStateChange?.(s);
  }
}
