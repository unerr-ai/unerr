/**
 * Sliding-port discovery + dashboard-state discovery file.
 *
 * Guarantees:
 *  1. `writeDashboardState` / `readDashboardState` / `clearDashboardState`
 *     round-trip the bound port through ~/.unerr/state/dashboard.json.
 *  2. Malformed / missing files read back as null (caller falls back).
 *  3. `startDaemonApi` binds the default port when free and records it.
 *  4. When the first free port is occupied, the daemon SLIDES to a higher
 *     port instead of giving up, and records the actually-bound port.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDaemonApi } from "../daemon/api.js";
import {
  clearDashboardState,
  dashboardStatePath,
  readDashboardState,
  writeDashboardState,
} from "../daemon/dashboard-state.js";
import { DAEMON_DASHBOARD_PORT } from "../daemon/protocol.js";

// startDaemonApi only touches `pm` inside route handlers (never during
// startup), so an empty object is a safe stand-in for the bind path.
const mockPm = {} as Parameters<typeof startDaemonApi>[0];

let home: string;

beforeEach(() => {
  home = join(
    tmpdir(),
    `unerr-dash-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(home, { recursive: true });
  // globalDir() resolves `${UNERR_HOME}/.unerr`, so point it at our temp dir.
  // stubEnv restores the original value (incl. unset) on unstub — no leak.
  vi.stubEnv("UNERR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("dashboard-state discovery file", () => {
  it("round-trips the bound port", () => {
    writeDashboardState(12345);
    const state = readDashboardState();
    expect(state?.port).toBe(12345);
    expect(state?.url).toBe("http://localhost:12345");
    expect(state?.pid).toBe(process.pid);
  });

  it("returns null when the file is missing", () => {
    clearDashboardState();
    expect(readDashboardState()).toBeNull();
  });

  it("returns null when the file is malformed", () => {
    mkdirSync(dirname(dashboardStatePath()), { recursive: true });
    writeFileSync(dashboardStatePath(), "{ not valid json");
    expect(readDashboardState()).toBeNull();
  });

  it("returns null when port is absent / non-numeric", () => {
    mkdirSync(dirname(dashboardStatePath()), { recursive: true });
    writeFileSync(dashboardStatePath(), JSON.stringify({ pid: 1 }));
    expect(readDashboardState()).toBeNull();
  });
});

/** Bind the first free loopback port at/above `start`, keeping it occupied. */
async function occupyFirstFree(
  start: number
): Promise<{ port: number; server: Server }> {
  for (let port = start; port <= start + 100; port++) {
    const server = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.once("listening", () => resolve(true));
      server.listen(port, "127.0.0.1");
    });
    if (ok) return { port, server };
  }
  throw new Error("no free port in range for test setup");
}

describe("startDaemonApi sliding-port discovery", () => {
  it("binds an in-range port and records it to dashboard.json", async () => {
    const handle = await startDaemonApi(mockPm);
    expect(handle).not.toBeNull();
    const port = handle?.port ?? 0;
    expect(port).toBeGreaterThanOrEqual(DAEMON_DASHBOARD_PORT);
    expect(port).toBeLessThanOrEqual(DAEMON_DASHBOARD_PORT + 100);

    const state = readDashboardState();
    expect(state?.port).toBe(port);
    expect(state?.url).toBe(`http://localhost:${port}`);

    handle?.close();
    // close() removes the discovery file.
    expect(readDashboardState()).toBeNull();
  });

  it("slides past an occupied port instead of giving up", async () => {
    const blocker = await occupyFirstFree(DAEMON_DASHBOARD_PORT);
    try {
      const handle = await startDaemonApi(mockPm);
      expect(handle).not.toBeNull();
      // The first free port is held by the blocker, so the daemon must bind higher.
      expect(handle?.port ?? 0).toBeGreaterThan(blocker.port);
      expect(readDashboardState()?.port).toBe(handle?.port);
      handle?.close();
    } finally {
      blocker.server.close();
    }
  });
});
