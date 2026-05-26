/**
 * unerrd protocol — newline-delimited JSON over UDS (~/.unerr/unerrd.sock).
 *
 * Three communication planes:
 *   1. Bridge → unerrd (ensure/connect/disconnect/activity)
 *   2. Daemon CLI → unerrd (status/add/remove/stop/shutdown)
 *   3. unerrd ↔ child repo processes (ready/activity/stats/shutdown)
 */

// ── Shared primitives ────────────────────────────────────────────

/**
 * Fixed loopback port the process manager (unerrd) serves the dashboard +
 * HTTP API on (127.0.0.1:9847). Single source of truth — import this instead
 * of repeating the literal so the URL surfaced in `pm status`, `doctor`, and
 * the daemon logs can never drift apart.
 */
export const DAEMON_DASHBOARD_PORT = 9847;

/**
 * How many ports above DAEMON_DASHBOARD_PORT unerrd will scan for a free one
 * before giving up. 9847 occupied → try 9848 … 9947. The actually-bound port
 * is persisted to dashboard.json so every URL surface reflects reality.
 */
export const DAEMON_DASHBOARD_PORT_SCAN_RANGE = 100;

/** Canonical dashboard URL. Reachable only while unerrd is running. */
export function daemonDashboardUrl(
  port: number = DAEMON_DASHBOARD_PORT
): string {
  return `http://localhost:${port}`;
}

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

/**
 * Max wait for a daemon-managed child (per-repo proxy) to send IPC `ready` (ms).
 *
 * This must comfortably exceed the worst-case cold-start index time, which is
 * a function of repo size AND machine speed — neither of which we control. A
 * large monorepo on a slow laptop can take minutes to index before the proxy
 * binds its socket and reports ready. 6 minutes gives that headroom; the
 * bridge's ensure request timeout (ENSURE_REPO_REQUEST_TIMEOUT_MS) is set
 * slightly higher so the proxy-side timeout fires first with a clean error
 * rather than the client tearing down mid-index.
 */
export const REPO_READY_TIMEOUT_MS = 360_000;

/**
 * Client-side timeout for the bridge's `ensure` request to unerrd (ms).
 *
 * `ensure` blocks on the daemon while it waits for the per-repo proxy to send
 * `ready` (up to REPO_READY_TIMEOUT_MS), so this MUST be larger than
 * REPO_READY_TIMEOUT_MS — otherwise the bridge gives up on a proxy that is
 * still legitimately indexing. Other control-plane calls keep the short
 * default in sendRequest(); only `ensure` opts into this longer budget.
 */
export const ENSURE_REPO_REQUEST_TIMEOUT_MS = 390_000;

/**
 * Per-attempt wait for unerrd (the process manager) to come up after an
 * auto-spawn (ms). unerrd is lightweight and not repo-size sensitive, so this
 * is a soft poll, not a hard deadline — the discovery loop re-probes and
 * retries indefinitely regardless. Kept generous so very slow machines don't
 * thrash the "Waiting for process manager..." path.
 */
export const DAEMON_READY_TIMEOUT_MS = 30_000;
