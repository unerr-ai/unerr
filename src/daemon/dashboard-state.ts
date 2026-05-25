/**
 * Dashboard port discovery file — `~/.unerr/state/dashboard.json`.
 *
 * The unerrd dashboard binds a sliding port (DAEMON_DASHBOARD_PORT, then the
 * next free port up to +DAEMON_DASHBOARD_PORT_SCAN_RANGE). Because the port is
 * no longer fixed, the actually-bound port must be discoverable by separate
 * CLI processes (`pm status`, `pm dashboard`, the bridge start message) that
 * cannot see the daemon's in-memory handle. The daemon writes this file on
 * successful bind and removes it on shutdown.
 *
 * Liveness is NOT implied by the file's existence — a crashed daemon may leave
 * a stale file. Callers gate trust on the UDS probe (probeDaemon) and treat
 * this file purely as the port lookup once the daemon is known to be alive.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { daemonDashboardUrl } from "./protocol.js";
import { globalDir } from "./registry.js";

export interface DashboardState {
  /** Actually-bound dashboard port (may differ from the default after sliding). */
  port: number;
  /** unerrd PID that owns this dashboard. */
  pid: number;
  /** ISO timestamp of the bind. */
  startedAt: string;
  /** Convenience URL — `http://localhost:<port>`. */
  url: string;
}

/** Absolute path to the dashboard discovery file. */
export function dashboardStatePath(): string {
  return join(globalDir(), "state", "dashboard.json");
}

/** Atomically write the bound port so other processes can discover the URL. */
export function writeDashboardState(port: number): void {
  const stateDir = join(globalDir(), "state");
  mkdirSync(stateDir, { recursive: true });
  const state: DashboardState = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    url: daemonDashboardUrl(port),
  };
  const path = dashboardStatePath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Read the bound port. Returns null when missing or malformed. */
export function readDashboardState(): DashboardState | null {
  try {
    const parsed = JSON.parse(
      readFileSync(dashboardStatePath(), "utf-8")
    ) as Partial<DashboardState>;
    if (typeof parsed.port !== "number" || !Number.isFinite(parsed.port)) {
      return null;
    }
    return {
      port: parsed.port,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      url:
        typeof parsed.url === "string"
          ? parsed.url
          : daemonDashboardUrl(parsed.port),
    };
  } catch {
    return null;
  }
}

/** Remove the discovery file (daemon shutdown). Never throws. */
export function clearDashboardState(): void {
  try {
    rmSync(dashboardStatePath(), { force: true });
  } catch {
    // best-effort — a stale file is gated by the UDS liveness probe anyway
  }
}
