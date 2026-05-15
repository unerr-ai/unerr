/**
 * unerrd — the centralized daemon supervisor.
 *
 * Listens on ~/.unerr/unerrd.sock for JSON protocol messages.
 * Manages per-repo child processes via ProcessManager.
 *
 * Entry points:
 *   `unerr daemon start`             — foreground (for debugging)
 *   `unerr daemon start --background` — detached (auto-spawned by bridge)
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
import { ProcessManager } from "../daemon/process-manager.js";
import type { DaemonRequest, DaemonResponse } from "../daemon/protocol.js";
import {
  addRepo,
  globalDir,
  readRegistry,
  removeRepo,
} from "../daemon/registry.js";
import { installFileLogger } from "../utils/file-logger.js";

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
        const sock = await pm.ensure(req.repo);
        return { ok: true, sock };
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
      const result = addRepo(req.repo, req.settings ?? {});
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
      if (removed) return { ok: true };
      return { ok: false, error: "Not registered" };
    }

    case "stop":
      await pm.stop(req.repo);
      return { ok: true };

    case "shutdown":
      // Handled by the caller — triggers graceful shutdown
      return { ok: true };

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
}): Promise<void> {
  // Install file logger as first action
  const logsDir = join(globalDir(), "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  installFileLogger({
    filePath: join(logsDir, "unerrd.log"),
    maxBytes: 10_000_000,
    keep: 5,
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
  pm.setEventHandler((event, repo, detail) => {
    log.info(`[${repo.label}] ${event}${detail ? `: ${detail}` : ""}`);
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
    apiHandle = startDaemonApi(pm);
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

  // Start periodic version checking (non-critical)
  let cancelVersionCheck: (() => void) | null = null;
  try {
    const { startPeriodicCheck } = await import("../daemon/version-checker.js");
    cancelVersionCheck = startPeriodicCheck();
  } catch (err) {
    log.warn(`Version checker failed: ${(err as Error).message}`);
  }

  // Add warm-start + version-check cancellation to shutdown
  const origShutdown = shutdown;
  const wrappedShutdown = async (reason: string) => {
    cancelWarmStart?.();
    cancelVersionCheck?.();
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
