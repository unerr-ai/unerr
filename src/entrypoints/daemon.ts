/**
 * unerrd — the centralized daemon supervisor.
 *
 * Listens on ~/.unerr/unerrd.sock for JSON protocol messages.
 * Manages per-repo child processes via ProcessManager.
 *
 * Entry points:
 *   `unerr pm start --foreground` — foreground (for debugging)
 *   `unerr pm start --detached`   — detached (auto-spawned by bridge)
 *
 * Lifecycle:
 *   1. Acquire PID lock (~/.unerr/unerrd.pid)
 *   2. Start UDS server (~/.unerr/unerrd.sock)
 *   3. Load registry, start idle sweep
 *   4. Serve JSON protocol requests
 *   5. On SIGTERM/SIGINT: stop all children → exit
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveFederatedPeers } from "../daemon/peers.js";
import { ProcessManager } from "../daemon/process-manager.js";
import {
  DAEMON_DASHBOARD_PORT,
  type DaemonRequest,
  type DaemonResponse,
} from "../daemon/protocol.js";
import {
  addRepo,
  findRepo,
  globalDir,
  listRepos,
  readRegistry,
  removeRepo,
} from "../daemon/registry.js";
import { installFileLogger } from "../utils/file-logger.js";
import {
  cleanupLegacyLogs,
  getOrCreateSid,
  globalLog,
  globalLogsDir,
} from "../utils/log-paths.js";
import { sweepRotatedLogs } from "../utils/log-rotation.js";

// ── Paths ───────────────────────────────────────────────────────

function pidPath(): string {
  return join(globalDir(), "unerrd.pid");
}

function sockPath(): string {
  return join(globalDir(), "unerrd.sock");
}

// ── PID Lock ────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePidLock(): boolean {
  const p = pidPath();
  try {
    const raw = readFileSync(p, "utf-8").trim();
    const existingPid = Number.parseInt(raw, 10);
    if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
      return false;
    }
    // Stale PID file — previous process died
  } catch {
    // No PID file
  }
  const dir = globalDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, `${process.pid}\n`);
  return true;
}

function releasePidLock(): void {
  try {
    unlinkSync(pidPath());
  } catch {
    /* best effort */
  }
}

// ── Orphaned socket cleanup ─────────────────────────────────────

/**
 * Check if the UDS socket file exists but the process that created it is dead.
 * If so, remove the stale socket so we can bind fresh.
 */
function cleanStaleSocket(): void {
  const sock = sockPath();
  if (!existsSync(sock)) return;

  // Try connecting — if it fails, the socket is stale
  try {
    const probe = createConnection(sock);
    probe.on("connect", () => {
      probe.destroy();
      // Socket is live — another daemon is running
    });
    probe.on("error", () => {
      // Socket is stale — remove it
      try {
        unlinkSync(sock);
      } catch {
        /* race — ok */
      }
    });
    // Give probe 500ms to connect or fail
    setTimeout(() => {
      if (!probe.destroyed) probe.destroy();
    }, 500).unref();
  } catch {
    try {
      unlinkSync(sock);
    } catch {
      /* race — ok */
    }
  }
}

// ── UDS Protocol Server ─────────────────────────────────────────

function createUdsServer(pm: ProcessManager): Server {
  const server = createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      // Process all complete newline-delimited messages
      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        handleRequest(pm, line)
          .then((response) => {
            if (response && !socket.destroyed) {
              socket.write(`${JSON.stringify(response)}\n`);
            }
          })
          .catch((err) => {
            if (!socket.destroyed) {
              socket.write(
                `${JSON.stringify({ ok: false, error: String(err) })}\n`
              );
            }
          });
      }
    });

    socket.on("error", () => {
      // Client disconnected — non-fatal
    });
  });

  return server;
}

async function handleRequest(
  pm: ProcessManager,
  raw: string
): Promise<DaemonResponse | null> {
  let req: DaemonRequest;
  try {
    req = JSON.parse(raw) as DaemonRequest;
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  switch (req.cmd) {
    case "ensure": {
      try {
        // Pro+ lazy auto-add (cross-repo scenarios 1 & 3): if the agent
        // referenced a repo that is on disk but never `unerr add`-ed, register
        // it (ephemeral) so it becomes queryable this turn. Gated on unlimited
        // tier — free never auto-adds, its single slot stays with the explicitly
        // added repo. Best-effort: a parent/child conflict just leaves it
        // unregistered and ensure proceeds (the covering proxy serves it).
        if (!findRepo(req.repo)) {
          const { tierFromCache } = await import("../cloud/tier-query.js");
          const { repoLimit, isUnlimited } = await import(
            "../cloud/tier-model.js"
          );
          if (isUnlimited(repoLimit(tierFromCache()))) {
            addRepo(req.repo, { ephemeral: true }, { skipCap: true });
          }
        }
        const outcome = await pm.ensure(req.repo);
        // Free-tier single-active backstop: a different repo already holds the
        // one slot — surface a structured refusal so the bridge answers the
        // IDE with a clean cap error instead of relaying.
        if (typeof outcome !== "string") {
          return {
            ok: false,
            refused: "already_active",
            activePath: outcome.activePath,
            message: outcome.message,
          };
        }
        // U4: stamp our own running version so the fresh-spawned bridge can
        // detect a stale daemon (manual/auto upgrade) and converge.
        const { UNERR_VERSION } = await import("../version.js");
        return { ok: true, sock: outcome, version: UNERR_VERSION };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    case "connect":
      pm.connect(req.repo);
      return { ok: true };

    case "disconnect":
      pm.disconnect(req.repo);
      return { ok: true };

    case "activity":
      pm.recordActivity(req.repo);
      return null; // fire-and-forget

    case "status":
      return { ok: true, repos: pm.getStatus() };

    case "add": {
      // Resolve the plan's repo limit from local state (the daemon owns the
      // freshest entitlement cache) and inject it so the registry enforces the
      // free-tier cap without importing cloud (which would cycle).
      const { tierFromCache } = await import("../cloud/tier-query.js");
      const { repoLimit } = await import("../cloud/tier-model.js");
      const result = addRepo(req.repo, req.settings ?? {}, {
        repoLimit: repoLimit(tierFromCache()),
      });
      if (result.ok) return { ok: true };
      return {
        ok: false,
        error: result.error,
        parentConflict: result.parentConflict,
      };
    }

    case "remove": {
      await pm.stop(req.repo);
      const removed = removeRepo(req.repo);
      if (removed) {
        // Ship the `removed` repo_activity event before the repo leaves the
        // drain rotation (the proxy is already stopped, so no write contention).
        const { emitRepoRemoved } = await import("../cloud/repo-removal.js");
        await emitRepoRemoved(req.repo);
        return { ok: true };
      }
      return { ok: false, error: "Not registered" };
    }

    case "stop":
      await pm.stop(req.repo);
      return { ok: true };

    case "shutdown":
      // Handled by the caller — triggers graceful shutdown
      return { ok: true };

    case "entitlements": {
      // Answer the per-repo proxy's tier query from local state only — never
      // a network call. Reads + verifies the signed cache file.
      try {
        const { tierFromCache } = await import("../cloud/tier-query.js");
        const tier = tierFromCache();
        return {
          ok: true,
          plan: tier.plan,
          source: tier.source,
          features: tier.features,
          limits: tier.limits,
          reconnect_by: tier.reconnect_by,
        };
      } catch {
        // Cloud module unavailable for any reason → free, never block.
        const { FREE_TIER_LIMITS } = await import("../cloud/tier-model.js");
        return {
          ok: true,
          plan: "free",
          source: "none",
          features: {},
          limits: FREE_TIER_LIMITS,
        };
      }
    }

    case "dashboard-state":
      return { ok: true, repos: pm.getStatus() };

    case "repo-detail": {
      const managed = pm.getManaged(req.repo);
      if (!managed) return { ok: false, error: "Not managed" };
      return {
        ok: true,
        repos: [
          {
            path: managed.path,
            label: managed.label,
            status: managed.status,
            pid: managed.pid,
            memory: managed.memory,
            idle: managed.lastActivity
              ? Math.round((Date.now() - managed.lastActivity) / 1000)
              : null,
            connections: managed.connections,
            lastActivity: managed.lastActivity
              ? new Date(managed.lastActivity).toISOString()
              : null,
            entityCount: managed.entities,
            edgeCount: managed.edges,
            needsInput: managed.needsInput,
          },
        ],
      };
    }

    case "peers": {
      // Cross-repo discovery. Pro/enterprise only — the tier gate lives in
      // resolveFederatedPeers (injected `unlimited`). Discovery does NOT spawn
      // sleeping peers: the coordinator ensures each peer it actually queries,
      // so this stays cheap and avoids a fork storm.
      const { tierFromCache } = await import("../cloud/tier-query.js");
      const { repoLimit, isUnlimited } = await import("../cloud/tier-model.js");
      const verdict = resolveFederatedPeers({
        homeRepo: req.homeRepo,
        repos: listRepos(),
        unlimited: isUnlimited(repoLimit(tierFromCache())),
      });
      if (!verdict.ok) {
        return {
          ok: false,
          refused: "workspace_pro_only",
          message: verdict.message,
        };
      }
      const { deriveRepoId } = await import("../cloud/repo-identity.js");
      const peers = await Promise.all(
        verdict.peers.map(async (r) => {
          const managed = pm.getManaged(r.path);
          const sock =
            managed && managed.status === "running" && managed.sock
              ? managed.sock
              : "";
          return {
            repoId: await deriveRepoId(r.path),
            label: r.label,
            path: r.path,
            sock,
            running: sock !== "",
          };
        })
      );
      return { ok: true, peers };
    }

    default:
      return {
        ok: false,
        error: `Unknown command: ${(req as { cmd: string }).cmd}`,
      };
  }
}

// ── Main ────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => process.stderr.write(`[unerrd] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[unerrd] WARN: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[unerrd] ERROR: ${msg}\n`),
};

export async function startDaemon(opts: {
  background?: boolean;
  /**
   * True when running as the detached auto-spawned supervisor (not an
   * interactive `--foreground` debug session). A detached supervisor has no
   * controlling terminal, so SIGHUP is ignored rather than allowed to silently
   * terminate it — defense-in-depth if it ever shares a session with a spawner.
   */
  detached?: boolean;
}): Promise<void> {
  // Install file logger as first action
  getOrCreateSid();
  cleanupLegacyLogs(globalLogsDir(globalDir()));
  sweepRotatedLogs(globalLogsDir(globalDir()));
  installFileLogger({
    filePath: globalLog.unerrd(globalDir()),
  });

  // Acquire PID lock
  if (!acquirePidLock()) {
    log.info("unerrd is already running. Exiting.");
    process.exit(0);
  }

  // Clean stale socket from previous hard kill
  cleanStaleSocket();

  // Wait briefly for stale socket cleanup
  await new Promise<void>((r) => setTimeout(r, 100));

  // Remove stale socket synchronously if it's still there
  const sock = sockPath();
  if (existsSync(sock)) {
    try {
      unlinkSync(sock);
    } catch {
      /* race — will fail on bind instead */
    }
  }

  const pm = new ProcessManager();
  // Set lazily once the reporter starts (after the dashboard binds); proxy
  // start/stop is a fleet-changing event that triggers a debounced inventory push.
  let fleetReporter: {
    notifyEvent: (r: string) => void;
    stop: () => void;
  } | null = null;
  let pushReporter: { stop: () => void } | null = null;
  pm.setEventHandler((event, repo, detail) => {
    log.info(`[${repo.label}] ${event}${detail ? `: ${detail}` : ""}`);
    if (event === "started" || event === "stopped") {
      fleetReporter?.notifyEvent(`proxy-${event}`);
      // A repo that came up/down is picked up by the next ≤10s drain tick, which
      // re-reads the live repo list — no per-repo watcher to reconcile.
    }
  });

  const server = createUdsServer(pm);

  // Track shutdown request from protocol
  let shutdownRequested = false;
  const origHandler = handleRequest;
  // Wrap to detect shutdown command
  const originalCreateUdsServer = server;

  // Graceful shutdown procedure
  let apiHandle: import("../daemon/api.js").DaemonApiHandle | null = null;

  const shutdown = async (reason: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.info(`Shutting down: ${reason}`);

    pm.stopIdleSweep();
    apiHandle?.close();

    server.close();
    try {
      unlinkSync(sock);
    } catch {
      /* already gone */
    }

    await pm.shutdownAll();
    releasePidLock();
    log.info("Shutdown complete.");
    process.exit(0);
  };

  // Signal handling
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Detached supervisor: ignore SIGHUP. It owns no controlling terminal, so a
  // terminal hangup (chat/IDE session closing) must never reach it — and if a
  // stray SIGHUP ever does (e.g. a shared session before the double-fork
  // reparents), ignoring it keeps the manager and its proxies alive instead of
  // silently terminating with no graceful-shutdown log. `pm stop` (SIGTERM) and
  // the "shutdown" command remain the only ways to stop it.
  if (opts.detached) {
    process.on("SIGHUP", () => {
      log.info(
        "Ignoring SIGHUP — detached supervisor has no controlling terminal"
      );
    });
  }

  // Intercept "shutdown" command in UDS handler
  server.on("connection", (socket) => {
    socket.on("data", (chunk) => {
      const str = chunk.toString();
      if (str.includes('"shutdown"')) {
        // The handleRequest already sent { ok: true } — now shut down
        setTimeout(() => shutdown("shutdown command"), 100);
      }
    });
  });

  // Bind and listen
  await new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      log.error(`UDS server error: ${err.message}`);
      releasePidLock();
      reject(err);
    });

    server.listen(sock, () => {
      resolve();
    });
  });

  const reg = readRegistry();
  pm.startIdleSweep();

  // Start the dashboard HTTP API (non-critical — daemon works without it)
  try {
    const { startDaemonApi } = await import("../daemon/api.js");
    apiHandle = await startDaemonApi(pm);
    if (apiHandle) {
      log.info(`Dashboard: http://localhost:${apiHandle.port}`);
    }
  } catch (err) {
    log.warn(`Dashboard API failed to start: ${(err as Error).message}`);
  }

  // Schedule warm-start of MRU repos (non-critical)
  let cancelWarmStart: (() => void) | null = null;
  try {
    const { scheduleWarmStart } = await import("../daemon/warm-start.js");
    cancelWarmStart = scheduleWarmStart(pm, (event) => {
      apiHandle?.pushWarmStartEvent(event);
      if (event.status === "started") {
        log.info(`warm-start: ${event.label} ready (${event.ms}ms)`);
      } else if (event.status === "skipped") {
        log.info(`warm-start: ${event.label} skipped — ${event.reason}`);
      } else if (event.status === "failed") {
        log.warn(`warm-start: ${event.label} failed — ${event.reason}`);
      } else if (event.status === "aborted") {
        log.warn(`warm-start: ${event.label} aborted — ${event.reason}`);
      }
    });
  } catch (err) {
    log.warn(`Warm-start scheduler failed: ${(err as Error).message}`);
  }

  // Start the entitlement refresh job (non-critical — the CLI works fully
  // logged out). Refreshes once now, then every 12h ± jitter on an unref'd
  // timer. Offline failures are silent; a revoked machine self-wipes and the
  // job stops. Skips silently when not logged in.
  let stopEntitlementRefresh: (() => void) | null = null;
  try {
    const { startEntitlementRefresh } = await import("../cloud/refresh-job.js");
    const job = startEntitlementRefresh({
      log: (msg) => log.info(msg),
    });
    stopEntitlementRefresh = job.stop;
  } catch (err) {
    log.warn(`Entitlement refresh failed to start: ${(err as Error).message}`);
  }

  // Start the fleet reporter (non-critical — reports this machine's repo
  // inventory + process runtime to the account dashboard. Default-on when logged
  // in; the opt-out gate and the logged-out check make it skip silently. Repo
  // add/remove + proxy start/stop trigger a debounced inventory push via the
  // pm event handler above.)
  try {
    const { FleetReporter } = await import("../daemon/fleet-reporter.js");
    const { readCredentials } = await import("../cloud/credentials.js");
    const reporter = new FleetReporter({
      getStatusEntries: () => pm.getStatus(),
      resolveAuth: () => {
        const creds = readCredentials();
        if (!creds || creds.machine_id.length === 0) return null;
        return {
          apiUrl: creds.api_url,
          token: creds.token,
          machineId: creds.machine_id,
        };
      },
      dashboardPort: () => apiHandle?.port ?? DAEMON_DASHBOARD_PORT,
      log: (msg) => log.info(msg),
    });
    reporter.start();
    fleetReporter = reporter;
  } catch (err) {
    log.warn(`Fleet reporter failed to start: ${(err as Error).message}`);
  }

  // Start the push reporter (non-critical — drains each repo's local telemetry/
  // sync stores to the cloud on a timer. One machine-wide loop with one
  // backoff. Default-on when logged in on a paid plan; the B5 gate and the
  // logged-out check make it skip silently.)
  try {
    const { PushReporter } = await import("../daemon/push-reporter.js");
    const { readCredentials } = await import("../cloud/credentials.js");
    // Wire the transcript materializer here (the composition root) so the daemon
    // layer never imports `src/tracking/` directly (daemon-isolation guard).
    const { materializeClaimedTranscripts } = await import(
      "../tracking/transcript-drainer.js"
    );
    const reporter = new PushReporter({
      getRepos: () => pm.getStatus().map((r) => ({ path: r.path })),
      resolveAuth: () => {
        const creds = readCredentials();
        if (!creds || creds.machine_id.length === 0) return null;
        return { apiUrl: creds.api_url, token: creds.token };
      },
      materializeClaims: materializeClaimedTranscripts,
      log: (msg) => log.info(msg),
    });
    reporter.start();
    pushReporter = reporter;
  } catch (err) {
    log.warn(`Push reporter failed to start: ${(err as Error).message}`);
  }

  // Add warm-start + entitlement-refresh + fleet/push-reporter cancellation to shutdown
  const origShutdown = shutdown;
  const wrappedShutdown = async (reason: string) => {
    cancelWarmStart?.();
    stopEntitlementRefresh?.();
    fleetReporter?.stop();
    pushReporter?.stop();
    await origShutdown(reason);
  };
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.on("SIGTERM", () => wrappedShutdown("SIGTERM"));
  process.on("SIGINT", () => wrappedShutdown("SIGINT"));

  log.info(
    `Started (PID ${process.pid}), ${reg.repos.length} repos registered. Socket: ${sock}`
  );

  if (!opts.background) {
    log.info("Running in foreground. Press Ctrl+C to stop.");
  }
}
