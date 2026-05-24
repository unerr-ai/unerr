/**
 * Transport abstraction for downstream MCP client connections.
 *
 * Three implementations:
 *   - StdioTransport: subprocess with stdin/stdout JSON-RPC
 *   - SseTransport: HTTP POST for requests + SSE stream for responses/notifications
 *   - HttpTransport: plain JSON-RPC over HTTP POST
 *
 * All transports speak JSON-RPC 2.0 with MCP framing. The ConnectionManager
 * picks the right transport based on `ProxiedServerConfig.type`.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type TransportState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface TransportEvents {
  onNotification?: (notification: JsonRpcNotification) => void;
  onStateChange?: (state: TransportState) => void;
  onError?: (error: Error) => void;
}

/**
 * Transport interface. All implementations must:
 *   1. Connect to the downstream MCP server
 *   2. Send JSON-RPC requests and return responses
 *   3. Forward server-initiated notifications via `events.onNotification`
 *   4. Report state changes via `events.onStateChange`
 *   5. Disconnect cleanly on `close()`
 */
export interface McpTransport {
  readonly state: TransportState;
  connect(): Promise<void>;
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

export interface TransportConfig {
  readonly serverId: string;
  readonly events: TransportEvents;
}

export interface StdioTransportConfig extends TransportConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface SseTransportConfig extends TransportConfig {
  readonly url: string;
}

export interface HttpTransportConfig extends TransportConfig {
  readonly url: string;
}
