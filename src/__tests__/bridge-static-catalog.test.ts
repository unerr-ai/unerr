/**
 * SF-2: Bridge static-catalog interceptor.
 *
 * Insurance against slow proxy / daemon cold-start. The interceptor sits in
 * the `unerr --mcp` pre-buffer stage and answers `initialize` / `tools/list`
 * locally from `TOOL_DEFINITIONS` so the IDE doesn't mark the MCP server
 * disconnected while we auto-spawn the supervisor + per-repo process. All
 * other frames (notably `tools/call`) are queued for the proxy unchanged.
 */

import { describe, expect, it } from "vitest";
import {
  BridgeCatalog,
  PROTOCOL_VERSION,
  SERVER_INFO,
  StaticCatalogInterceptor,
  buildInitializeResult,
  buildToolsListResult,
} from "../proxy/bridge-catalog.js";
import { ADVERTISED_TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";

function encodeFrame(obj: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

interface ParsedReply {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
}

function parseReply(s: string): ParsedReply {
  // Strip trailing newline if present.
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return JSON.parse(trimmed) as ParsedReply;
}

describe("StaticCatalogInterceptor", () => {
  it("answers initialize locally with protocol version + serverInfo", () => {
    const interceptor = new StaticCatalogInterceptor();
    const chunk = encodeFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "claude-code" } },
    });

    const out = interceptor.ingest(chunk);

    expect(out.replies).toHaveLength(1);
    expect(out.forward).toHaveLength(0);

    const reply = parseReply(out.replies[0]!);
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(1);
    const result = reply.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: unknown };
    };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual(SERVER_INFO);
    expect(result.capabilities.tools).toBeDefined();
  });

  it("answers tools/list locally with the advertised static catalog", () => {
    const interceptor = new StaticCatalogInterceptor();
    const chunk = encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const out = interceptor.ingest(chunk);

    expect(out.replies).toHaveLength(1);
    expect(out.forward).toHaveLength(0);

    const reply = parseReply(out.replies[0]!);
    expect(reply.id).toBe(2);
    const result = reply.result as { tools: { name: string }[] };
    // Offline fallback shows the ADVERTISED slice (what the model sees), not
    // the full validation catalog — hidden/demoted tools are excluded.
    expect(result.tools.length).toBe(ADVERTISED_TOOL_DEFINITIONS.length);
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("search_code")).toBe(true);
    expect(names.has("fetch_url")).toBe(true);
    expect(names.has("file_read")).toBe(true);
    expect(names.has("get_file")).toBe(false); // demoted → not advertised
  });

  it("forwards tools/call frames without replying", () => {
    const interceptor = new StaticCatalogInterceptor();
    const chunk = encodeFrame({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_code", arguments: { query: "router" } },
    });

    const out = interceptor.ingest(chunk);

    expect(out.replies).toHaveLength(0);
    expect(out.forward).toHaveLength(1);
    const forwarded = out.forward[0]!.toString("utf8");
    const parsed = JSON.parse(forwarded.trimEnd()) as { method: string };
    expect(parsed.method).toBe("tools/call");
  });

  it("forwards notifications/initialized to the proxy unchanged", () => {
    const interceptor = new StaticCatalogInterceptor();
    const chunk = encodeFrame({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const out = interceptor.ingest(chunk);

    expect(out.replies).toHaveLength(0);
    expect(out.forward).toHaveLength(1);
  });

  it("handles multiple frames in a single chunk", () => {
    const interceptor = new StaticCatalogInterceptor();
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    const list = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_code" },
    });
    const chunk = Buffer.from(`${init}\n${list}\n${call}\n`, "utf8");

    const out = interceptor.ingest(chunk);

    expect(out.replies).toHaveLength(2);
    expect(out.forward).toHaveLength(1);
    expect(parseReply(out.replies[0]!).id).toBe(1);
    expect(parseReply(out.replies[1]!).id).toBe(2);
  });

  it("buffers partial lines across chunks", () => {
    const interceptor = new StaticCatalogInterceptor();
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
    });
    const mid = Math.floor(frame.length / 2);
    const a = interceptor.ingest(Buffer.from(frame.slice(0, mid), "utf8"));
    expect(a.replies).toHaveLength(0);
    expect(a.forward).toHaveLength(0);

    const b = interceptor.ingest(Buffer.from(`${frame.slice(mid)}\n`, "utf8"));
    expect(b.replies).toHaveLength(1);
    expect(parseReply(b.replies[0]!).id).toBe(7);
  });

  it("drainPartial yields any unfinished tail", () => {
    const interceptor = new StaticCatalogInterceptor();
    interceptor.ingest(Buffer.from("partial-no-newline", "utf8"));
    const tail = interceptor.drainPartial();
    expect(tail).not.toBeNull();
    expect(tail?.toString("utf8")).toBe("partial-no-newline");
    expect(interceptor.drainPartial()).toBeNull();
  });

  it("forwards garbage (non-JSON) lines verbatim", () => {
    const interceptor = new StaticCatalogInterceptor();
    const chunk = Buffer.from("not-a-json-frame\n", "utf8");
    const out = interceptor.ingest(chunk);
    expect(out.replies).toHaveLength(0);
    expect(out.forward).toHaveLength(1);
  });

  it("preserves request id type (string vs number)", () => {
    const interceptor = new StaticCatalogInterceptor();
    const out = interceptor.ingest(
      encodeFrame({ jsonrpc: "2.0", id: "abc-123", method: "initialize" })
    );
    expect(parseReply(out.replies[0]!).id).toBe("abc-123");
  });
});

describe("BridgeCatalog (post-connect timeout-fallback)", () => {
  it("forwards initialize to the proxy AND arms a fallback", () => {
    const catalog = new BridgeCatalog();
    const out = catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" })
    );
    // Forwarded so the proxy still sees the frame (attribution + enriched answer).
    expect(out.forward).toHaveLength(1);
    expect(out.arm).toHaveLength(1);
    expect(out.arm[0]).toEqual({ id: 1, method: "initialize" });
  });

  it("arms tools/list and forwards tools/call without arming", () => {
    const catalog = new BridgeCatalog();
    const list = catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    );
    expect(list.arm).toEqual([{ id: 2, method: "tools/list" }]);

    const call = catalog.ingestFromIde(
      encodeFrame({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_code" },
      })
    );
    expect(call.arm).toHaveLength(0);
    expect(call.forward).toHaveLength(1);
  });

  it("does not arm a fallback for a notification (no id)", () => {
    const catalog = new BridgeCatalog();
    const out = catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    expect(out.arm).toHaveLength(0);
    expect(out.forward).toHaveLength(1);
  });

  it("settles the fallback when the proxy answers in time", () => {
    const catalog = new BridgeCatalog();
    catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" })
    );
    const proxy = catalog.ingestFromProxy(
      encodeFrame({ jsonrpc: "2.0", id: 1, result: { ok: true } })
    );
    expect(proxy.settledByProxy).toEqual(["1"]);
    expect(proxy.toIde).toHaveLength(1); // proxy's response forwarded to the IDE

    // The fallback timer (if it had fired) must now be a no-op.
    expect(catalog.fireFallback({ id: 1, method: "initialize" })).toBeNull();
  });

  it("emits a local reply on fallback and suppresses the proxy's late dup", () => {
    const catalog = new BridgeCatalog();
    catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: 5, method: "tools/list" })
    );

    // Timer fires before the proxy answered.
    const reply = catalog.fireFallback({ id: 5, method: "tools/list" });
    expect(reply).not.toBeNull();
    const parsed = parseReply(reply!);
    expect(parsed.id).toBe(5);
    expect((parsed.result as { tools: unknown[] }).tools.length).toBe(
      ADVERTISED_TOOL_DEFINITIONS.length
    );

    // Proxy's late response for id 5 must be suppressed (duplicate id).
    const late = catalog.ingestFromProxy(
      encodeFrame({ jsonrpc: "2.0", id: 5, result: { tools: [] } })
    );
    expect(late.toIde).toHaveLength(0);
    expect(late.settledByProxy).toHaveLength(0);
  });

  it("strips heartbeat pongs from the proxy stream", () => {
    const catalog = new BridgeCatalog();
    const out = catalog.ingestFromProxy(
      Buffer.from(
        `${JSON.stringify({ jsonrpc: "2.0", method: "unerr/pong" })}\n`,
        "utf8"
      )
    );
    expect(out.sawPong).toBe(true);
    expect(out.toIde).toHaveLength(0);
  });

  it("passes through an ordinary proxy response that was never armed", () => {
    const catalog = new BridgeCatalog();
    const out = catalog.ingestFromProxy(
      encodeFrame({ jsonrpc: "2.0", id: 99, result: { data: 1 } })
    );
    expect(out.toIde).toHaveLength(1);
    expect(out.settledByProxy).toHaveLength(0);
  });

  it("buffers a partial proxy frame across chunks before matching its id", () => {
    const catalog = new BridgeCatalog();
    catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: 8, method: "initialize" })
    );
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 8, result: {} });
    const mid = Math.floor(frame.length / 2);

    const first = catalog.ingestFromProxy(
      Buffer.from(frame.slice(0, mid), "utf8")
    );
    expect(first.settledByProxy).toHaveLength(0);
    expect(first.toIde).toHaveLength(0);

    const second = catalog.ingestFromProxy(
      Buffer.from(`${frame.slice(mid)}\n`, "utf8")
    );
    expect(second.settledByProxy).toEqual(["8"]);
    expect(second.toIde).toHaveLength(1);
  });

  it("matches ids by value across number/string request and response", () => {
    const catalog = new BridgeCatalog();
    catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: "init-1", method: "initialize" })
    );
    const out = catalog.ingestFromProxy(
      encodeFrame({ jsonrpc: "2.0", id: "init-1", result: {} })
    );
    expect(out.settledByProxy).toEqual(["init-1"]);
  });

  it("treats a server-initiated request (id + method) as passthrough, not a response", () => {
    const catalog = new BridgeCatalog();
    catalog.ingestFromIde(
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" })
    );
    // A frame with both id and method is a request, not our response.
    const out = catalog.ingestFromProxy(
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage" })
    );
    expect(out.settledByProxy).toHaveLength(0);
    expect(out.toIde).toHaveLength(1); // forwarded untouched
  });
});

describe("buildInitializeResult / buildToolsListResult", () => {
  it("buildInitializeResult shape matches the runtime path", () => {
    const obj = buildInitializeResult(42) as {
      jsonrpc: string;
      id: number;
      result: { serverInfo: { name: string } };
    };
    expect(obj.jsonrpc).toBe("2.0");
    expect(obj.id).toBe(42);
    expect(obj.result.serverInfo.name).toBe("unerr-local");
  });

  it("buildToolsListResult includes every advertised tool", () => {
    const obj = buildToolsListResult(1) as {
      result: { tools: { name: string }[] };
    };
    expect(obj.result.tools.length).toBe(ADVERTISED_TOOL_DEFINITIONS.length);
  });
});
