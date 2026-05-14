/**
 * Sprint 7.2: Transport Multiplexer tests (Unix domain socket multi-client).
 */

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MuxMessageHandler,
  TransportMux,
} from "../proxy/transport-mux.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "mux-"));
}

/** Send a JSON-RPC message over a socket and wait for response. */
function sendMessage(
  sockPath: string,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          socket.destroy();
          resolve(response);
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      }
    });

    socket.on("error", reject);

    // Timeout after 2s
    setTimeout(() => {
      socket.destroy();
      reject(new Error("Timeout waiting for response"));
    }, 2000);
  });
}

/** Wait for socket to become available. */
function waitForSocket(sockPath: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(sockPath)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timeout waiting for socket"));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

describe("TransportMux", () => {
  const muxInstances: TransportMux[] = [];

  afterEach(() => {
    for (const mux of muxInstances) {
      mux.stop();
    }
    muxInstances.length = 0;
  });

  it("starts and stops cleanly", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    mux.start();
    await waitForSocket(sockPath);
    expect(existsSync(sockPath)).toBe(true);

    mux.stop();
    expect(existsSync(sockPath)).toBe(false);
  });

  it("accepts a UDS client and routes messages", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    const receivedMessages: Array<{ clientId: string; method: string }> = [];

    const handler: MuxMessageHandler = async (clientId, message) => {
      receivedMessages.push({ clientId, method: message.method });
      return {
        jsonrpc: "2.0" as const,
        result: { tools: ["get_function"] },
      };
    };

    mux.setHandler(handler);
    mux.start();
    await waitForSocket(sockPath);

    const response = await sendMessage(sockPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]?.method).toBe("tools/list");
    expect(receivedMessages[0]?.clientId).toMatch(/^uds-/);
  });

  it("handles tools/call with arguments", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    const handler: MuxMessageHandler = async (_clientId, message) => {
      const params = message.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      return {
        jsonrpc: "2.0" as const,
        result: {
          content: [{ type: "text", text: `Called ${params.name}` }],
        },
      };
    };

    mux.setHandler(handler);
    mux.start();
    await waitForSocket(sockPath);

    const response = await sendMessage(sockPath, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_function", arguments: { key: "k1" } },
    });

    expect(response.id).toBe(2);
    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("Called get_function");
  });

  it("returns error for unknown methods", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    const handler: MuxMessageHandler = async () => {
      return {
        jsonrpc: "2.0" as const,
        error: { code: -32601, message: "Method not found" },
      };
    };

    mux.setHandler(handler);
    mux.start();
    await waitForSocket(sockPath);

    const response = await sendMessage(sockPath, {
      jsonrpc: "2.0",
      id: 3,
      method: "unknown/method",
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601);
  });

  it("returns parse error for invalid JSON", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    mux.setHandler(async () => ({
      jsonrpc: "2.0" as const,
      result: {},
    }));
    mux.start();
    await waitForSocket(sockPath);

    // Send raw invalid JSON
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const socket = createConnection(sockPath);
      let buffer = "";

      socket.on("connect", () => {
        socket.write("not valid json\n");
      });

      socket.on("data", (data) => {
        buffer += data.toString();
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, idx)) as JsonRpcResponse);
        }
      });

      socket.on("error", reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error("Timeout"));
      }, 2000);
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32700);
  });

  it("supports multiple concurrent clients", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    const clientIds = new Set<string>();
    const handler: MuxMessageHandler = async (clientId) => {
      clientIds.add(clientId);
      return {
        jsonrpc: "2.0" as const,
        result: { clientId },
      };
    };

    mux.setHandler(handler);
    mux.start();
    await waitForSocket(sockPath);

    // Send two messages concurrently from separate connections
    const [r1, r2] = await Promise.all([
      sendMessage(sockPath, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      sendMessage(sockPath, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);

    expect(r1.result).toBeDefined();
    expect(r2.result).toBeDefined();
    // Each connection gets a unique client ID
    expect(clientIds.size).toBe(2);
  });

  it("tracks client count", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    mux.setHandler(async () => ({ jsonrpc: "2.0" as const, result: {} }));
    mux.start();
    await waitForSocket(sockPath);

    expect(mux.clientCount).toBe(0);

    // Connect a client (it connects then disconnects after response)
    await sendMessage(sockPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    // After sendMessage destroys socket, client should be cleaned up
    // Give event loop time to process the close
    await new Promise((r) => setTimeout(r, 100));
    expect(mux.clientCount).toBe(0);
  });

  it("cleans up stale socket file on start", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");

    // Create a stale socket file
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sockPath, "stale", "utf-8");
    expect(existsSync(sockPath)).toBe(true);

    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    // Start should remove stale file and recreate
    mux.start();
    await waitForSocket(sockPath);

    // Should still work
    mux.setHandler(async () => ({
      jsonrpc: "2.0" as const,
      result: { ok: true },
    }));
    const response = await sendMessage(sockPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.result).toBeDefined();
  });

  it("handles handler errors gracefully", async () => {
    const dir = createTempDir();
    const sockPath = join(dir, "proxy.sock");
    const mux = new TransportMux(sockPath);
    muxInstances.push(mux);

    mux.setHandler(async () => {
      throw new Error("Handler crashed");
    });
    mux.start();
    await waitForSocket(sockPath);

    const response = await sendMessage(sockPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32603);
    expect(response.error?.message).toBe("Handler crashed");
  });
});
