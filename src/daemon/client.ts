/**
 * unerrd client — communicates with the daemon supervisor over UDS.
 *
 * Used by `unerr --mcp` (bridge) and CLI commands to interact with `unerrd`.
 * All methods are fire-and-forget except `ensureRepo` which waits for the
 * repo process to become ready (returns the per-repo UDS sock path).
 *
 * Protocol: newline-delimited JSON over `~/.unerr/unerrd.sock`.
 * Each request is a single connection (connect → send → read → close).
 */

import { type Socket, createConnection } from "node:net";
import { join } from "node:path";
import {
  type DaemonResponse,
  ENSURE_REPO_REQUEST_TIMEOUT_MS,
  type EnsureOkResponse,
  type EnsureRefusedResponse,
  type EntitlementsOkResponse,
  type OkResponse,
  type StatusOkResponse,
} from "./protocol.js";
import { globalDir } from "./registry.js";

/** Default path to the daemon's UDS control socket. */
export function daemonSockPath(): string {
  return join(globalDir(), "unerrd.sock");
}

/**
 * Send a single request to unerrd and return the parsed response.
 * Opens a fresh connection per request (control-plane traffic is low-frequency).
 */
export function sendRequest(
  sockPath: string,
  request: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`unerrd request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const socket: Socket = createConnection(sockPath);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx).trim();
      if (!line) return;

      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();

      try {
        resolve(JSON.parse(line) as DaemonResponse);
      } catch {
        reject(new Error(`Invalid JSON from unerrd: ${line.slice(0, 200)}`));
      }
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("unerrd connection closed before response"));
    });
  });
}

/**
 * Send a fire-and-forget request (no response needed).
 * Used for `activity` which the daemon acknowledges with no response (null).
 */
export function sendFireAndForget(
  sockPath: string,
  request: Record<string, unknown>
): void {
  try {
    const socket = createConnection(sockPath);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      // Give the socket a moment to flush, then destroy
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on("error", () => {
      // Best-effort — daemon might be shutting down
    });
  } catch {
    // Best-effort
  }
}

// ── High-level client methods ─────────────────────────────────────

/**
 * The daemon refused to start the repo because the free tier's single active
 * slot is already held by a different repo. Returned by {@link ensureRepo}
 * instead of a sock so the bridge can answer the IDE with a cap error.
 */
export interface EnsureRepoRefused {
  refused: "already_active";
  activePath: string;
  message: string;
}

/** Type guard — true when {@link ensureRepo} refused rather than returned a sock. */
export function isEnsureRepoRefused(
  r: { sock: string; daemonVersion?: string } | EnsureRepoRefused
): r is EnsureRepoRefused {
  return "refused" in r;
}

/**
 * Ensure a repo process is running. Returns the per-repo UDS sock path.
 * If the repo is already running, returns immediately.
 * If not, the supervisor spawns it and waits for ready.
 *
 * On the free tier with another repo already active, returns a structured
 * {@link EnsureRepoRefused} instead of throwing — the bridge surfaces it as a
 * JSON-RPC cap error.
 */
export async function ensureRepo(
  sockPath: string,
  repoPath: string
): Promise<{ sock: string; daemonVersion?: string } | EnsureRepoRefused> {
  // `ensure` blocks on the daemon while a cold repo indexes (up to
  // REPO_READY_TIMEOUT_MS). Use the longer ENSURE_REPO_REQUEST_TIMEOUT_MS so
  // the bridge doesn't abandon a proxy that is still legitimately indexing a
  // large repo on a slow machine — the daemon-side ready timeout fires first
  // with a structured error if the proxy truly never comes up.
  const resp = await sendRequest(
    sockPath,
    { cmd: "ensure", repo: repoPath },
    ENSURE_REPO_REQUEST_TIMEOUT_MS
  );
  if (!resp.ok) {
    // Free-tier single-active refusal: a different repo holds the one slot.
    // Surface it structurally (not as a thrown error) so the bridge answers
    // the IDE's initialize with a clean cap error and exits.
    if ((resp as EnsureRefusedResponse).refused === "already_active") {
      const refusal = resp as EnsureRefusedResponse;
      return {
        refused: "already_active",
        activePath: refusal.activePath,
        message: refusal.message,
      };
    }
    throw new Error(`ensureRepo failed: ${(resp as { error: string }).error}`);
  }
  const ok = resp as EnsureOkResponse;
  // U4: `version` carries the daemon's running version for the skew handshake
  // (absent on an older daemon — the caller treats that as "no skew action").
  return { sock: ok.sock, daemonVersion: ok.version };
}

/**
 * Register a bridge connection to a repo.
 * Increments the repo's connection count (prevents idle sweep).
 */
export async function connectRepo(
  sockPath: string,
  repoPath: string
): Promise<void> {
  const resp = await sendRequest(sockPath, { cmd: "connect", repo: repoPath });
  if (!resp.ok) {
    throw new Error(`connectRepo failed: ${(resp as { error: string }).error}`);
  }
}

/**
 * Unregister a bridge connection from a repo.
 * Decrements the repo's connection count.
 */
export async function disconnectRepo(
  sockPath: string,
  repoPath: string
): Promise<void> {
  const resp = await sendRequest(sockPath, {
    cmd: "disconnect",
    repo: repoPath,
  });
  if (!resp.ok) {
    throw new Error(
      `disconnectRepo failed: ${(resp as { error: string }).error}`
    );
  }
}

/** Fire-and-forget activity ping. Does not wait for response. */
export function sendActivity(sockPath: string, repoPath: string): void {
  sendFireAndForget(sockPath, { cmd: "activity", repo: repoPath });
}

/**
 * U4: ask the daemon to gracefully shut down (drain children → exit). Used by
 * the version handshake to converge a stale daemon: after this resolves the
 * bridge's discovery loop re-spawns a fresh daemon on the new on-disk version.
 * Best-effort — returns true if the daemon acknowledged, false otherwise.
 */
export async function requestDaemonShutdown(sockPath: string): Promise<boolean> {
  try {
    const resp = await sendRequest(sockPath, { cmd: "shutdown" }, 5_000);
    return resp.ok === true;
  } catch {
    return false;
  }
}

/** Get status of all managed repos. */
export async function getStatus(sockPath: string): Promise<StatusOkResponse> {
  const resp = await sendRequest(sockPath, { cmd: "status" });
  if (!resp.ok) {
    throw new Error(`getStatus failed: ${(resp as { error: string }).error}`);
  }
  return resp as StatusOkResponse;
}

/**
 * Ask the daemon for the current pricing tier (Sprint I3). Returns null when
 * the daemon is unreachable (so the caller falls back to reading the cache
 * file directly). Never throws — a short timeout, swallow errors. The daemon
 * answers from local state only; this never causes a network call.
 */
export async function getDaemonTier(
  sockPath: string
): Promise<EntitlementsOkResponse | null> {
  try {
    const resp = await sendRequest(sockPath, { cmd: "entitlements" }, 2_000);
    if (resp.ok && "plan" in resp) {
      return resp as EntitlementsOkResponse;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the daemon socket is reachable (probe connection).
 * Returns true if connection succeeds, false otherwise.
 */
export function probeDaemon(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(sockPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    timer.unref();

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
