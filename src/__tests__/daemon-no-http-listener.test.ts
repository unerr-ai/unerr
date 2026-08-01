/**
 * Guard: unerrd binds no HTTP port.
 *
 * The process manager used to run a loopback HTTP server (`GET /api/pm` on a
 * sliding 9847-9947 bind, with `~/.unerr/state/dashboard.json` for port
 * discovery). It was built for the dashboard SPA; once that was archived the
 * route had zero production callers, and an unauthenticated listening socket on
 * every developer machine is the shape AV/EDR flags. It was removed along with
 * `src/daemon/api.ts`, `src/daemon/dashboard-state.ts`, and the `hono` /
 * `@hono/node-server` dependencies.
 *
 * Local callers use the UDS control socket (`~/.unerr/unerrd.sock`); everything
 * that leaves the machine goes over the cloud push path. This file fails if
 * either surface comes back. See CLAUDE.md rule #8.
 *
 * One exception exists on purpose, and CLAUDE.md rule #8 now names it:
 * `src/proxy/pid-lock.ts` binds a `node:http` server on `127.0.0.1` port `0`
 * (OS-assigned, ephemeral). `acquire()` uses it — via `checkHealthWithRetry`
 * — to tell a live proxy from a wedged one from a stale PID file before
 * deciding whether to become primary; without it two proxies could open the
 * same `graph.db` at once. It is loopback-only, port-0, and per-process, none
 * of the shape that made the daemon's HTTP API an AV/EDR flag, so it stays.
 * This file pins that exception down: it asserts the probe still binds
 * `127.0.0.1`/`0` (not `0.0.0.0` or a fixed port) and that no other source
 * file creates a second one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf-8");
}

/** Every `.ts` file under `dir`, recursing, skipping `__tests__` dirs. */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("unerrd binds no HTTP port", () => {
  it("the daemon HTTP API module and its port-discovery file stay deleted", () => {
    expect(existsSync(join(repoRoot, "src/daemon/api.ts"))).toBe(false);
    expect(existsSync(join(repoRoot, "src/daemon/dashboard-state.ts"))).toBe(
      false
    );
  });

  it("daemon.ts starts no HTTP server", () => {
    const content = read("src/entrypoints/daemon.ts");
    expect(content).not.toContain("startDaemonApi");
    expect(content).not.toContain("apiHandle");
    expect(content).not.toContain("http://localhost");
  });

  it("no source file imports an HTTP server framework", () => {
    // Both packages were removed from package.json when api.ts went. A new
    // import would reintroduce the dependency AND the listening socket.
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(deps).not.toHaveProperty("hono");
    expect(deps).not.toHaveProperty("@hono/node-server");
  });

  it("the UDS protocol carries no dashboard-state command", () => {
    // `dashboard-state` returned `pm.getStatus()` — byte-identical to `status`,
    // which every real caller already uses.
    const content = read("src/daemon/protocol.ts");
    expect(content).not.toContain('"dashboard-state"');
    expect(content).not.toContain("DAEMON_DASHBOARD_PORT_SCAN_RANGE");
    expect(content).not.toContain("daemonDashboardUrl");
  });

  it("the per-repo proxy starts no HTTP transport either", () => {
    // `src/proxy/http-transport.ts` served POST/GET /mcp + /health, opt-in via
    // UNERR_HTTP_PORT. Nothing set the env var and no test covered it, and its
    // bearer check keyed on an `apiKey` option the single call site never
    // passed — turning it on served the full MCP tool suite unauthenticated.
    expect(existsSync(join(repoRoot, "src/proxy/http-transport.ts"))).toBe(
      false
    );
    // Assert on the module specifier, not the function name — the comment in
    // proxy.ts that explains the removal names the function on purpose, and a
    // guard that forbids describing the thing is a guard that gets deleted.
    expect(read("src/proxy/proxy.ts")).not.toContain("http-transport.js");
    expect(read("src/entrypoints/cli-main.ts")).not.toContain(
      "UNERR_HTTP_PORT"
    );
  });

  it("keeps DAEMON_DASHBOARD_PORT only as the contract wire value", () => {
    // `dashboard_port` is a required field on the @unerr-ai/contracts
    // machine-snapshot body, so the fleet report still has to send a number.
    // Dropping the field needs the cross-repo contract change order.
    const content = read("src/daemon/protocol.ts");
    expect(content).toContain("DAEMON_DASHBOARD_PORT = 9847");
    expect(content).toContain("Nothing binds this port");
  });

  it("pid-lock.ts's health probe stays loopback + ephemeral, not fixed or wildcard", () => {
    const content = read("src/proxy/pid-lock.ts");
    expect(content).toContain('from "node:http"');
    expect(content).toMatch(/\.listen\(\s*0\s*,\s*["']127\.0\.0\.1["']/);
    expect(content).not.toMatch(/0\.0\.0\.0/);
  });

  it("no source file other than pid-lock.ts creates a node:http or node:https server", () => {
    const srcDir = join(repoRoot, "src");
    const pidLock = join(srcDir, "proxy", "pid-lock.ts");
    // Matches an actual import of the http/https module, not the bare word
    // `createServer` — src/proxy/transport-mux.ts legitimately calls
    // `createServer` from `node:net` for its Unix-socket multiplexer (and
    // layers an HTTP-shaped `/commit-context` handler on top of that UDS
    // connection), and must not trip this guard.
    //
    // Covers every specifier form that reaches the module, not just the one
    // the codebase happens to use today: `from`, `require(`, and `import(`,
    // with or without the `node:` prefix. Nothing in `src/` imports bare
    // `"http"` right now and no lint rule forbids it (biome's
    // `useNodejsImportProtocol` is not enabled), so a prefix-only matcher
    // would let `import http from "http"` reintroduce a listener silently.
    // A URL literal cannot false-positive: the closing quote must follow
    // `http`/`https` immediately, so `"https://example.com"` never matches.
    const httpModuleImport =
      /\b(?:from|require|import)\s*\(?\s*["'](?:node:)?https?["']/;
    const offenders = collectTsFiles(srcDir)
      .filter((file) => file !== pidLock)
      .filter((file) => httpModuleImport.test(readFileSync(file, "utf-8")))
      .map((file) => file.slice(repoRoot.length + 1));
    expect(offenders).toEqual([]);
  });
});
