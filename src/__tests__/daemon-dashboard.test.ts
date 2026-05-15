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

  it("imports only from daemon/, server/ and node builtins + hono", () => {
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
    expect(content).toContain("registry");
  });

  it("defines all required API routes", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).toContain('"/api/daemon"');
    expect(content).toContain('"/api/repos"');
    expect(content).toContain('"/api/repos/aggregate"');
    expect(content).toContain('"/api/repo/:label/*"');
  });

  it("serves SPA for non-API routes", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).toContain("serveStatic");
    expect(content).toContain("spaIndex");
    expect(content).toContain("c.html(spaHtml)");
  });

  it("uses port 9847 for daemon dashboard", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).toContain("DAEMON_PORT = 9847");
  });
});

// ── Router tests ───────────────────────────────────────────────────

describe("Router (router.ts)", () => {
  it("defines GlobalRouteId and RepoRouteId types", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/router.ts"),
      "utf-8"
    );

    expect(content).toContain("GlobalRouteId");
    expect(content).toContain("RepoRouteId");
    expect(content).toContain('"all-repos"');
    expect(content).toContain('"daemon"');
  });

  it("exports useParsedRoute and useRepoLabel hooks", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/router.ts"),
      "utf-8"
    );

    expect(content).toContain("export function useParsedRoute");
    expect(content).toContain("export function useRepoLabel");
  });

  it("parseHash handles repo/<label>/<route> format", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/router.ts"),
      "utf-8"
    );

    expect(content).toContain('first === "repo"');
    expect(content).toContain("segments[1]");
    expect(content).toContain("segments[2]");
  });

  it("navigateRoute generates repo-prefixed hashes", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/router.ts"),
      "utf-8"
    );

    expect(content).toContain("`#/repo/${repoLabel}`");
    expect(content).toContain("`#/repo/${repoLabel}/${next}`");
  });

  it("preserves backward compatibility with bare routes", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/router.ts"),
      "utf-8"
    );

    // Bare routes still work (standalone mode)
    expect(content).toContain("matchRepoRoute(first)");
    expect(content).toContain("repoLabel: null");
  });
});

// ── Repo context provider tests ────────────────────────────────────

describe("Repo context (repo-context.ts)", () => {
  it("exports RepoContext and useRepoContext", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/repo-context.ts"),
      "utf-8"
    );

    expect(content).toContain("export const RepoContext");
    expect(content).toContain("export function useRepoContext");
    expect(content).toContain("createContext");
  });

  it("includes isDaemonMode and apiBase fields", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/lib/repo-context.ts"),
      "utf-8"
    );

    expect(content).toContain("isDaemonMode: boolean");
    expect(content).toContain("apiBase: string");
    expect(content).toContain("label: string | null");
  });
});

// ── UI pages exist ─────────────────────────────────────────────────

describe("UI pages", () => {
  it("AllReposPage.tsx exists and exports component", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/pages/AllReposPage.tsx"),
      "utf-8"
    );

    expect(content).toContain("export function AllReposPage");
    expect(content).toContain("/api/repos");
    expect(content).toContain("/api/repos/aggregate");
  });

  it("AllReposPage shows aggregated metrics", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/pages/AllReposPage.tsx"),
      "utf-8"
    );

    expect(content).toContain("totalEntities");
    expect(content).toContain("totalMemoryMb");
    expect(content).toContain("Tokens Saved");
    expect(content).toContain("Tool Calls");
  });

  it("DaemonPage.tsx exists and exports component", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/pages/DaemonPage.tsx"),
      "utf-8"
    );

    expect(content).toContain("export function DaemonPage");
    expect(content).toContain("/api/daemon");
    expect(content).toContain("Supervisor");
  });

  it("DaemonPage shows process table", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/pages/DaemonPage.tsx"),
      "utf-8"
    );

    expect(content).toContain("Managed Processes");
    expect(content).toContain("repo.pid");
    expect(content).toContain("repo.memory");
  });
});

// ── AppShell updates ───────────────────────────────────────────────

describe("AppShell (layout)", () => {
  it("supports daemon mode with repo switcher", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/components/layout/AppShell.tsx"),
      "utf-8"
    );

    expect(content).toContain("isDaemonMode");
    expect(content).toContain("GLOBAL_NAV");
    expect(content).toContain("REPO_NAV");
    expect(content).toContain("repoLabel");
  });

  it("shows status dots for repo list", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/components/layout/AppShell.tsx"),
      "utf-8"
    );

    expect(content).toContain("bg-success");
    expect(content).toContain("bg-error");
    expect(content).toContain("r.status");
  });

  it("falls back to standalone nav when not in daemon mode", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/components/layout/AppShell.tsx"),
      "utf-8"
    );

    expect(content).toContain("{!isDaemonMode && (");
  });
});

// ── App.tsx integration ────────────────────────────────────────────

describe("App.tsx integration", () => {
  it("detects daemon mode via /api/daemon", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/App.tsx"),
      "utf-8"
    );

    expect(content).toContain("isDaemonMode");
    expect(content).toContain('["daemon", "info"]');
    expect(content).toContain("/api/daemon");
  });

  it("renders global pages (AllReposPage, DaemonPage)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/App.tsx"),
      "utf-8"
    );

    expect(content).toContain("<AllReposPage");
    expect(content).toContain("<DaemonPage");
    expect(content).toContain('case "all-repos"');
    expect(content).toContain('case "daemon"');
  });

  it("provides RepoContext", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/App.tsx"),
      "utf-8"
    );

    expect(content).toContain("RepoContext.Provider");
    expect(content).toContain("repoCtx");
    expect(content).toContain("apiBase");
  });

  it("passes repos list and repoLabel to AppShell", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/ui/App.tsx"),
      "utf-8"
    );

    expect(content).toContain("repos={repos}");
    expect(content).toContain("repoLabel={parsed.repoLabel}");
    expect(content).toContain("isDaemonMode={isDaemonMode}");
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

// ── Proxy route design ─────────────────────────────────────────────

describe("Proxy route design", () => {
  it("api.ts reads server.json for per-repo HTTP port", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).toContain("server.json");
    expect(content).toContain("repoPort");
    expect(content).toContain("proxyToRepoHttp");
  });

  it("strips /api/repo/:label prefix before proxying", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/api.ts"),
      "utf-8"
    );

    expect(content).toContain("c.req.path.replace");
    expect(content).toContain("remaining");
  });
});
