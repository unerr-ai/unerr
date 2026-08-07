/**
 * unerrd protocol — newline-delimited JSON over UDS (~/.unerr/unerrd.sock).
 *
 * Three communication planes:
 *   1. Bridge → unerrd (ensure/connect/disconnect/activity)
 *   2. Daemon CLI → unerrd (status/add/remove/stop/shutdown)
 *   3. unerrd ↔ child repo processes (ready/activity/stats/shutdown)
 */

import type { TierLimits } from "../cloud/plan/index.js";

// ── Shared primitives ────────────────────────────────────────────

/**
 * Historical loopback port for the process manager's HTTP API.
 *
 * **Nothing binds this port.** unerrd no longer starts an HTTP listener at all
 * — every local caller reaches it over the UDS control socket, and everything
 * that leaves the machine goes over the cloud push path. The constant survives
 * only because `dashboard_port` is a required field on the
 * `@unerr-ai/contracts` machine-snapshot body: removing the field needs the
 * cross-repo contract change order, so until that lands the fleet report sends
 * this number and it describes no listener.
 *
 * Do not reintroduce a bind on it. See CLAUDE.md rule #8.
 */
export const DAEMON_DASHBOARD_PORT = 9847;

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
  /**
   * Cross-repo federation opt-out. When `false`, this repo never appears in
   * another repo's workspace-scoped results. Absent ⇒ true (federate). Every
   * plan federates — no tier gate.
   */
  federate?: boolean;
  /**
   * Set when the daemon lazy-added this repo because an agent referenced its
   * path mid-session (it was on disk but not explicitly `unerr add`-ed). Lets a
   * later sweep distinguish auto-added entries from user-registered ones.
   */
  ephemeral?: boolean;
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

export interface RepoDetailRequest {
  cmd: "repo-detail";
  repo: string;
}

/**
 * Ask the daemon for the current pricing tier (Sprint I3). The daemon owns
 * the entitlement refresh, so it has the freshest answer; per-repo proxies
 * query this instead of touching the cloud themselves. Answered from local
 * state only — never triggers a network call.
 */
export interface EntitlementsRequest {
  cmd: "entitlements";
}

/**
 * Ask the daemon which other registered repos the home repo may federate with
 * (cross-repo intelligence). Returns peers minus the home repo, minus any repo
 * that opted out (`settings.federate === false`). Every plan federates — there
 * is no tier gate. Discovery only: the daemon does not spawn sleeping peers
 * here (the coordinator ensures each peer it actually queries), so this stays
 * cheap and avoids a spawn storm.
 */
export interface PeersRequest {
  cmd: "peers";
  /** Absolute path of the repo making the request; excluded from the result. */
  homeRepo: string;
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
  | RepoDetailRequest
  | EntitlementsRequest
  | PeersRequest;

// ── unerrd → client responses ───────────────────────────────────

export interface OkResponse {
  ok: true;
}

export interface EnsureOkResponse {
  ok: true;
  sock: string;
  /**
   * U4: the daemon's own running version, stamped on every ensure so the
   * fresh-spawned bridge can detect a stale daemon (manual/auto upgrade left
   * the long-lived daemon on old in-memory code) with no extra round-trip.
   * Optional for forward-compat: an older daemon omits it, and the bridge
   * treats an absent version as "no skew action."
   */
  version?: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  parentConflict?: string;
}

/**
 * Structural refusal shape for a daemon-side active-repo cap. No plan enforces
 * a repo-count limit anymore (repos are unlimited on every plan — no server
 * sits in that data path), so nothing constructs this today. Kept only so a
 * future daemon-side limit (unrelated to pricing tier) has a ready response
 * shape and the bridge's `already_active` handling stays exercised.
 */
export interface EnsureRefusedResponse {
  ok: false;
  refused: "already_active";
  /** The repo currently holding the single free-tier active slot. */
  activePath: string;
  /** Human-facing message naming the exact stop / upgrade commands. */
  message: string;
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

/**
 * The daemon's answer to an `entitlements` request (Sprint I3). Mirrors the
 * proxy-facing tier snapshot: the gating plan, where it came from, and the
 * feature map. `source: "free_fallback"` / `"none"` means free.
 */
export interface EntitlementsOkResponse {
  ok: true;
  plan: string;
  source: "fresh" | "grace" | "free_fallback" | "none";
  features: Record<string, boolean>;
  /** The plan's resolved limits (repos / seats / machines). `-1` = unlimited. */
  limits: TierLimits;
  /** When in grace: ISO date to reconnect by. */
  reconnect_by?: string;
}

/** One federatable peer repo the home repo may query cross-repo. */
export interface PeerEntry {
  /** Stable cross-machine id (git-origin hash, or path hash for remote-less). */
  repoId: string;
  /** Human label from the registry. */
  label: string;
  /** Absolute path on this machine. */
  path: string;
  /** Peer proxy UDS socket when already running; empty string when asleep. */
  sock: string;
  /** True when the peer proxy is live now (sock is connectable). */
  running: boolean;
}

export interface PeersOkResponse {
  ok: true;
  peers: PeerEntry[];
}

/**
 * Structural refusal shape for a `peers` request. Every plan federates now —
 * there is no tier gate, so the daemon no longer constructs this. Kept
 * defensive-only: `getPeers` (client.ts) still handles it and the proxy still
 * degrades to home-only on receipt, in case a daemon on an older version ever
 * sends one.
 */
export interface WorkspaceRefusedResponse {
  ok: false;
  refused: "workspace_pro_only";
  /** Human-facing message naming the upgrade path. */
  message: string;
}

export type DaemonResponse =
  | OkResponse
  | EnsureOkResponse
  | EnsureRefusedResponse
  | ErrorResponse
  | StatusOkResponse
  | EntitlementsOkResponse
  | PeersOkResponse
  | WorkspaceRefusedResponse;

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
