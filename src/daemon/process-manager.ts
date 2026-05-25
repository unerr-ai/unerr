/**
 * Process manager — spawn, stop, monitor, and idle-sweep per-repo child processes.
 *
 * Each managed repo gets a single Node.js child process (fork of `unerr --daemon-child`).
 * Communication is via Node.js IPC channel (`process.send` / `process.on('message')`).
 *
 * The idle sweep runs every 60s. A repo process is eligible for stop when:
 *   - Zero active connections (no IDE bridges connected)
 *   - lastActivity older than the repo's idleTimeout
 *
 * Child lifecycle:
 *   fork() → child sends { type: "ready", sock } → status = "running"
 *   child sends { type: "activity" } → updates lastActivity
 *   parent sends { type: "shutdown" } → child snapshots + exits
 *   child exits → status = "stopped", cleanup
 */

import { type ChildProcess, fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ChildMessage,
  NeedsInputSignal,
  RepoEntry,
  RepoStatus,
  RepoStatusEntry,
} from "./protocol.js";
import { REPO_READY_TIMEOUT_MS } from "./protocol.js";
import {
  expandHome,
  readNeedsInput,
  readRegistry,
  writeRegistry,
} from "./registry.js";

// ── Types ───────────────────────────────────────────────────────

export interface ManagedRepo {
  path: string;
  label: string;
  idleTimeout: number;
  status: RepoStatus;
  child: ChildProcess | null;
  pid: number | null;
  sock: string | null;
  connections: number;
  lastActivity: number;
  startedAt: number | null;
  memory: number | null;
  entities: number | null;
  edges: number | null;
  needsInput: NeedsInputSignal[];
  readyResolve: ((sock: string) => void) | null;
  readyReject: ((err: Error) => void) | null;
  /**
   * True when this entry was adopted from an already-running per-repo proxy
   * (prior unerrd generation, standalone `unerr`, or one that outlived our
   * restart) rather than forked by us. We hold no IPC handle (`child` is null),
   * so liveness is probed by PID and shutdown is signalled by PID.
   */
  adopted?: boolean;
}

export type ProcessEventHandler = (
  event: "started" | "stopped" | "error" | "activity",
  repo: ManagedRepo,
  detail?: string
) => void;

// ── Process Manager ─────────────────────────────────────────────

const IDLE_SWEEP_INTERVAL_MS = 60_000;

/** Liveness probe — does a process with this PID currently exist? */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Canonicalize a repo path to the single absolute key used in the repos map. */
function canonRepoKey(repoPath: string): string {
  return resolve(expandHome(repoPath));
}

export class ProcessManager {
  private repos = new Map<string, ManagedRepo>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private onEvent: ProcessEventHandler | null = null;
  private stopped = false;

  /** Register an event handler for lifecycle events (logging, dashboard SSE). */
  setEventHandler(handler: ProcessEventHandler): void {
    this.onEvent = handler;
  }

  /** Start the idle sweep timer. */
  startIdleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => this.runIdleSweep(),
      IDLE_SWEEP_INTERVAL_MS
    );
    this.sweepTimer.unref();
  }

  /** Stop the idle sweep timer. */
  stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Ensure a repo process is running. If already running, returns the sock path.
   * If stopped, spawns it and waits for the "ready" IPC message.
   */
  async ensure(repoPath: string): Promise<string> {
    const key = canonRepoKey(repoPath);
    const existing = this.repos.get(key);
    if (existing?.status === "running" && existing.sock) {
      // A forked child's death fires our `exit` listener, so its "running"
      // status is trustworthy. An adopted proxy has no IPC handle, so re-probe
      // its PID — if it died we never heard about it; drop and re-evaluate.
      if (
        !existing.adopted ||
        (existing.pid !== null && isProcessAlive(existing.pid))
      ) {
        return existing.sock;
      }
      this.repos.delete(key);
    } else if (existing?.status === "starting") {
      return this.waitForReady(existing);
    }

    // Adopt an already-live per-repo proxy (started by a prior unerrd
    // generation, a standalone `unerr`, or one that outlived our restart)
    // instead of forking a throwaway child. The child would lose the PID-lock
    // race in proxy.ts, exit(0) without sending "ready", and be marked
    // "stopped" — the churn that left the real primary serving but untracked
    // while `pm status` and the dashboard read "stopped".
    const adopted = this.tryAdopt(key);
    if (adopted) return adopted;

    return this.spawn(key);
  }

  /**
   * Adopt a per-repo proxy that is already alive on disk — PID lock present and
   * the named process running, with its UDS socket in place. Registers a
   * managed entry (with no child handle) and returns the socket, so unerrd
   * tracks and forwards to the live proxy instead of forking a duplicate.
   * Returns null when no live proxy is present (caller then spawns one).
   */
  private tryAdopt(repoPath: string): string | null {
    const stateDir = join(repoPath, ".unerr", "state");
    const sockPath = join(stateDir, "proxy.sock");
    const pidFilePath = join(stateDir, "proxy.pid");
    if (!existsSync(sockPath) || !existsSync(pidFilePath)) return null;

    let pid: number | null = null;
    try {
      const parsed = JSON.parse(readFileSync(pidFilePath, "utf-8")) as {
        pid?: number;
      };
      pid = typeof parsed.pid === "number" ? parsed.pid : null;
    } catch {
      return null;
    }
    if (pid === null || !isProcessAlive(pid)) return null;

    const reg = readRegistry();
    const entry = reg.repos.find((r) => r.path === repoPath);
    const repo: ManagedRepo = {
      path: repoPath,
      label: entry?.label ?? repoPath.split("/").pop() ?? repoPath,
      idleTimeout: entry?.idleTimeout ?? 1800,
      status: "running",
      child: null,
      pid,
      sock: sockPath,
      connections: 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      memory: null,
      entities: null,
      edges: null,
      needsInput: [],
      readyResolve: null,
      readyReject: null,
      adopted: true,
    };
    this.repos.set(repoPath, repo);
    this.onEvent?.("started", repo, "adopted existing proxy");
    return sockPath;
  }

  /** Record that a bridge connected to this repo. */
  connect(repoPath: string): void {
    const repo = this.repos.get(canonRepoKey(repoPath));
    if (repo) {
      repo.connections++;
      repo.lastActivity = Date.now();
    }
  }

  /** Record that a bridge disconnected from this repo. */
  disconnect(repoPath: string): void {
    const repo = this.repos.get(canonRepoKey(repoPath));
    if (repo && repo.connections > 0) {
      repo.connections--;
    }
  }

  /** Record activity (tool call) for this repo. */
  recordActivity(repoPath: string): void {
    const repo = this.repos.get(canonRepoKey(repoPath));
    if (repo) {
      repo.lastActivity = Date.now();
      this.onEvent?.("activity", repo);
    }
  }

  /** Gracefully stop a specific repo's process. */
  async stop(repoPath: string): Promise<void> {
    const repo = this.repos.get(canonRepoKey(repoPath));
    if (!repo || repo.status === "stopped") return;
    if (!repo.child) {
      // Adopted external proxy — no IPC handle; terminate by PID if alive.
      if (repo.adopted && repo.pid !== null && isProcessAlive(repo.pid)) {
        try {
          process.kill(repo.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      repo.status = "stopped";
      repo.pid = null;
      repo.sock = null;
      repo.connections = 0;
      this.onEvent?.("stopped", repo, "adopted proxy signaled");
      return;
    }
    await this.shutdownChild(repo);
  }

  /** Gracefully stop ALL children, then clean up. */
  async shutdownAll(): Promise<void> {
    this.stopped = true;
    this.stopIdleSweep();

    const shutdowns: Promise<void>[] = [];
    for (const repo of this.repos.values()) {
      if (repo.child && repo.status !== "stopped") {
        shutdowns.push(this.shutdownChild(repo));
      }
    }
    await Promise.allSettled(shutdowns);
  }

  /** Get status for all managed repos (for daemon status / dashboard). */
  getStatus(): RepoStatusEntry[] {
    const registry = readRegistry();
    const entries: RepoStatusEntry[] = [];

    for (const regEntry of registry.repos) {
      const managed = this.repos.get(regEntry.path);
      entries.push({
        path: regEntry.path,
        label: regEntry.label,
        status: managed?.status ?? "stopped",
        pid: managed?.pid ?? null,
        memory: managed?.memory ?? null,
        idle: managed?.lastActivity
          ? Math.round((Date.now() - managed.lastActivity) / 1000)
          : null,
        connections: managed?.connections ?? 0,
        lastActivity: managed?.lastActivity
          ? new Date(managed.lastActivity).toISOString()
          : regEntry.lastActivity,
        entityCount: managed?.entities ?? null,
        edgeCount: managed?.edges ?? null,
        needsInput: managed?.needsInput ?? readNeedsInput(regEntry.path),
      });
    }

    return entries;
  }

  /** Get a managed repo record (for internal use). */
  getManaged(repoPath: string): ManagedRepo | undefined {
    return this.repos.get(canonRepoKey(repoPath));
  }

  // ── Internal: spawn ─────────────────────────────────────────

  private async spawn(repoPath: string): Promise<string> {
    const reg = readRegistry();
    const entry = reg.repos.find((r) => r.path === repoPath);

    const repo: ManagedRepo = {
      path: repoPath,
      label: entry?.label ?? repoPath.split("/").pop() ?? repoPath,
      idleTimeout: entry?.idleTimeout ?? 1800,
      status: "starting",
      child: null,
      pid: null,
      sock: null,
      connections: 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
      memory: null,
      entities: null,
      edges: null,
      needsInput: [],
      readyResolve: null,
      readyReject: null,
    };
    this.repos.set(repoPath, repo);

    const unerrBin = process.argv[1]!;

    const child = fork(unerrBin, ["--daemon-child"], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      detached: false,
      env: {
        ...process.env,
        UNERR_DAEMON_CHILD: "1",
        UNERR_REPO_PATH: repoPath,
      },
    });

    repo.child = child;
    repo.pid = child.pid ?? null;

    child.on("message", (msg: ChildMessage) => {
      this.handleChildMessage(repoPath, msg);
    });

    child.on("exit", (code, signal) => {
      this.handleChildExit(repoPath, code, signal);
    });

    child.on("error", (err) => {
      repo.status = "error";
      repo.readyReject?.(err);
      repo.readyResolve = null;
      repo.readyReject = null;
      this.onEvent?.("error", repo, err.message);
    });

    // Update registry lastStarted
    if (entry) {
      entry.lastStarted = new Date().toISOString();
      writeRegistry(reg);
    }

    return this.waitForReady(repo);
  }

  private waitForReady(repo: ManagedRepo): Promise<string> {
    if (repo.sock && repo.status === "running") {
      return Promise.resolve(repo.sock);
    }

    return new Promise<string>((resolve, reject) => {
      repo.readyResolve = resolve;
      repo.readyReject = reject;

      const timer = setTimeout(() => {
        repo.readyReject?.(
          new Error(
            `Repo process ${repo.path} failed to become ready in ${REPO_READY_TIMEOUT_MS}ms`
          )
        );
        repo.readyResolve = null;
        repo.readyReject = null;
        if (repo.status === "starting") {
          repo.status = "error";
          repo.child?.kill("SIGTERM");
        }
      }, REPO_READY_TIMEOUT_MS);
      timer.unref();
    });
  }

  // ── Internal: IPC handling ──────────────────────────────────

  private handleChildMessage(repoPath: string, msg: ChildMessage): void {
    const repo = this.repos.get(repoPath);
    if (!repo) return;

    switch (msg.type) {
      case "ready":
        repo.sock = msg.sock;
        repo.status = "running";
        repo.readyResolve?.(msg.sock);
        repo.readyResolve = null;
        repo.readyReject = null;
        this.onEvent?.("started", repo);
        break;

      case "activity":
        repo.lastActivity = Date.now();
        this.onEvent?.("activity", repo);
        break;

      case "stats":
        repo.entities = msg.entities;
        repo.edges = msg.edges;
        repo.memory = msg.memory;
        break;

      case "needs_input":
        repo.needsInput = msg.signals;
        break;
    }
  }

  private handleChildExit(
    repoPath: string,
    code: number | null,
    signal: string | null
  ): void {
    const repo = this.repos.get(repoPath);
    if (!repo) return;

    const prev = repo.status;
    repo.status = "stopped";
    repo.child = null;
    repo.pid = null;
    repo.sock = null;
    repo.connections = 0;

    if (prev === "starting") {
      repo.readyReject?.(
        new Error(
          `Child exited during startup (code=${code}, signal=${signal})`
        )
      );
      repo.readyResolve = null;
      repo.readyReject = null;
    }

    this.onEvent?.("stopped", repo, `code=${code}, signal=${signal}`);
  }

  // ── Internal: graceful shutdown ─────────────────────────────

  private shutdownChild(repo: ManagedRepo): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!repo.child) {
        resolve();
        return;
      }

      const child = repo.child;
      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 10_000);
      timer.unref();

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        child.send({ type: "shutdown" });
      } catch {
        child.kill("SIGTERM");
      }
    });
  }

  // ── Internal: idle sweep ────────────────────────────────────

  private runIdleSweep(): void {
    if (this.stopped) return;

    const now = Date.now();

    for (const repo of this.repos.values()) {
      if (repo.status !== "running") continue;
      // Adopted external proxies have no IPC handle and run their own idle
      // lifecycle (own PID lock) — unerrd doesn't sweep what it didn't fork.
      if (repo.adopted) continue;
      if (repo.connections > 0) continue;
      if (repo.idleTimeout === 0) continue;

      const idleMs = now - repo.lastActivity;
      const timeoutMs = repo.idleTimeout * 1000;

      if (idleMs >= timeoutMs) {
        this.shutdownChild(repo).catch(() => {
          /* best-effort */
        });
      }
    }
  }
}
