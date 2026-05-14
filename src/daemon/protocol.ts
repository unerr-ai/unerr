/**
 * unerrd protocol — newline-delimited JSON over UDS (~/.unerr/unerrd.sock).
 *
 * Three communication planes:
 *   1. Bridge → unerrd (ensure/connect/disconnect/activity)
 *   2. Daemon CLI → unerrd (status/add/remove/stop/shutdown)
 *   3. unerrd ↔ child repo processes (ready/activity/stats/shutdown)
 */

// ── Shared primitives ────────────────────────────────────────────

export type JavaBuildTool = "Maven" | "Gradle" | "Bazel" | "Sbt";

export const JAVA_BUILD_TOOLS: readonly JavaBuildTool[] = [
  "Maven",
  "Gradle",
  "Bazel",
  "Sbt",
] as const;

/** Per-repo settings stored in both registry and <repo>/.unerr/config.json. */
export interface RepoSettings {
  idleTimeout?: number;
  javaBuildTool?: JavaBuildTool;
  autostart?: "eager" | "auto" | "never";
  [key: string]: string | number | boolean | undefined;
}

/** Auto-detected choice the user hasn't explicitly confirmed. */
export interface NeedsInputSignal {
  type: "needs_input";
  key: string;
  auto: string;
  alternatives: string[];
  reason: string;
}

/** A single repo entry in the global registry (~/.unerr/repos.json). */
export interface RepoEntry {
  path: string;
  addedAt: string;
  lastStarted: string | null;
  lastActivity: string | null;
  idleTimeout: number;
  label: string;
  settings: RepoSettings;
}

/** Registry file format (~/.unerr/repos.json). */
export interface RegistryFile {
  version: 1;
  repos: RepoEntry[];
}

// ── Client → unerrd requests ────────────────────────────────────

export interface EnsureRequest {
  cmd: "ensure";
  repo: string;
}

export interface ConnectRequest {
  cmd: "connect";
  repo: string;
}

export interface DisconnectRequest {
  cmd: "disconnect";
  repo: string;
}

export interface ActivityRequest {
  cmd: "activity";
  repo: string;
}

export interface StatusRequest {
  cmd: "status";
}

export interface AddRequest {
  cmd: "add";
  repo: string;
  settings?: RepoSettings;
}

export interface RemoveRequest {
  cmd: "remove";
  repo: string;
}

export interface StopRequest {
  cmd: "stop";
  repo: string;
}

export interface ShutdownRequest {
  cmd: "shutdown";
}

export interface DashboardStateRequest {
  cmd: "dashboard-state";
}

export interface RepoDetailRequest {
  cmd: "repo-detail";
  repo: string;
}

export type DaemonRequest =
  | EnsureRequest
  | ConnectRequest
  | DisconnectRequest
  | ActivityRequest
  | StatusRequest
  | AddRequest
  | RemoveRequest
  | StopRequest
  | ShutdownRequest
  | DashboardStateRequest
  | RepoDetailRequest;

// ── unerrd → client responses ───────────────────────────────────

export interface OkResponse {
  ok: true;
}

export interface EnsureOkResponse {
  ok: true;
  sock: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  parentConflict?: string;
}

export type RepoStatus = "running" | "stopped" | "starting" | "error";

export interface RepoStatusEntry {
  path: string;
  label: string;
  status: RepoStatus;
  pid: number | null;
  memory: number | null;
  idle: number | null;
  connections: number;
  lastActivity: string | null;
  entityCount: number | null;
  edgeCount: number | null;
  needsInput: NeedsInputSignal[];
}

export interface StatusOkResponse {
  ok: true;
  repos: RepoStatusEntry[];
}

export type DaemonResponse =
  | OkResponse
  | EnsureOkResponse
  | ErrorResponse
  | StatusOkResponse;

// ── IPC: unerrd ↔ child repo process (Node.js process.send) ────

export interface ChildReadyMessage {
  type: "ready";
  sock: string;
}

export interface ChildActivityMessage {
  type: "activity";
}

export interface ChildStatsMessage {
  type: "stats";
  entities: number;
  edges: number;
  memory: number;
}

export interface ChildNeedsInputMessage {
  type: "needs_input";
  signals: NeedsInputSignal[];
}

export type ChildMessage =
  | ChildReadyMessage
  | ChildActivityMessage
  | ChildStatsMessage
  | ChildNeedsInputMessage;

export interface ParentShutdownMessage {
  type: "shutdown";
}

export interface ParentGetStatsMessage {
  type: "get-stats";
}

export type ParentMessage = ParentShutdownMessage | ParentGetStatsMessage;

// ── Constants ───────────────────────────────────────────────────

/** Default idle timeout for repos (30 minutes in seconds). */
export const DEFAULT_IDLE_TIMEOUT_S = 1800;

/** Default warm-start budget (top N most-recently-active repos). */
export const DEFAULT_WARM_START_BUDGET = 3;

/** Default warm-start delay after daemon boot (ms). */
export const DEFAULT_WARM_START_DELAY_MS = 30_000;

/** Default warm-start idle-days cutoff. */
export const DEFAULT_WARM_START_IDLE_DAYS = 14;
