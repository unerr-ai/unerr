import {
  FLEET_MAX_REPOS_PER_REPORT,
  type MachineCheckinEventInput,
  type MachineInventoryEventInput,
} from "@unerr-ai/contracts/fleet";
import { deriveRepoId } from "../cloud/sync/index.js";
import { type GitOrigin, detectGitOrigin } from "./git-origin.js";
import {
  type DaemonRuntime,
  type MachineSnapshot,
  type MachineSnapshotOptions,
  buildMachineSnapshot,
} from "./machine-snapshot.js";
import type { RepoStatus, RepoStatusEntry } from "./protocol.js";
/**
 * Assemble the two fleet event payloads from local state only: the full
 * inventory (`machine_inventory` detail = machine + every managed repo with its
 * origin, ports, and live status) and the lightweight heartbeat
 * (`machine_checkin` detail = daemon liveness + per-repo status). Both are built
 * from one join so they can never disagree, and both carry only structural
 * facts — never a token, file content, or a credential-bearing URL. The reporter
 * stamps each into a contract-shaped event and pushes it on the one ingest
 * stream; the machine itself is resolved from the bearer token, never the body.
 *
 */
import { listRepos } from "./registry.js";
import { readRepoRuntime } from "./repo-runtime.js";

/**
 * Upper bound on repos in one event — sourced from the contract
 * (`FLEET_MAX_REPOS_PER_REPORT`). A machine with more registered repos than this
 * has the list truncated, so an unbounded registry can never inflate the payload
 * past the server's array cap.
 */
export const MAX_REPOS_PER_REPORT = FLEET_MAX_REPOS_PER_REPORT;

/** The `machine_inventory` detail — full machine + per-repo snapshot. */
export type InventoryDetail = MachineInventoryEventInput["detail"];
/** The `machine_checkin` detail — daemon liveness + per-repo status deltas. */
export type CheckinDetail = MachineCheckinEventInput["detail"];

/** One repo's row in the full inventory detail. */
export interface FleetRepoReport {
  label: string;
  path: string;
  /** Salted repo hash (never the path) — same id the event/session/sync rows
   *  carry, so the cloud joins this inventory row to that repo's event stream. */
  repo: string;
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

/** One repo's row in the lightweight heartbeat detail. */
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

/** Options for building either detail — the live status plus snapshot inputs. */
export interface FleetReportInputs extends MachineSnapshotOptions {
  /** Live per-repo status from the process manager (the join spine). */
  statusEntries: RepoStatusEntry[];
}

/**
 * Build the `machine_inventory` detail. Returns null when the machine is not
 * logged in (no machine snapshot), since fleet reporting only runs authenticated.
 * Git origin is detected per repo (memoized, credential-free); registry supplies
 * `added_at`. The repo list is capped at {@link MAX_REPOS_PER_REPORT}.
 *
 */
export async function buildFleetReport(
  inputs: FleetReportInputs
): Promise<InventoryDetail | null> {
  const machine: MachineSnapshot | null = buildMachineSnapshot(inputs);
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
      repo: await deriveRepoId(e.path),
      origin: await detectGitOrigin(e.path),
      status: e.status,
      pid: e.pid,
      http_port: readRepoRuntime(e.path).http_port,
      // `e.memory` is resident size in MB (process.memoryUsage().rss/1024/1024
      // in the child). The wire field is bytes — convert at this boundary only.
      memory_bytes: e.memory != null ? e.memory * 1024 * 1024 : null,
      connections: e.connections,
      entity_count: e.entityCount,
      edge_count: e.edgeCount,
      added_at: usageByPath.get(e.path)?.addedAt ?? null,
      last_activity: e.lastActivity,
      // last_used_at = when the proxy was last started (used by an agent).
      last_used_at: usageByPath.get(e.path)?.lastStarted ?? null,
    }))
  );

  return { machine, repos } as InventoryDetail;
}

/**
 * Build the `machine_checkin` detail — daemon liveness plus per-repo
 * status/counts, no origin or path lookups (so it is cheap on the fast cadence).
 * Returns null when not logged in.
 *
 */
export function buildHeartbeatReport(
  inputs: FleetReportInputs
): CheckinDetail | null {
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

  const daemon: DaemonRuntime = machine.daemon;
  return { daemon, repos } as CheckinDetail;
}
