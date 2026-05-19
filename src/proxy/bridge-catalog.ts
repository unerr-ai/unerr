/**
 * Static MCP catalog used by the bridge / mcpBoot pre-buffer phase.
 *
 * Insurance against slow proxy cold-start: if the IDE ships `initialize` or
 * `tools/list` while we're still auto-spawning the daemon + per-repo `unerr`
 * process, the IDE expects a timely JSON-RPC reply or it marks the server
 * disconnected. Answering locally from the static `TOOL_DEFINITIONS` catalog
 * keeps Claude Code / Cursor connected during a multi-second (or multi-minute,
 * on heavy reindex) startup. Once the proxy is up, frames flow through
 * normally and the proxy's enriched `tools/list` takes over for any later
 * refresh.
 *
 * Pure module — imports only from `./tool-definitions.js` and so stays inside
 * `src/proxy/`. Safe to consume from the bridge entry point without breaking
 * the Layer 12 DM-0 isolation invariant (no `intelligence/` / `behaviors/` /
 * `tracking/` references).
 */

import { TOOL_DEFINITIONS } from "./tool-definitions.js";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = {
  name: "unerr-local",
  version: "0.1.7",
} as const;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface InterceptOutcome {
  /** Newline-terminated JSON-RPC replies to write to stdout immediately. */
  replies: string[];
  /** Buffers to forward to the proxy verbatim once the UDS connects. */
  forward: Buffer[];
}

/**
 * Newline-delimited JSON-RPC line buffer. Inspects each complete frame and
 * answers `initialize` / `tools/list` locally. All other frames (including
 * `tools/call` and `notifications/initialized`) pass through unchanged.
 *
 * Stateful only across chunks within a single bridge boot; discarded once the
 * UDS socket connects and stdin is handed back to the bridge's passthrough.
 */
export class StaticCatalogInterceptor {
  private partial = "";

  ingest(chunk: Buffer): InterceptOutcome {
    const replies: string[] = [];
    const forward: Buffer[] = [];

    this.partial += chunk.toString("utf8");
    const lastNewline = this.partial.lastIndexOf("\n");
    if (lastNewline < 0) {
      return { replies, forward };
    }

    const completeBlock = this.partial.slice(0, lastNewline + 1);
    this.partial = this.partial.slice(lastNewline + 1);

    for (const rawLine of completeBlock.split("\n")) {
      if (rawLine === "") continue;
      const reply = tryIntercept(rawLine);
      if (reply !== null) {
        replies.push(`${reply}\n`);
      } else {
        forward.push(Buffer.from(`${rawLine}\n`, "utf8"));
      }
    }

    return { replies, forward };
  }

  /**
   * Returns any unfinished line (no terminating newline yet). Call exactly
   * once when handing the pre-buffer off to the bridge so partial frames are
   * forwarded to the proxy without being dropped.
   */
  drainPartial(): Buffer | null {
    if (this.partial.length === 0) return null;
    const buf = Buffer.from(this.partial, "utf8");
    this.partial = "";
    return buf;
  }
}

function tryIntercept(line: string): string | null {
  let msg: JsonRpcMessage;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    msg = parsed as JsonRpcMessage;
  } catch {
    // Not valid JSON — forward verbatim; the proxy can reject it.
    return null;
  }

  if (msg.method === "initialize") {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
  }

  if (msg.method === "tools/list") {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: { tools: TOOL_DEFINITIONS },
    });
  }

  return null;
}

/**
 * Build a JSON-RPC reply object for `initialize`. Exposed for tests; the
 * runtime path uses `StaticCatalogInterceptor` instead.
 */
export function buildInitializeResult(
  id: string | number | null
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    },
  };
}

/**
 * Build a JSON-RPC reply object for `tools/list` from the static catalog.
 */
export function buildToolsListResult(
  id: string | number | null
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: { tools: TOOL_DEFINITIONS },
  };
}
