import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ConnectionManager } from "../router/client/connection-manager.js";
import { SchemaCache } from "../router/client/schema-cache.js";
import { Forwarder } from "../router/client/forwarder.js";
import { HealthChecker } from "../router/client/health.js";
import { CircuitBreaker } from "../router/circuit-breaker.js";
import type { ProxiedServerConfig } from "../config/router-config-writer.js";
import type {
  McpTransport,
  JsonRpcRequest,
  JsonRpcResponse,
  TransportState,
} from "../router/client/transport.js";

class MockTransport implements McpTransport {
  state: TransportState = "disconnected";
  readonly id: string;
  shouldFail = false;
  sendShouldFail = false;

  constructor(id: string) {
    this.id = id;
  }

  async connect(): Promise<void> {
    if (this.shouldFail) {
      this.state = "error";
      throw new Error(`MockTransport(${this.id}) connect failed`);
    }
    this.state = "connected";
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.sendShouldFail) {
      throw new Error(`MockTransport(${this.id}) send failed`);
    }

    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: `${this.id}_tool`, description: `Tool from ${this.id}` }] },
      };
    }

    if (request.method === "tools/call") {
      const params = request.params as { name: string };
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: `[${this.id}] OK: ${params.name}` }] },
      };
    }

    if (request.method === "ping") {
      return { jsonrpc: "2.0", id: request.id, result: {} };
    }

    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown" } };
  }

  async close(): Promise<void> {
    this.state = "disconnected";
  }
}

function createMockCM(
  mocks: Map<string, MockTransport>,
): ConnectionManager {
  const cm = new ConnectionManager();

  cm.connectAll = async (configs: readonly ProxiedServerConfig[]) => {
    const failures: string[] = [];
    for (const config of configs) {
      const mock = mocks.get(config.name);
      if (!mock) { failures.push(config.name); continue; }

      const managed = {
        config,
        transport: mock as McpTransport,
        status: "idle" as any,
        restartCount: 0,
        lastError: null as string | null,
        lastConnectedAt: null as number | null,
      };

      (cm as any).servers.set(config.name, managed);
      try {
        managed.status = "connecting";
        await mock.connect();
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

function makeConfig(name: string): ProxiedServerConfig {
  return { name, alias: name.slice(0, 2), command: "mock", args: [], sourceAgent: "test" };
}

describe("Router Failure Isolation", () => {
  let mocks: Map<string, MockTransport>;
  let cm: ConnectionManager;
  let forwarder: Forwarder;
  let schemaCache: SchemaCache;

  beforeEach(async () => {
    mocks = new Map([
      ["server-a", new MockTransport("server-a")],
      ["server-b", new MockTransport("server-b")],
      ["server-c", new MockTransport("server-c")],
    ]);

    cm = createMockCM(mocks);
    await cm.connectAll([makeConfig("server-a"), makeConfig("server-b"), makeConfig("server-c")]);

    schemaCache = new SchemaCache(cm);
    forwarder = new Forwarder(cm);
  });

  afterEach(async () => {
    await cm.shutdown();
  });

  it("one server failing does not affect other servers", async () => {
    const bTransport = mocks.get("server-b")!;
    bTransport.sendShouldFail = true;

    const aResult = await forwarder.forward({
      serverId: "server-a",
      toolName: "test",
      args: {},
    });
    expect(aResult.response.error).toBeUndefined();

    const bResult = await forwarder.forward({
      serverId: "server-b",
      toolName: "test",
      args: {},
    });
    expect(bResult.response.error).toBeDefined();
    expect(bResult.response.error!.code).toBe(-32003);

    const cResult = await forwarder.forward({
      serverId: "server-c",
      toolName: "test",
      args: {},
    });
    expect(cResult.response.error).toBeUndefined();
  });

  it("schema fetch failure does not corrupt other servers' caches", async () => {
    await schemaCache.fetchAll(["server-a", "server-b", "server-c"]);
    expect(schemaCache.totalToolCount()).toBe(3);

    schemaCache.invalidate("server-b");
    const bTransport = mocks.get("server-b")!;
    bTransport.sendShouldFail = true;

    const refreshed = await schemaCache.fetchAll(["server-a", "server-b", "server-c"]);
    expect(refreshed.get("server-a")).toBeDefined();
    expect(refreshed.get("server-b")).toBeUndefined();
    expect(refreshed.get("server-c")).toBeDefined();
  });

  it("forwarder returns structured error for disconnected server", async () => {
    const managed = cm.getServer("server-a")!;
    (managed as any).status = "error";

    const result = await forwarder.forward({
      serverId: "server-a",
      toolName: "test",
      args: {},
    });
    expect(result.response.error).toBeDefined();
    expect(result.response.error!.code).toBe(-32002);
    expect(result.response.error!.message).toContain("error");
  });

  it("isServerAvailable returns false for unhealthy servers", () => {
    expect(forwarder.isServerAvailable("server-a")).toBe(true);

    const managed = cm.getServer("server-a")!;
    (managed as any).status = "error";
    expect(forwarder.isServerAvailable("server-a")).toBe(false);
  });

  it("connection manager tracks restart count", async () => {
    const managed = cm.getServer("server-a")!;
    expect(managed.restartCount).toBe(0);

    (managed as any).status = "error";
    const snapshot = cm.getStatusSnapshot();
    const aStatus = snapshot.find((s) => s.serverId === "server-a");
    expect(aStatus!.status).toBe("error");
  });
});

describe("Circuit Breaker", () => {
  let breaker: CircuitBreaker;
  let tripCount: number;
  let recoverCount: number;

  beforeEach(() => {
    tripCount = 0;
    recoverCount = 0;
    breaker = new CircuitBreaker(
      {
        onTrip: () => tripCount++,
        onRecover: () => recoverCount++,
      },
      3,
      100,
    );
  });

  afterEach(() => {
    breaker.shutdown();
  });

  it("starts in closed state", () => {
    expect(breaker.state).toBe("closed");
    expect(breaker.isPassthrough).toBe(false);
  });

  it("trips after 3 consecutive failures", () => {
    breaker.recordFailure("err1");
    expect(breaker.state).toBe("closed");
    breaker.recordFailure("err2");
    expect(breaker.state).toBe("closed");
    breaker.recordFailure("err3");
    expect(breaker.state).toBe("open");
    expect(breaker.isPassthrough).toBe(true);
    expect(tripCount).toBe(1);
  });

  it("success resets failure count", () => {
    breaker.recordFailure("err1");
    breaker.recordFailure("err2");
    breaker.recordSuccess();
    breaker.recordFailure("err3");
    expect(breaker.state).toBe("closed");
  });

  it("manual trip enters passthrough immediately", () => {
    breaker.trip("catastrophic failure");
    expect(breaker.state).toBe("open");
    expect(breaker.tripReason).toBe("catastrophic failure");
  });

  it("half-open allows one test, success closes", () => {
    breaker.trip("test");
    breaker.attemptRecovery();
    expect(breaker.state).toBe("half-open");

    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    expect(recoverCount).toBe(1);
  });

  it("half-open failure re-opens", () => {
    breaker.trip("test");
    breaker.attemptRecovery();

    breaker.recordFailure("still broken");
    breaker.recordFailure("still broken");
    breaker.recordFailure("still broken");
    expect(breaker.state).toBe("open");
  });

  it("execute() uses fallback when open", async () => {
    breaker.trip("test");

    const result = await breaker.execute(
      async () => "real",
      () => "fallback",
    );
    expect(result).toBe("fallback");
  });

  it("execute() uses real function when closed", async () => {
    const result = await breaker.execute(
      async () => "real",
      () => "fallback",
    );
    expect(result).toBe("real");
  });

  it("execute() records failure on throw", async () => {
    try {
      await breaker.execute(
        async () => { throw new Error("boom"); },
        () => "fallback",
      );
    } catch {
      // expected
    }

    const snap = breaker.getSnapshot();
    expect(snap.failureCount).toBe(1);
  });

  it("auto-recovery transitions to half-open", async () => {
    breaker.trip("test");
    expect(breaker.state).toBe("open");

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.state).toBe("half-open");
  });

  it("getSnapshot returns diagnostic info", () => {
    breaker.trip("diagnostic test");
    const snap = breaker.getSnapshot();
    expect(snap.state).toBe("open");
    expect(snap.tripReason).toBe("diagnostic test");
    expect(snap.tripAt).toBeGreaterThan(0);
  });
});

describe("Health Checker", () => {
  let mocks: Map<string, MockTransport>;
  let cm: ConnectionManager;
  let schemaCache: SchemaCache;
  let healthChecker: HealthChecker;

  beforeEach(async () => {
    mocks = new Map([
      ["healthy-server", new MockTransport("healthy-server")],
      ["flaky-server", new MockTransport("flaky-server")],
    ]);

    cm = createMockCM(mocks);
    await cm.connectAll([makeConfig("healthy-server"), makeConfig("flaky-server")]);

    schemaCache = new SchemaCache(cm);
    healthChecker = new HealthChecker(cm, schemaCache, 60_000);
  });

  afterEach(async () => {
    healthChecker.stop();
    await cm.shutdown();
  });

  it("reports all servers healthy initially", async () => {
    healthChecker.start(["healthy-server", "flaky-server"]);

    const ok = await healthChecker.check("healthy-server");
    expect(ok).toBe(true);

    const statuses = healthChecker.getHealthStatuses();
    expect(statuses).toHaveLength(2);
  });

  it("marks server unhealthy after 3 consecutive ping failures", async () => {
    healthChecker.start(["flaky-server"]);

    const flakyTransport = mocks.get("flaky-server")!;
    flakyTransport.sendShouldFail = true;

    await healthChecker.check("flaky-server");
    await healthChecker.check("flaky-server");
    await healthChecker.check("flaky-server");

    const status = healthChecker.getHealth("flaky-server");
    expect(status).toBeDefined();
    expect(status!.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it("healthy server unaffected by flaky server", async () => {
    healthChecker.start(["healthy-server", "flaky-server"]);

    const flakyTransport = mocks.get("flaky-server")!;
    flakyTransport.sendShouldFail = true;

    await healthChecker.check("healthy-server");
    const healthyStatus = healthChecker.getHealth("healthy-server");
    expect(healthyStatus!.healthy).toBe(true);
    expect(healthyStatus!.consecutiveFailures).toBe(0);
  });

  it("success resets consecutive failures", async () => {
    healthChecker.start(["flaky-server"]);
    const flakyTransport = mocks.get("flaky-server")!;

    flakyTransport.sendShouldFail = true;
    await healthChecker.check("flaky-server");
    await healthChecker.check("flaky-server");

    flakyTransport.sendShouldFail = false;
    await healthChecker.check("flaky-server");

    const status = healthChecker.getHealth("flaky-server");
    expect(status!.consecutiveFailures).toBe(0);
    expect(status!.healthy).toBe(true);
  });
});
