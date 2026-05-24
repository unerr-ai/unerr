import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProxiedServerConfig } from "../config/router-config-writer.js";
import {
  ConnectionManager,
  type ConnectionManagerEvents,
} from "../router/client/connection-manager.js";
import { Forwarder } from "../router/client/forwarder.js";
import { SchemaCache } from "../router/client/schema-cache.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  TransportState,
} from "../router/client/transport.js";

/**
 * Mock transport that resolves instantly with canned responses.
 * Used to test ConnectionManager → SchemaCache → Forwarder pipeline
 * without spawning real child processes.
 */
class MockTransport implements McpTransport {
  state: TransportState = "disconnected";
  readonly tools: { name: string; description: string }[];
  readonly id: string;
  connectDelay: number;
  shouldFail = false;

  constructor(
    id: string,
    tools: { name: string; description: string }[],
    connectDelay = 0
  ) {
    this.id = id;
    this.tools = tools;
    this.connectDelay = connectDelay;
  }

  async connect(): Promise<void> {
    if (this.connectDelay > 0) {
      await new Promise((r) => setTimeout(r, this.connectDelay));
    }
    if (this.shouldFail) {
      this.state = "error";
      throw new Error(`MockTransport(${this.id}) connect failed`);
    }
    this.state = "connected";
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.shouldFail) {
      throw new Error(`MockTransport(${this.id}) send failed`);
    }

    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      };
    }

    if (request.method === "tools/call") {
      const params = request.params as {
        name: string;
        arguments: Record<string, unknown>;
      };
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `[${this.id}] executed ${params.name} with ${JSON.stringify(params.arguments)}`,
            },
          ],
        },
      };
    }

    if (request.method === "ping") {
      return { jsonrpc: "2.0", id: request.id, result: {} };
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Unknown method: ${request.method}` },
    };
  }

  async close(): Promise<void> {
    this.state = "disconnected";
  }
}

function mockServer(
  name: string,
  tools: { name: string; description: string }[]
): { config: ProxiedServerConfig; transport: MockTransport } {
  return {
    config: {
      name,
      alias: name.slice(0, 2),
      command: "mock",
      args: [],
      sourceAgent: "test",
    },
    transport: new MockTransport(name, tools),
  };
}

/**
 * Patches createTransport in ConnectionManager to return mock transports.
 */
function createMockConnectionManager(
  mocks: Map<string, MockTransport>,
  events: ConnectionManagerEvents = {}
): ConnectionManager {
  const cm = new ConnectionManager(events);

  const origConnectAll = cm.connectAll.bind(cm);
  cm.connectAll = async (configs: readonly ProxiedServerConfig[]) => {
    const failures: string[] = [];

    for (const config of configs) {
      const mockTransport = mocks.get(config.name);
      if (!mockTransport) {
        failures.push(config.name);
        continue;
      }

      const managed = {
        config,
        transport: mockTransport as McpTransport,
        status: "idle" as any,
        restartCount: 0,
        lastError: null as string | null,
        lastConnectedAt: null as number | null,
      };

      (cm as any).servers.set(config.name, managed);

      try {
        managed.status = "connecting";
        await mockTransport.connect();
        managed.status = "connected";
        managed.lastConnectedAt = Date.now();
      } catch (err) {
        managed.status = "error";
        managed.lastError = (err as Error).message;
        failures.push(config.name);
      }
    }

    return failures;
  };

  return cm;
}

describe("Router Multi-Server Roundtrip", () => {
  const github = mockServer("github", [
    { name: "search", description: "Search GitHub" },
    { name: "create_issue", description: "Create a GitHub issue" },
  ]);
  const postgres = mockServer("postgres", [
    { name: "query", description: "Run SQL query" },
    { name: "list_tables", description: "List database tables" },
  ]);
  const slack = mockServer("slack", [
    { name: "send_message", description: "Send a Slack message" },
    { name: "list_channels", description: "List Slack channels" },
  ]);

  let cm: ConnectionManager;
  let schemaCache: SchemaCache;
  let forwarder: Forwarder;

  beforeEach(async () => {
    const mocks = new Map<string, MockTransport>([
      ["github", github.transport],
      ["postgres", postgres.transport],
      ["slack", slack.transport],
    ]);

    github.transport.state = "disconnected";
    github.transport.shouldFail = false;
    postgres.transport.state = "disconnected";
    postgres.transport.shouldFail = false;
    slack.transport.state = "disconnected";
    slack.transport.shouldFail = false;

    cm = createMockConnectionManager(mocks);
    const failures = await cm.connectAll([
      github.config,
      postgres.config,
      slack.config,
    ]);
    expect(failures).toHaveLength(0);

    schemaCache = new SchemaCache(cm);
    forwarder = new Forwarder(cm);
  });

  afterEach(async () => {
    await cm.shutdown();
  });

  it("connects to all 3 servers", () => {
    const statuses = cm.getStatusSnapshot();
    expect(statuses).toHaveLength(3);
    for (const s of statuses) {
      expect(s.status).toBe("connected");
    }
  });

  it("fetches schemas from all servers", async () => {
    const schemas = await schemaCache.fetchAll(["github", "postgres", "slack"]);
    expect(schemas.size).toBe(3);

    const ghTools = schemas.get("github")!.tools;
    expect(ghTools).toHaveLength(2);
    expect(ghTools[0]!.name).toBe("search");

    const pgTools = schemas.get("postgres")!.tools;
    expect(pgTools).toHaveLength(2);
    expect(pgTools[0]!.name).toBe("query");

    const slkTools = schemas.get("slack")!.tools;
    expect(slkTools).toHaveLength(2);
    expect(slkTools[0]!.name).toBe("send_message");

    expect(schemaCache.totalToolCount()).toBe(6);
  });

  it("forwards tool calls to correct servers", async () => {
    const ghResult = await forwarder.forward({
      serverId: "github",
      toolName: "search",
      args: { query: "vitest" },
    });
    expect(ghResult.response.error).toBeUndefined();
    expect(ghResult.serverId).toBe("github");
    expect(ghResult.latencyMs).toBeLessThan(100);

    const pgResult = await forwarder.forward({
      serverId: "postgres",
      toolName: "query",
      args: { sql: "SELECT 1" },
    });
    expect(pgResult.response.error).toBeUndefined();
    expect(pgResult.serverId).toBe("postgres");

    const slkResult = await forwarder.forward({
      serverId: "slack",
      toolName: "send_message",
      args: { channel: "#general", text: "hello" },
    });
    expect(slkResult.response.error).toBeUndefined();
    expect(slkResult.serverId).toBe("slack");
  });

  it("returns structured error for unknown server", async () => {
    const result = await forwarder.forward({
      serverId: "nonexistent",
      toolName: "anything",
      args: {},
    });
    expect(result.response.error).toBeDefined();
    expect(result.response.error!.code).toBe(-32001);
    expect(result.response.error!.message).toContain("Unknown server");
  });

  it("isolates tool namespaces — each server has its own tool list", async () => {
    const schemas = await schemaCache.fetchAll(["github", "postgres", "slack"]);
    const allToolNames = new Set<string>();

    for (const [, entry] of schemas) {
      for (const tool of entry.tools) {
        allToolNames.add(`${entry.serverId}::${tool.name}`);
      }
    }

    expect(allToolNames.has("github::search")).toBe(true);
    expect(allToolNames.has("postgres::query")).toBe(true);
    expect(allToolNames.has("slack::send_message")).toBe(true);
    expect(allToolNames.size).toBe(6);
  });

  it("schema cache returns cached result on second call", async () => {
    await schemaCache.fetchSchema("github");
    const cached = schemaCache.getCached("github");
    expect(cached).toBeDefined();
    expect(cached!.tools).toHaveLength(2);

    const second = await schemaCache.fetchSchema("github");
    expect(second.fetchedAt).toBe(cached!.fetchedAt);
  });

  it("schema cache invalidates correctly", async () => {
    await schemaCache.fetchSchema("github");
    expect(schemaCache.getCached("github")).toBeDefined();

    schemaCache.invalidate("github");
    expect(schemaCache.getCached("github")).toBeUndefined();
  });

  it("runs 50 tool calls across all servers without errors", async () => {
    const servers = ["github", "postgres", "slack"];
    const tools: Record<string, string[]> = {
      github: ["search", "create_issue"],
      postgres: ["query", "list_tables"],
      slack: ["send_message", "list_channels"],
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const server = servers[i % 3]!;
        const serverTools = tools[server]!;
        const tool = serverTools[i % serverTools.length]!;
        return forwarder.forward({
          serverId: server,
          toolName: tool,
          args: { i },
        });
      })
    );

    for (const result of results) {
      expect(result.response.error).toBeUndefined();
      expect(result.latencyMs).toBeLessThan(200);
    }
  });
});
