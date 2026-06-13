/**
 * Capture the machine-level facts a fleet report carries: stable identity from
 * the login metadata plus live daemon runtime (uptime, memory, bound port). It
 * reads the keychain-free credential metadata only, so building a snapshot never
 * triggers a keychain prompt or blocks the daemon.
 *
 * @sem domain=infrastructure
 */
import { arch, hostname, platform } from "node:os";
import { readCredentialMetadata } from "../cloud/credentials.js";
import { UNERR_VERSION } from "../version.js";
import { DAEMON_DASHBOARD_PORT } from "./protocol.js";

/** Live runtime of the unerrd process at snapshot time. */
export interface DaemonRuntime {
  pid: number;
  uptime_s: number;
  rss_bytes: number;
  dashboard_port: number;
}

/** Machine identity + runtime, the `machine` block of a fleet report. */
export interface MachineSnapshot {
  machine_name: string;
  os: string;
  arch: string;
  cli_version: string;
  daemon: DaemonRuntime;
}

/** Inputs the caller (the process manager) supplies; all optional for tests. */
export interface MachineSnapshotOptions {
  /** The port the dashboard actually bound (may differ from the default). */
  dashboardPort?: number;
  /** Override the process handle (test seam). */
  proc?: Pick<NodeJS.Process, "pid" | "uptime" | "memoryUsage">;
}

/**
 * Build the machine snapshot from login metadata + the current process. Returns
 * null when there is no login (no `machine_id`), since fleet reporting only runs
 * for an authenticated machine. `machine_name` falls back to the OS hostname
 * when the metadata did not record one (e.g. the CI env-token path).
 *
 * @sem domain=infrastructure
 */
export function buildMachineSnapshot(
  opts: MachineSnapshotOptions = {}
): MachineSnapshot | null {
  const meta = readCredentialMetadata();
  if (!meta || meta.machine_id.length === 0) return null;

  const proc = opts.proc ?? process;
  return {
    machine_name: meta.machine_name.length > 0 ? meta.machine_name : hostname(),
    os: platform(),
    arch: arch(),
    cli_version: UNERR_VERSION,
    daemon: {
      pid: proc.pid,
      uptime_s: Math.round(proc.uptime()),
      rss_bytes: proc.memoryUsage().rss,
      dashboard_port: opts.dashboardPort ?? DAEMON_DASHBOARD_PORT,
    },
  };
}
