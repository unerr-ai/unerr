import { describe, expect, it, vi } from "vitest";

import {
  type RouterRouteDeps,
  type ServerHealthInfo,
  createRouterRoutes,
} from "../server/routes/router.js";

function makeDeps(overrides: Partial<RouterRouteDeps> = {}): RouterRouteDeps {
  return {
    getRouterConfig: () => ({
      version: 1 as const,
      enabled: true,
      enabledAt: "2025-01-01T00:00:00.000Z",
      proxiedServers: [
        { name: "github", alias: "gh", sourceAgent: "cursor" },
        { name: "postgres", alias: "pg", sourceAgent: "cursor" },
      ],
      rewrittenConfigs: [],
    }),
    getSessionSummary: () => null,
    readAllRecords: vi.fn().mockResolvedValue([]),
    aggregateRecords: vi.fn().mockReturnValue([]),
    groupRecords: vi.fn().mockReturnValue(new Map()),
    aggregateSingle: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function makeHealthyServer(
  id: string,
  name: string,
  alias: string
): ServerHealthInfo {
  return {
    id,
    name,
    alias,
    status: "healthy",
    lastPingMs: 3,
    lastError: null,
    restartCount: 0,
    lastRestartAt: null,
    upSince: new Date().toISOString(),
    toolCount: 10,
  };
}

function makeUnhealthyServer(
  id: string,
  name: string,
  alias: string
): ServerHealthInfo {
  return {
    id,
    name,
    alias,
    status: "unhealthy",
    lastPingMs: null,
    lastError: "Connection refused",
    restartCount: 2,
    lastRestartAt: new Date().toISOString(),
    upSince: null,
    toolCount: 10,
  };
}

describe("Router server health REST API", () => {
  // ── GET /servers ───────────────────────────────────────────────

  it("returns server health list", async () => {
    const servers = [
      makeHealthyServer("gh", "github", "gh"),
      makeHealthyServer("pg", "postgres", "pg"),
    ];
    const deps = makeDeps({
      getServerHealth: () => servers,
    });

    const app = createRouterRoutes(deps);
    const res = await app.request("/servers");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.servers).toHaveLength(2);
    expect(body.data.servers[0].id).toBe("gh");
    expect(body.data.servers[0].status).toBe("healthy");
  });

  it("returns empty servers when health tracking unavailable", async () => {
    const deps = makeDeps({ getServerHealth: undefined });

    const app = createRouterRoutes(deps);
    const res = await app.request("/servers");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.servers).toEqual([]);
    expect(body._meta.hint).toBeDefined();
  });

  it("includes unhealthy server details", async () => {
    const servers = [makeUnhealthyServer("gh", "github", "gh")];
    const deps = makeDeps({ getServerHealth: () => servers });

    const app = createRouterRoutes(deps);
    const res = await app.request("/servers");
    const body = await res.json();

    expect(body.data.servers[0].status).toBe("unhealthy");
    expect(body.data.servers[0].lastError).toBe("Connection refused");
    expect(body.data.servers[0].restartCount).toBe(2);
  });

  // ── POST /servers/:id/restart ──────────────────────────────────

  it("restarts a server by ID", async () => {
    const restarted: ServerHealthInfo = {
      ...makeHealthyServer("gh", "github", "gh"),
      restartCount: 1,
    };

    const deps = makeDeps({
      restartServer: vi.fn().mockResolvedValue(restarted),
    });

    const app = createRouterRoutes(deps);
    const res = await app.request("/servers/gh/restart", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.server.id).toBe("gh");
    expect(body.data.server.restartCount).toBe(1);
    expect(deps.restartServer).toHaveBeenCalledWith("gh");
  });

  it("returns 404 for unknown server ID", async () => {
    const deps = makeDeps({
      restartServer: vi.fn().mockResolvedValue(null),
    });

    const app = createRouterRoutes(deps);
    const res = await app.request("/servers/unknown/restart", {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("unknown");
  });

  it("returns 503 when restart not available (gateway not running)", async () => {
    const deps = makeDeps({ restartServer: undefined });

    const app = createRouterRoutes(deps);
    const res = await app.request("/servers/gh/restart", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toContain("not available");
  });

  // ── GET /insights ──────────────────────────────────────────────

  it("returns nudge accuracy and collision rewrite stats", async () => {
    const deps = makeDeps({
      getNudgeStats: () => ({
        totalNudges: 10,
        totalFollowed: 7,
        accuracyRate: 0.7,
      }),
      getCollisionRewriteCount: () => 3,
    });

    const app = createRouterRoutes(deps);
    const res = await app.request("/insights");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.nudgeAccuracy.totalNudges).toBe(10);
    expect(body.data.nudgeAccuracy.totalFollowed).toBe(7);
    expect(body.data.nudgeAccuracy.accuracyRate).toBe(0.7);
    expect(body.data.collisionRewrites).toBe(3);
  });

  it("returns zero defaults when deps not provided", async () => {
    const deps = makeDeps();

    const app = createRouterRoutes(deps);
    const res = await app.request("/insights");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.nudgeAccuracy.totalNudges).toBe(0);
    expect(body.data.collisionRewrites).toBe(0);
  });

  // ── End-to-end restart flow ────────────────────────────────────

  it("simulates crash → restart → healthy flow", async () => {
    const crashed = makeUnhealthyServer("gh", "github", "gh");
    const recovered: ServerHealthInfo = {
      ...crashed,
      status: "healthy",
      lastPingMs: 5,
      lastError: null,
      restartCount: crashed.restartCount + 1,
      upSince: new Date().toISOString(),
    };

    const deps = makeDeps({
      getServerHealth: () => [crashed],
      restartServer: vi.fn().mockResolvedValue(recovered),
    });

    const app = createRouterRoutes(deps);

    const healthRes = await app.request("/servers");
    const healthBody = await healthRes.json();
    expect(healthBody.data.servers[0].status).toBe("unhealthy");

    const restartRes = await app.request("/servers/gh/restart", {
      method: "POST",
    });
    const restartBody = await restartRes.json();
    expect(restartRes.status).toBe(200);
    expect(restartBody.data.server.status).toBe("healthy");
    expect(restartBody.data.server.restartCount).toBe(3);
  });
});
