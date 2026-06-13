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
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { checkActivateRepo } from "../cloud/repo-cap.js";
import { repoLimit } from "../cloud/tier-model.js";
import { tierFromCache } from "../cloud/tier-query.js";
import {
  fleetUpgradePending,
  readUpdateState,
} from "../update/update-state.js";
import { repoLog, repoLogsDir } from "../utils/log-paths.js";
import { UNERR_VERSION } from "../version.js";
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

/**
 * The result of {@link ProcessManager.ensure}: the per-repo UDS sock path on
 * success, or a structured free-tier refusal when the single active slot is
 * already held by a different repo.
 */
export type EnsureRefusal = {
  refused: "already_active";
  activePath: string;
  message: string;
};
export type EnsureOutcome = string | EnsureRefusal;

/** Type guard — true when `ensure` refused rather than returning a sock path. */
export function isEnsureRefusal(o: EnsureOutcome): o is EnsureRefusal {
  return typeof o !== "string";
}

/**
 * One caller blocked in {@link ProcessManager.waitForReady} for a repo whose
 * proxy is still `starting`. The per-waiter timer rejects only this waiter on
 * the ready-timeout; it is cleared when the child reports ready / exits.
 */
interface ReadyWaiter {
  resolve: (sock: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
  /**
   * Every caller blocked in waitForReady for this repo. `ensure` requests are
   * dispatched concurrently (the daemon UDS server fires handleRequest per
   * frame without serializing), so two IDE sessions opening the same cold repo
   * both wait here. ALL waiters must be notified on ready / exit / error — a
   * single resolve/reject slot dropped every waiter but the last, hanging the
   * rest until the 6.5-min request timeout (the "second session times out" bug).
   */
  readyWaiters: ReadyWaiter[];
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

/**
 * After an auto-update lands on disk, idle proxies are recycled this much sooner
 * than their configured idleTimeout so the fleet adopts the new version fast.
 * One minute of zero connections is "idle enough" to recycle without disrupting
 * any session.
 */
const UPGRADE_RECYCLE_IDLE_MS = 60_000;

/**
 * Startup circuit breaker. After this many CONSECUTIVE failed startups (a
 * forked child exits before it ever signals "ready"), `ensure()` stops forking
 * and fast-fails with the captured exit reason instead of spawning another
 * doomed child. This turns an invisible fork storm — a stale or broken binary
 * respawned on every bridge retry, each fork paying a full reindex — into one
 * loud error that names the proxy.log to read. Half-open after the cooldown:
 * exactly one fresh attempt is allowed, so a transient cause self-heals.
 */
const STARTUP_FAILURE_THRESHOLD = 3;
const STARTUP_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Decide whether an idle per-repo proxy should be recycled NOW to adopt an
 * upgrade that already landed on disk. True only when an upgrade is pending and
 * the child is one we forked (not adopted), running, has no connected bridge,
 * and has been idle at least {@link UPGRADE_RECYCLE_IDLE_MS}. Pure + total.
 *
 * Recycling = stop the child; its next MCP request respawns it on the new
 * on-disk version. The bridge (`unerr --mcp`) always runs the on-disk version
 * and is re-spawned by the IDE, so "no connection" is exactly when recycling the
 * proxy is safe and sufficient to converge the fleet onto the upgrade.
 */
export function shouldRecycleForUpgrade(
  repo: Pick<
    ManagedRepo,
    "status" | "adopted" | "connections" | "lastActivity"
  >,
  now: number,
  upgradePending: boolean,
  idleMs: number = UPGRADE_RECYCLE_IDLE_MS
): boolean {
  if (!upgradePending) return false;
  if (repo.status !== "running") return false;
  if (repo.adopted) return false;
  if (repo.connections > 0) return false;
  return now - repo.lastActivity >= idleMs;
}

/** Liveness probe — does a process with this PID currently exist? */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Default budget for the UDS connectability probe (ms). */
const SOCK_PROBE_TIMEOUT_MS = 1_000;

/**
 * Probe whether a per-repo proxy's UDS socket is actually connectable.
 *
 * `existsSync(sockPath)` is NOT sufficient — a crashed proxy can leave a stale
 * socket *file* on disk that yields ECONNREFUSED on connect. We must attempt a
 * real connection. A connect succeeds at the kernel level the moment the proxy
 * has `listen()`ed, even while its event loop is blocked mid-index, so this
 * distinguishes "dead/stale socket" (the bug) from "alive but busy" (handled
 * separately by the bridge's static catalog) without waiting on a response.
 */
function isSockConnectable(
  sockPath: string,
  timeoutMs = SOCK_PROBE_TIMEOUT_MS
): Promise<boolean> {
  if (!existsSync(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // already torn down
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    const socket = createConnection(sockPath);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
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
  /**
   * Per-repo consecutive startup-failure tally for the circuit breaker. Keyed
   * by canonical repo key, kept OUTSIDE `repos` because the ManagedRepo entry
   * is recreated on every spawn. Incremented when a child dies while still
   * `starting`; cleared the moment a child reaches `ready` (or is adopted).
   */
  private startupFailures = new Map<
    string,
    { count: number; lastAt: number; lastError: string }
  >();

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
   *
   * Free-tier backstop: when the repo limit is 1 and a DIFFERENT repo is
   * already running/starting, refuses instead of spawning a second proxy —
   * returns a structured `{ refused: "already_active", activePath, message }`.
   * The daemon is single-process, so this check serializes without a race.
   */
  async ensure(repoPath: string): Promise<EnsureOutcome> {
    const key = canonRepoKey(repoPath);

    if (repoLimit(tierFromCache()) === 1) {
      const active = this.activeForeignRepo(key);
      if (active) {
        const verdict = checkActivateRepo({
          limit: 1,
          activePath: active,
          requestedPath: repoPath,
        });
        if (!verdict.allowed) {
          return {
            refused: "already_active",
            activePath: active,
            message: verdict.message,
          };
        }
      }
    }

    const existing = this.repos.get(key);
    if (existing?.status === "running" && existing.sock) {
      // "running" is only trustworthy if the proxy is BOTH alive AND its UDS
      // socket is actually connectable. Two independent checks:
      //   1. PID liveness — a forked child's death fires our `exit` listener so
      //      its status self-corrects, but an adopted proxy has no IPC handle,
      //      so we must re-probe its PID.
      //   2. Socket connectability — even a live proxy can have a stale/ENOENT
      //      socket (crash without exit, socket file removed, mid-restart).
      //      Returning that sock is exactly what made a bridge forward
      //      `initialize` into a dead socket and register zero tools.
      const pidAlive =
        !existing.adopted ||
        (existing.pid !== null && isProcessAlive(existing.pid));
      if (pidAlive && (await isSockConnectable(existing.sock))) {
        return existing.sock;
      }
      // Stale entry — drop it and fall through to adopt or spawn a fresh proxy.
      this.repos.delete(key);
      this.onEvent?.("stopped", existing, "stale socket — re-evaluating");
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
    if (adopted) {
      // A live proxy is serving — any prior fork failures are moot.
      this.startupFailures.delete(key);
      return adopted;
    }

    // Startup circuit breaker: if this repo's child has failed to start
    // STARTUP_FAILURE_THRESHOLD times in a row and we're still inside the
    // cooldown, do NOT fork another doomed child — fast-fail with the captured
    // reason. This stops the fork storm (each fork pays a full reindex) and
    // turns a silent crash-loop into one actionable error.
    const breaker = this.startupFailures.get(key);
    if (
      breaker &&
      breaker.count >= STARTUP_FAILURE_THRESHOLD &&
      Date.now() - breaker.lastAt < STARTUP_BREAKER_COOLDOWN_MS
    ) {
      const waitS = Math.ceil(
        (STARTUP_BREAKER_COOLDOWN_MS - (Date.now() - breaker.lastAt)) / 1000
      );
      throw new Error(
        `unerr proxy for ${repoPath} failed to start ${breaker.count}× in a row ` +
          `(last exit: ${breaker.lastError}). Pausing respawns for ${waitS}s. ` +
          `Read ${repoLog.proxy(repoPath)} for the crash, then \`unerr pm stop\` and reconnect.`
      );
    }

    try {
      return await this.spawn(key);
    } catch (err) {
      // The forked child can lose the per-repo PID-lock race to a proxy that
      // came up between tryAdopt and fork (a concurrent ensure on another
      // unerrd, a standalone `unerr`, or an orphan that outlived a prior
      // generation). That child exits during startup without ever serving —
      // proxy.ts exits 0 on a held lock — but the winner is now live and
      // adoptable. Re-probe once so a lost race returns the real proxy's sock
      // instead of surfacing "Child exited during startup" and stranding the
      // bridge in its ensureRepo retry loop.
      const readopted = this.tryAdopt(key);
      if (readopted) {
        this.startupFailures.delete(key);
        return readopted;
      }
      throw err;
    }
  }

  /**
   * The path of a managed repo currently `running` or `starting` that is NOT
   * `excludeKey`, or null when no other repo is active. Used by the free-tier
   * single-active backstop to refuse a second concurrent repo.
   */
  private activeForeignRepo(excludeKey: string): string | null {
    for (const [key, repo] of this.repos) {
      if (key === excludeKey) continue;
      if (repo.status === "running" || repo.status === "starting") {
        return repo.path;
      }
    }
    return null;
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
      readyWaiters: [],
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

  /**
   * U5: true when no IDE is connected to any managed repo — the quiet window in
   * which an auto-update may safely apply (no in-flight MCP session to disrupt).
   * Adopted external proxies run their own lifecycle, so their connections don't
   * count against the daemon's quiet state.
   */
  isQuietForUpdate(): boolean {
    for (const repo of this.repos.values()) {
      if (repo.adopted) continue;
      if (repo.connections > 0) return false;
    }
    return true;
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
      readyWaiters: [],
    };
    this.repos.set(repoPath, repo);

    const unerrBin = process.argv[1]!;

    // Child stderr → the repo's own proxy.log (append), NOT inherited. The
    // daemon runs detached with stderr on /dev/null, so an inherited fd 2
    // silently swallows a child's startup crash — exactly how a stale binary
    // crash-looped for hours with zero trace. A dedicated O_APPEND fd captures
    // every byte the child writes BEFORE it installs its own file logger
    // (the early sweep/cleanup calls in daemonChildBoot). Falls back to
    // "inherit" only if the log can't be opened.
    let stderrTarget: number | "inherit" = "inherit";
    let stderrFd: number | null = null;
    try {
      mkdirSync(repoLogsDir(repoPath), { recursive: true });
      stderrFd = openSync(repoLog.proxy(repoPath), "a");
      stderrTarget = stderrFd;
    } catch {
      // Can't open the log (perms, race) — inherit so we lose nothing we had.
    }

    const child = fork(unerrBin, ["--daemon-child"], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", stderrTarget, "ipc"],
      detached: false,
      env: {
        ...process.env,
        UNERR_DAEMON_CHILD: "1",
        UNERR_REPO_PATH: repoPath,
      },
    });

    // The child holds its own dup of the fd now; drop the parent's copy so a
    // long-lived daemon doesn't leak one fd per spawn.
    if (stderrFd !== null) {
      try {
        closeSync(stderrFd);
      } catch {
        /* already closed / never opened — nothing to do */
      }
    }

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
      this.rejectReadyWaiters(repo, err);
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
      // Append, never overwrite: concurrent ensure() callers for the same cold
      // repo each register their own waiter so all are woken on ready/exit.
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      waiter.timer = setTimeout(() => {
        // Time out only THIS waiter; others may have a longer budget left.
        const idx = repo.readyWaiters.indexOf(waiter);
        if (idx !== -1) repo.readyWaiters.splice(idx, 1);
        reject(
          new Error(
            `Repo process ${repo.path} failed to become ready in ${REPO_READY_TIMEOUT_MS}ms`
          )
        );
        // Only tear the child down once the LAST waiter has given up — killing
        // it while another session is still waiting would strand that session.
        if (repo.readyWaiters.length === 0 && repo.status === "starting") {
          repo.status = "error";
          repo.child?.kill("SIGTERM");
        }
      }, REPO_READY_TIMEOUT_MS);
      waiter.timer.unref();
      repo.readyWaiters.push(waiter);
    });
  }

  /** Resolve every waiter blocked on this repo becoming ready, then clear them. */
  private resolveReadyWaiters(repo: ManagedRepo, sock: string): void {
    const waiters = repo.readyWaiters;
    repo.readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(sock);
    }
  }

  /** Reject every waiter blocked on this repo becoming ready, then clear them. */
  private rejectReadyWaiters(repo: ManagedRepo, err: Error): void {
    const waiters = repo.readyWaiters;
    repo.readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  // ── Internal: IPC handling ──────────────────────────────────

  private handleChildMessage(repoPath: string, msg: ChildMessage): void {
    const repo = this.repos.get(repoPath);
    if (!repo) return;

    switch (msg.type) {
      case "ready":
        repo.sock = msg.sock;
        repo.status = "running";
        // A clean startup clears any prior failure tally — the breaker only
        // trips on CONSECUTIVE misses.
        this.startupFailures.delete(repoPath);
        this.resolveReadyWaiters(repo, msg.sock);
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
      // Startup failure: the child died before it ever signaled "ready". Tally
      // it for the circuit breaker so a crash-loop trips after
      // STARTUP_FAILURE_THRESHOLD consecutive misses instead of forking forever.
      const b = this.startupFailures.get(repoPath) ?? {
        count: 0,
        lastAt: 0,
        lastError: "",
      };
      b.count += 1;
      b.lastAt = Date.now();
      b.lastError = `code=${code}, signal=${signal}`;
      this.startupFailures.set(repoPath, b);
      if (b.count === STARTUP_FAILURE_THRESHOLD) {
        this.onEvent?.(
          "error",
          repo,
          `startup circuit OPEN: ${b.count} consecutive failures (last ${b.lastError}); pausing respawns for ${STARTUP_BREAKER_COOLDOWN_MS / 1000}s — read ${repoLog.proxy(repoPath)}`
        );
      }

      this.rejectReadyWaiters(
        repo,
        new Error(
          `Child exited during startup (code=${code}, signal=${signal})`
        )
      );
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

    // Ride the sweep for the throttled auto-update cycle (U1 detection + U5
    // apply). Fire-and-forget + self-throttling (24h) + never-throws, so it adds
    // no latency and a failed/offline check is silent. `isQuiet` gates the apply
    // so an upgrade only ever runs when no IDE is connected. Lazy import keeps
    // the update subsystem out of the manager's hot module graph.
    void import("../update/update-runner.js")
      .then((m) => m.runUpdateCycle({ isQuiet: () => this.isQuietForUpdate() }))
      .catch(() => {
        /* best-effort — auto-update never breaks the sweep */
      });

    // Did an auto-update already land on disk that the running fleet hasn't
    // adopted? If so, idle proxies are recycled early (below) to pick it up.
    // Best-effort — a missing/corrupt state file reads as "no upgrade pending".
    let upgradePending = false;
    try {
      upgradePending = fleetUpgradePending(readUpdateState(), UNERR_VERSION);
    } catch {
      /* never break the sweep on a state read */
    }

    for (const repo of this.repos.values()) {
      if (repo.status !== "running") continue;
      // Adopted external proxies have no IPC handle and run their own idle
      // lifecycle (own PID lock) — unerrd doesn't sweep what it didn't fork.
      if (repo.adopted) continue;
      if (repo.connections > 0) continue;

      // Upgrade adoption: recycle an idle proxy early — even one pinned with
      // idleTimeout === 0 — so its next spawn runs the new on-disk version.
      if (shouldRecycleForUpgrade(repo, now, upgradePending)) {
        this.onEvent?.(
          "stopped",
          repo,
          "recycling idle proxy to adopt upgrade"
        );
        this.shutdownChild(repo).catch(() => {
          /* best-effort */
        });
        continue;
      }

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
