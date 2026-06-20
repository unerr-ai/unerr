import {
  FLEET_SCHEMA_VERSION as CONTRACT_FLEET_SCHEMA_VERSION,
  FLEET_MAX_REPOS_PER_REPORT,
  FleetCheckinBody,
  FleetInventoryBody,
} from "@unerr-ai/contracts/fleet";
import { validateBody } from "../cloud/drainers/validate.js";
import { startupLog } from "../utils/startup-log.js";
import { type GitOrigin, detectGitOrigin } from "./git-origin.js";
import {
  type DaemonRuntime,
  type MachineSnapshot,
  type MachineSnapshotOptions,
  buildMachineSnapshot,
} from "./machine-snapshot.js";
import type { RepoStatus, RepoStatusEntry } from "./protocol.js";
/**
 * Assemble the two fleet-report payloads from local state only: the full
 * inventory (machine + every managed repo with its origin, ports, and live
 * status) and the lightweight heartbeat (machine liveness + per-repo status).
 * Both are built from one join so they can never disagree, and both carry only
 * structural facts — never a token, file content, or a credential-bearing URL.
 *
 * @sem domain=infrastructure
 */
import { listRepos } from "./registry.js";
import { readRepoRuntime } from "./repo-runtime.js";

/** Schema version of both payloads — sourced from the contract
 *  (`@unerr-ai/contracts/fleet` `FLEET_SCHEMA_VERSION`). Kept as the literal `1`
 *  so the payload interfaces below stay precisely typed. */
export const FLEET_SCHEMA_VERSION = CONTRACT_FLEET_SCHEMA_VERSION as 1;

/**
 * Upper bound on repos in one report — sourced from the contract
 * (`FLEET_MAX_REPOS_PER_REPORT`). A machine with more registered repos than this
 * has the list truncated, so an unbounded registry can never inflate the payload
 * past the server's array cap.
 */
export const MAX_REPOS_PER_REPORT = FLEET_MAX_REPOS_PER_REPORT;

/** One repo's row in the full inventory payload. */
export interface FleetRepoReport {
  label: string;
  path: string;
  origin: GitOrigin | null;
  status: RepoStatus;
  pid: number | null;
  http_port: number | null;
  memory_bytes: number | null;
  connections: number;
  entity_count: number | null;
  edge_count: number | null;
  added_at: string | null;
  last_activity: string | null;
  last_used_at: string | null;
}

/** The full inventory payload (`PUT …/inventory`). */
export interface FleetReport {
  schema_version: typeof FLEET_SCHEMA_VERSION;
  machine: MachineSnapshot;
  repos: FleetRepoReport[];
}

/** One repo's row in the lightweight heartbeat payload. */
export interface HeartbeatRepo {
  path: string;
  status: RepoStatus;
  pid: number | null;
  connections: number;
  entity_count: number | null;
  edge_count: number | null;
  added_at: string | null;
  last_activity: string | null;
  last_used_at: string | null;
}

/** The heartbeat payload (`POST …/checkin`). */
export interface HeartbeatReport {
  schema_version: typeof FLEET_SCHEMA_VERSION;
  daemon: DaemonRuntime;
  repos: HeartbeatRepo[];
}

/** Options for building either payload — the live status plus snapshot inputs. */
export interface FleetReportInputs extends MachineSnapshotOptions {
  /** Live per-repo status from the process manager (the join spine). */
  statusEntries: RepoStatusEntry[];
}

/**
 * Build the full inventory payload. Returns null when the machine is not logged
 * in (no machine snapshot), since fleet reporting only runs authenticated. Git
 * origin is detected per repo (memoized, credential-free); registry supplies
 * `added_at`. The repo list is capped at {@link MAX_REPOS_PER_REPORT}.
 *
 * @sem domain=infrastructure
 */
export async function buildFleetReport(
  inputs: FleetReportInputs
): Promise<FleetReport | null> {
  const machine = buildMachineSnapshot(inputs);
  if (!machine) return null;

  const usageByPath = new Map(
    listRepos().map(
      (r) =>
        [r.path, { addedAt: r.addedAt, lastStarted: r.lastStarted }] as const
    )
  );
  const entries = inputs.statusEntries.slice(0, MAX_REPOS_PER_REPORT);

  const repos: FleetRepoReport[] = await Promise.all(
    entries.map(async (e) => ({
      label: e.label,
      path: e.path,
      origin: await detectGitOrigin(e.path),
      status: e.status,
      pid: e.pid,
      http_port: readRepoRuntime(e.path).http_port,
      memory_bytes: e.memory,
      connections: e.connections,
      entity_count: e.entityCount,
      edge_count: e.edgeCount,
      added_at: usageByPath.get(e.path)?.addedAt ?? null,
      last_activity: e.lastActivity,
      // last_used_at = when the proxy was last started (used by an agent).
      last_used_at: usageByPath.get(e.path)?.lastStarted ?? null,
    }))
  );

  const report: FleetReport = {
    schema_version: FLEET_SCHEMA_VERSION,
    machine,
    repos,
  };
  // Non-blocking contract check: a shape drift warns to stderr but still ships
  // (the dashboard depends on the report; the server re-validates on ingest).
  validateBody(FleetInventoryBody, report, "fleet:inventory", (m) =>
    startupLog.warn(m)
  );
  return report;
}

/**
 * Build the lightweight heartbeat payload — machine liveness plus per-repo
 * status/counts, no origin or path lookups (so it is cheap on the fast cadence).
 * Returns null when not logged in.
 *
 * @sem domain=infrastructure
 */
export function buildHeartbeatReport(
  inputs: FleetReportInputs
): HeartbeatReport | null {
  const machine = buildMachineSnapshot(inputs);
  if (!machine) return null;

  // One cheap registry read so the heartbeat keeps usage timestamps fresh
  // between full snapshots (added_at / last_used_at come from the registry;
  // last_activity from the live status entry).
  const usageByPath = new Map(
    listRepos().map(
      (r) =>
        [r.path, { addedAt: r.addedAt, lastStarted: r.lastStarted }] as const
    )
  );

  const repos: HeartbeatRepo[] = inputs.statusEntries
    .slice(0, MAX_REPOS_PER_REPORT)
    .map((e) => ({
      path: e.path,
      status: e.status,
      pid: e.pid,
      connections: e.connections,
      entity_count: e.entityCount,
      edge_count: e.edgeCount,
      added_at: usageByPath.get(e.path)?.addedAt ?? null,
      last_activity: e.lastActivity,
      last_used_at: usageByPath.get(e.path)?.lastStarted ?? null,
    }));

  const report: HeartbeatReport = {
    schema_version: FLEET_SCHEMA_VERSION,
    daemon: machine.daemon,
    repos,
  };
  // Non-blocking contract check — same policy as buildFleetReport.
  validateBody(FleetCheckinBody, report, "fleet:checkin", (m) =>
    startupLog.warn(m)
  );
  return report;
}
