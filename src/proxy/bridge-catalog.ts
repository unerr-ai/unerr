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

// ── BridgeCatalog: post-connect timeout-fallback (FIX A) ──────────────

/**
 * How long the bridge waits for the proxy to answer an `initialize` /
 * `tools/list` request before falling back to the static catalog (ms).
 *
 * Claude Code abandons an MCP server (and registers zero tools, never
 * re-listing) if these two methods aren't answered inside its startup
 * deadline. A busy-but-alive proxy mid-incremental-index can take tens of
 * seconds to respond, so the bridge answers locally after this budget and
 * suppresses the proxy's late duplicate. 3s is comfortably inside Claude
 * Code's deadline while still giving a quick proxy the first shot at serving
 * its richer, nudge-enriched catalog.
 */
export const LOCAL_CATALOG_FALLBACK_MS = 3_000;

/** Methods the bridge can answer locally from TOOL_DEFINITIONS. */
const LOCAL_ANSWERABLE_METHODS = new Set(["initialize", "tools/list"]);

export interface PendingLocalRequest {
  id: string | number;
  method: "initialize" | "tools/list";
}

/** Result of feeding IDE→proxy bytes through the catalog. */
export interface IdeIngestOutcome {
  /** Frames to write to the proxy socket verbatim (one buffer per line). */
  forward: Buffer[];
  /**
   * Answerable requests the bridge should arm a fallback timer for. When a
   * timer fires, call `fireFallback(req)` to get the local reply (or null if
   * the proxy answered first).
   */
  arm: PendingLocalRequest[];
}

/** Result of feeding proxy→IDE bytes through the catalog. */
export interface ProxyIngestOutcome {
  /** Frames to write to stdout (heartbeat pongs + suppressed dups removed). */
  toIde: Buffer[];
  /** True if at least one `unerr/pong` heartbeat frame was seen in this chunk. */
  sawPong: boolean;
  /**
   * Request ids the proxy answered in time. The bridge must clear the
   * corresponding fallback timers so no late local duplicate is emitted.
   */
  settledByProxy: string[];
}

/**
 * Frame-aware relay state for one bridge↔proxy connection.
 *
 * Unlike `StaticCatalogInterceptor` (pre-connect only — answers immediately
 * because there's no proxy to forward to), `BridgeCatalog` runs for the whole
 * post-connect lifetime and implements the prefer-proxy / fall-back-local
 * contract:
 *
 *   1. `initialize` / `tools/list` are forwarded to the proxy AND armed with a
 *      fallback timer (proxy gets first shot at its enriched answer + the
 *      side effects of receiving the frame).
 *   2. If the proxy answers within LOCAL_CATALOG_FALLBACK_MS, that response is
 *      forwarded and the timer cleared (`settledByProxy`).
 *   3. If it times out, the bridge emits the static local reply and records the
 *      id; the proxy's eventual late response for that id is suppressed so the
 *      IDE never sees a duplicate-id frame (a protocol violation).
 *
 * Timer-free by design — the bridge owns timers so this class stays trivially
 * unit-testable. Imports only `./tool-definitions.js`, so the bridge keeps its
 * Layer 12 DM-0 isolation (no intelligence/behaviors/tracking).
 */
export class BridgeCatalog {
  private idePartial = "";
  private proxyPartial = "";
  /** Ids forwarded to the proxy, awaiting its response or our fallback. */
  private pending = new Set<string>();
  /** Ids answered locally after timeout — suppress the proxy's late dup. */
  private answeredLocally = new Set<string>();

  /** Process raw bytes arriving from the IDE (stdin). */
  ingestFromIde(chunk: Buffer): IdeIngestOutcome {
    const forward: Buffer[] = [];
    const arm: PendingLocalRequest[] = [];

    this.idePartial += chunk.toString("utf8");
    const lastNewline = this.idePartial.lastIndexOf("\n");
    if (lastNewline < 0) return { forward, arm };

    const block = this.idePartial.slice(0, lastNewline + 1);
    this.idePartial = this.idePartial.slice(lastNewline + 1);

    for (const rawLine of block.split("\n")) {
      if (rawLine === "") continue;
      const req = classifyAnswerableRequest(rawLine);
      if (req) {
        const key = String(req.id);
        this.pending.add(key);
        arm.push(req);
      }
      // Always forward — the proxy needs the frame (attribution, enriched
      // answer) even for methods we can answer locally as a fallback.
      forward.push(Buffer.from(`${rawLine}\n`, "utf8"));
    }

    return { forward, arm };
  }

  /** Process raw bytes arriving from the proxy (UDS). */
  ingestFromProxy(chunk: Buffer): ProxyIngestOutcome {
    const toIde: Buffer[] = [];
    const settledByProxy: string[] = [];
    let sawPong = false;

    this.proxyPartial += chunk.toString("utf8");
    const lastNewline = this.proxyPartial.lastIndexOf("\n");
    if (lastNewline < 0) return { toIde, sawPong, settledByProxy };

    const block = this.proxyPartial.slice(0, lastNewline + 1);
    this.proxyPartial = this.proxyPartial.slice(lastNewline + 1);

    for (const rawLine of block.split("\n")) {
      if (rawLine === "") continue;
      if (rawLine.includes('"unerr/pong"')) {
        sawPong = true;
        continue; // heartbeat frames never reach the IDE
      }
      const respId = classifyResponseId(rawLine);
      if (respId !== null) {
        const key = String(respId);
        if (this.answeredLocally.has(key)) {
          // Already answered from the static catalog after timeout. The proxy's
          // late response carries a duplicate id — drop it.
          this.answeredLocally.delete(key);
          continue;
        }
        if (this.pending.has(key)) {
          // Proxy answered in time — prefer its response, cancel the fallback.
          this.pending.delete(key);
          settledByProxy.push(key);
        }
      }
      toIde.push(Buffer.from(`${rawLine}\n`, "utf8"));
    }

    return { toIde, sawPong, settledByProxy };
  }

  /**
   * Called when a fallback timer fires. Returns the newline-terminated local
   * reply to write to stdout, or null if the proxy already answered (the timer
   * lost the race and must be a no-op).
   */
  fireFallback(req: PendingLocalRequest): string | null {
    const key = String(req.id);
    if (!this.pending.has(key)) return null; // proxy won the race
    this.pending.delete(key);
    this.answeredLocally.add(key);
    const obj =
      req.method === "initialize"
        ? buildInitializeResult(req.id)
        : buildToolsListResult(req.id);
    return `${JSON.stringify(obj)}\n`;
  }
}

/**
 * Classify an IDE→proxy line as a locally-answerable request, or null. Requires
 * a method in {initialize, tools/list} AND a non-null id (notifications, which
 * carry no id, are never answerable).
 */
function classifyAnswerableRequest(line: string): PendingLocalRequest | null {
  let msg: JsonRpcMessage;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    msg = parsed as JsonRpcMessage;
  } catch {
    return null;
  }
  if (!msg.method || !LOCAL_ANSWERABLE_METHODS.has(msg.method)) return null;
  if (msg.id === undefined || msg.id === null) return null;
  return {
    id: msg.id,
    method: msg.method as "initialize" | "tools/list",
  };
}

/**
 * Return the id of a proxy→IDE line if it's a JSON-RPC *response* (has an id,
 * carries result/error, and is not itself a server-initiated request). Returns
 * null otherwise so notifications and server requests pass through untouched.
 */
function classifyResponseId(line: string): string | number | null {
  let msg: (JsonRpcMessage & { result?: unknown; error?: unknown }) | null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    msg = parsed as JsonRpcMessage & { result?: unknown; error?: unknown };
  } catch {
    return null;
  }
  if (msg.id === undefined || msg.id === null) return null;
  if (msg.method !== undefined) return null; // server-initiated request, not a response
  if (!("result" in msg) && !("error" in msg)) return null;
  return msg.id;
}
