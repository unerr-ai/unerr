/**
 * DM-4: Unified Dashboard tests.
 *
 * Tests cover:
 *   - Daemon API module (api.ts): exports, route structure, isolation
 *   - Router: global routes, repo-prefixed routes, backward compatibility
 *   - Repo context provider
 *   - UI pages: AllReposPage, DaemonPage exist and export components
 *   - AppShell: daemon mode + standalone mode
 *   - daemon.ts integration: HTTP server startup
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Daemon API module tests ────────────────────────────────────────

describe("Daemon API (api.ts)", () => {
  it("exports startDaemonApi", async () => {
    const api = await import("../daemon/api.js");
    expect(typeof api.startDaemonApi).toBe("function");
  });

  it("imports only from daemon/ and node builtins + hono", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    const forbidden = [
      /from\s+["']\.\.\/intelligence\//,
      /from\s+["']\.\.\/behaviors\//,
      /from\s+["']\.\.\/tracking\//,
    ];

    for (const pattern of forbidden) {
      expect(content).not.toMatch(pattern);
    }

    expect(content).toContain('from "hono"');
    expect(content).toContain("process-manager");
  });

  it("exposes only GET /api/pm and a catch-all 404", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).toContain('"/api/pm"');
    expect(content).not.toContain('"/api/repos"');
    expect(content).not.toContain('"/api/repos/aggregate"');
    expect(content).not.toContain('"/api/repo/:label/*"');
    expect(content).toContain("not_found");
    expect(content).toContain("unerrd exposes only GET /api/pm");
  });

  it("derives the dashboard port from the shared protocol constant", () => {
    const protocol = readFileSync(
      resolve(process.cwd(), "src/daemon/protocol.ts"),
      "utf-8"
    );
    expect(protocol).toContain("DAEMON_DASHBOARD_PORT = 9847");

    const api = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );
    // No hardcoded literal — port comes from the shared constant.
    expect(api).toContain("DAEMON_DASHBOARD_PORT as DAEMON_PORT");
    expect(api).not.toContain("DAEMON_PORT = 9847");
  });

  it("scans for a free port (sliding discovery) instead of giving up", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );
    expect(content).toContain("findDaemonPort");
    expect(content).toContain("DAEMON_DASHBOARD_PORT_SCAN_RANGE");
    expect(content).toContain("writeDashboardState");
  });
});

// ── daemon.ts HTTP integration ─────────────────────────────────────

describe("daemon.ts HTTP integration", () => {
  it("starts the dashboard API server", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    expect(content).toContain("startDaemonApi");
    expect(content).toContain("apiHandle");
    expect(content).toContain("http://localhost");
  });

  it("closes HTTP server on shutdown", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    expect(content).toContain("apiHandle?.close()");
  });
});

// ── Proxy route removed ─────────────────────────────────────────────

describe("Proxy route design", () => {
  it("api.ts no longer contains per-repo proxy logic", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).not.toContain("server.json");
    expect(content).not.toContain("repoPort");
    expect(content).not.toContain("proxyToRepoHttp");
    expect(content).not.toContain("c.req.path.replace");
    expect(content).not.toContain('"/api/repo/:label/*"');
  });
});
