/**
 * SSE transport for downstream MCP servers.
 *
 * MCP SSE transport spec:
 *   - Client POSTs JSON-RPC requests to the server's HTTP endpoint
 *   - Server streams responses + notifications over a persistent SSE connection
 *   - SSE events carry `event: message` with JSON-RPC payloads as data
 *
 * The SSE URL is provided in the server config. The POST endpoint is
 * derived from the SSE URL (same origin, path `/message` or as
 * returned in the SSE `endpoint` event).
 */

import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  SseTransportConfig,
  TransportState,
} from "./transport.js";

interface PendingRequest {
  resolve: (res: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class SseTransport implements McpTransport {
  private readonly config: SseTransportConfig;
  private _state: TransportState = "disconnected";
  private pending = new Map<string | number, PendingRequest>();
  private abortController: AbortController | null = null;
  private postEndpoint: string | null = null;

  constructor(config: SseTransportConfig) {
    this.config = config;
  }

  get state(): TransportState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === "connected") return;
    this.setState("connecting");

    this.abortController = new AbortController();

    const baseUrl = new URL(this.config.url);
    this.postEndpoint = new URL("/message", baseUrl.origin).toString();

    try {
      const response = await fetch(this.config.url, {
        headers: { Accept: "text/event-stream" },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `SSE connect failed: ${response.status} ${response.statusText}`
        );
      }

      this.setState("connected");
      this.consumeStream(response);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.setState("error");
        this.config.events.onError?.(err as Error);
      }
      throw err;
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this._state !== "connected" || !this.postEndpoint) {
      throw new Error(`[${this.config.serverId}] SSE transport not connected`);
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new Error(`[${this.config.serverId}] request ${request.id} timed out`)
        );
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(request.id, { resolve, reject, timer });

      fetch(this.postEndpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(
          new Error(
            `[${this.config.serverId}] POST error: ${(err as Error).message}`
          )
        );
      });
    });
  }

  async close(): Promise<void> {
    this.rejectAllPending(
      new Error(`[${this.config.serverId}] SSE transport closing`)
    );
    this.abortController?.abort();
    this.abortController = null;
    this.postEndpoint = null;
    this.setState("disconnected");
  }

  private async consumeStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop()!;

        for (const raw of events) {
          this.processEvent(raw);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.setState("error");
        this.config.events.onError?.(err as Error);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processEvent(raw: string): void {
    let eventType = "message";
    let data = "";

    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (eventType === "endpoint" && data) {
      try {
        const baseUrl = new URL(this.config.url);
        this.postEndpoint = new URL(data, baseUrl.origin).toString();
      } catch {
        // keep existing endpoint
      }
      return;
    }

    if (!data) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id as string | number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id as string | number);
        pending.resolve(msg as unknown as JsonRpcResponse);
      }
    } else if ("method" in msg) {
      this.config.events.onNotification?.(
        msg as unknown as JsonRpcNotification
      );
    }
  }

  private setState(s: TransportState): void {
    this._state = s;
    this.config.events.onStateChange?.(s);
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
