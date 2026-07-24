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

import {
  type ChildProcess,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
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
import { forkUnerr } from "../utils/self-spawn.js";
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
  touchRepoActivity,
  touchRepoStarted,
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
  /**
   * Consecutive failed liveness probes (see {@link ProcessManager.probeLiveness}).
   * Reset to 0 on any successful /health ping; at LIVENESS_MAX_STRIKES the proxy
   * is treated as wedged and recycled.
   */
  livenessFailures?: number;
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

/** Grace period after SIGTERM before a stray proxy is force-killed (ms). */
const PROXY_KILL_GRACE_MS = 3_000;

/**
 * SIGTERM a process and BLOCK until it has fully exited, escalating to SIGKILL
 * if it outlives the grace window. Used before forking a replacement proxy so
 * the old and new never coexist: while two proxies hold the same repo's
 * graph.db, every WAL checkpoint sees a pinned reader (busy) and graph.db-wal
 * sticks at its high-water mark until one dies. Waiting here eliminates that
 * restart-overlap window.
 */
async function killProcessAndWait(
  pid: number,
  graceMs = PROXY_KILL_GRACE_MS
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Grace elapsed and it is still up — force it, then confirm it is gone so the
  // caller can fork knowing the repo's graph.db has no other holder.
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  for (let i = 0; i < 40 && isProcessAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Parsed contents of a per-repo `proxy.pid` lock file (JSON `{pid, startedAt,
 *  healthPort}` — see `src/proxy/pid-lock.ts`). `healthPort` is absent on a
 *  legacy plain-number lock. */
interface ProxyLockData {
  pid: number;
  healthPort?: number;
}

/** Read + parse a per-repo proxy's lock file, or null if absent / unparseable.
 *  The single source of "which process owns this repo's graph.db" (and, when
 *  `healthPort` is present, where to health-ping it). */
function readProxyLockFile(stateDir: string): ProxyLockData | null {
  const pidFilePath = join(stateDir, "proxy.pid");
  if (!existsSync(pidFilePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath, "utf-8")) as {
      pid?: number;
      healthPort?: number;
    };
    return typeof parsed.pid === "number"
      ? { pid: parsed.pid, healthPort: parsed.healthPort }
      : null;
  } catch {
    return null;
  }
}

/** Read just the PID a per-repo proxy wrote to its lock file, or null if
 *  absent / unparseable. */
function readProxyLockPid(stateDir: string): number | null {
  return readProxyLockFile(stateDir)?.pid ?? null;
}

/** Remove a wedged/dead proxy's stale lock + socket files so a fresh fork owns
 *  them cleanly (the child re-creates both on boot). */
function clearProxyLockFiles(stateDir: string): void {
  for (const f of ["proxy.sock", "proxy.pid"]) {
    try {
      rmSync(join(stateDir, f), { force: true });
    } catch {
      // Best-effort — a fork overwrites them anyway.
    }
  }
}

/**
 * Classify a `ps … -o command=` string as a unerr per-repo proxy — either
 * managed (`--daemon-child`) or standalone (bare `unerr` / `node cli.js` with
 * no subcommand). Anchored on the CLI entry (`cli.js`) or the compiled binary
 * basename (`/unerr`) rather than a bare `unerr` substring, because the repo's
 * own path (`…/unerr-cli/…`) would false-match that. Excludes the process
 * manager (`unerrd`), the `--mcp` bridge, and the `exec` runner — none of
 * which ever open `graph.db` — so a bridge can never be misclassified as a
 * reapable proxy and killed. Mirrors `isUnerrProxyCommand` in
 * src/proxy/pid-lock.ts; that module must not import from src/daemon, so the
 * check is duplicated here rather than shared.
 */
export function isUnerrProxyCommand(cmd: string): boolean {
  if (!/cli\.js(\s|$)/.test(cmd) && !/\/unerr(\s|$)/.test(cmd)) return false;
  if (/\bunerrd\b/.test(cmd)) return false;
  if (/(^|\s)--mcp(\s|$)/.test(cmd)) return false;
  if (/(^|\s)exec(\s|$)/.test(cmd)) return false;
  return true;
}

/**
 * Confirm a pid read from a proxy lock file is genuinely a unerr per-repo proxy
 * (managed or standalone) before force-killing it. A lock file can outlive its
 * process; the OS may have recycled that pid onto an UNRELATED program, and
 * killing it would take down someone else's work. Any failure to verify
 * returns false, so an unconfirmable pid is never killed.
 */
function isUnerrProxyProcess(pid: number): boolean {
  if (process.platform === "win32") {
    // No portable `ps`; skip the kill rather than risk an unrelated process.
    return false;
  }
  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1_000,
      windowsHide: true,
    });
    return out.status === 0 && isUnerrProxyCommand(out.stdout ?? "");
  } catch {
    return false; // cannot verify → never kill
  }
}

/** Canonicalize a repo path to the single absolute key used in the repos map. */
function canonRepoKey(repoPath: string): string {
  return resolve(expandHome(repoPath));
}

/** Growing per-attempt timeout budget for {@link pingHealth} (ms). */
const HEALTH_PING_TIMEOUTS_MS = [500, 1_000, 1_500];

/** Skip the liveness probe for this long after a proxy spawns — its health
 *  server may not be listening yet during first-run index. */
const LIVENESS_PROBE_GRACE_MS = 30_000;

/** Recycle a running proxy only after this many CONSECUTIVE failed liveness
 *  probes, so a single transient hiccup never kills a live session. */
const LIVENESS_MAX_STRIKES = 2;

/**
 * Pure liveness state transition. A successful /health ping resets the strike
 * count to 0; a failure increments it and recycles the proxy once it reaches
 * {@link LIVENESS_MAX_STRIKES}. Extracted so the strike/reset logic is unit
 * tested without a real thread, network, or child process.
 */
export function nextLivenessState(
  currentFailures: number,
  pingAlive: boolean
): { failures: number; recycle: boolean } {
  if (pingAlive) return { failures: 0, recycle: false };
  const failures = currentFailures + 1;
  return { failures, recycle: failures >= LIVENESS_MAX_STRIKES };
}

/**
 * Best-effort HTTP GET against a proxy's `/health` endpoint (the port the
 * `proxy.pid` lock file names), retried with a growing timeout so a proxy
 * that is merely busy for a few hundred ms isn't misclassified as wedged.
 * Returns false only after every attempt fails (connection refused, timeout,
 * non-2xx) — never throws.
 */
export async function pingHealth(healthPort: number): Promise<boolean> {
  for (const timeoutMs of HEALTH_PING_TIMEOUTS_MS) {
    try {
      const res = await fetch(`http://127.0.0.1:${healthPort}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
    } catch {
      // connection refused / timed out — try again with a longer budget
    }
  }
  return false;
}

/** Parse `ps`'s `etime` column (`[[dd-]hh:]mm:ss`) into elapsed seconds. */
function parseEtimeToSeconds(etime: string): number {
  let days = 0;
  let rest = etime;
  const dashIdx = rest.indexOf("-");
  if (dashIdx !== -1) {
    days = Number.parseInt(rest.slice(0, dashIdx), 10) || 0;
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(":").map((p) => Number.parseInt(p, 10) || 0);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = (parts[0] ?? 0) * 3_600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  } else if (parts.length === 2) {
    seconds = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  } else if (parts.length === 1) {
    seconds = parts[0] ?? 0;
  }
  return days * 86_400 + seconds;
}

/**
 * Every live pid holding an open file handle on `<repoPath>/.unerr/graph.db`
 * — the definitive proof a process is a per-repo proxy WRITER for that repo.
 * A `--mcp` bridge or `exec` runner never opens `graph.db`, so this gate can
 * never catch one of those (unlike the old `--daemon-child` argv scan, which
 * was blind to a STANDALONE duplicate proxy — no `--daemon-child` flag — and
 * let exactly that double-writer incident through). Linux resolves via
 * `/proc/<pid>/fd` symlinks (falls back to `lsof` if that yields nothing —
 * e.g. `/proc` unreadable for another uid); macOS/BSD uses `lsof -t` directly.
 * Best-effort: any failure (`lsof`/`ps` missing, permission denied, an
 * unsupported platform) yields an empty list rather than throwing.
 */
function pidsHoldingRepoGraphDb(
  repoPath: string
): { pid: number; startedAt: number }[] {
  if (process.platform === "win32") return [];
  const graphDbPath = join(repoPath, ".unerr", "graph.db");
  let pids: number[];
  try {
    pids =
      process.platform === "linux"
        ? listGraphDbHolderPidsViaProc(graphDbPath)
        : [];
    if (pids.length === 0) pids = listGraphDbHolderPidsViaLsof(graphDbPath);
  } catch {
    return [];
  }

  const now = Date.now();
  const result: { pid: number; startedAt: number }[] = [];
  for (const pid of pids) {
    try {
      const out = spawnSync("ps", ["-p", String(pid), "-o", "etime="], {
        encoding: "utf-8",
        timeout: 1_000,
        windowsHide: true,
      });
      if (out.status !== 0 || !out.stdout?.trim()) continue;
      const elapsedS = parseEtimeToSeconds(out.stdout.trim());
      result.push({ pid, startedAt: now - elapsedS * 1_000 });
    } catch {
      // pid exited mid-probe — skip it, don't let one bad pid break the rest
    }
  }
  return result;
}

/** `lsof -t` against a single file path → the pids with it open. Works on
 *  macOS/BSD and as the Linux fallback when `/proc` scanning finds nothing. */
function listGraphDbHolderPidsViaLsof(filePath: string): number[] {
  try {
    const out: SpawnSyncReturns<string> = spawnSync(
      "lsof",
      ["-t", "--", filePath],
      { encoding: "utf-8", timeout: 2_000, windowsHide: true }
    );
    if (out.status !== 0 || !out.stdout) return [];
    return out.stdout
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

/** Linux-only: scan every live pid's `/proc/<pid>/fd` symlinks for one
 *  resolving to `filePath`. Avoids a dependency on `lsof` being installed. */
function listGraphDbHolderPidsViaProc(filePath: string): number[] {
  let pidDirs: string[];
  try {
    pidDirs = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const pidStr of pidDirs) {
    const fdDir = `/proc/${pidStr}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue; // permission denied (different uid) or pid exited — skip
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`${fdDir}/${fd}`) === filePath) {
          found.push(Number.parseInt(pidStr, 10));
          break;
        }
      } catch {
        // fd closed mid-probe — skip
      }
    }
  }
  return found;
}

/**
 * Pure decision for the reaper: given every live `--daemon-child` for ONE
 * repo and which pid (if any) currently holds that repo's PID lock, return
 * the pids to kill so at most one survives. The lock holder — the process
 * `graph.db`'s writers are supposed to converge on — is always kept when it's
 * among the live set. When none of the live children holds the lock (stale,
 * missing, or unreadable lock file), killing every one of them would leave
 * the repo with ZERO proxies, which is worse than a leaked duplicate — so the
 * most-recently-started child is kept instead and every older one is killed.
 */
export function selectDuplicateChildrenToKill(
  children: { pid: number; startedAt: number }[],
  lockHolderPid: number | null
): number[] {
  if (children.length <= 1) return [];
  if (lockHolderPid !== null && children.some((c) => c.pid === lockHolderPid)) {
    return children.filter((c) => c.pid !== lockHolderPid).map((c) => c.pid);
  }
  const newest = children.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  return children.filter((c) => c.pid !== newest.pid).map((c) => c.pid);
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
    // Catch a double-writer left by a PRIOR unerrd generation as soon as this
    // one comes up, rather than waiting up to 60s for the first sweep tick.
    void this.reapDuplicateChildren().catch(() => {
      /* best-effort — never block startup */
    });
    this.sweepTimer = setInterval(
      () => this.runIdleSweep(),
      IDLE_SWEEP_INTERVAL_MS
    );
    this.sweepTimer.unref();
  }

  /**
   * Enforce at most one live writer per repo's `graph.db` — a backstop beyond
   * `tryAdopt`'s health-ping for the case something still slips through (a
   * leftover child from a prior unerrd generation, a double-fork race, or a
   * STANDALONE proxy started outside unerrd entirely). Two processes writing
   * one repo's `graph.db` is the exact WAL-growth incident this guards
   * against: neither's `wal_checkpoint(TRUNCATE)` can ever succeed while the
   * other holds a read/write handle, so the WAL grows unbounded. For every
   * registered repo, finds every live pid actually holding that repo's
   * `graph.db` open ({@link pidsHoldingRepoGraphDb} — ground truth; a
   * `--mcp` bridge or `exec` runner can never appear here, so this can never
   * kill one) and, when 2+ hold it, kills every pid except the one
   * {@link selectDuplicateChildrenToKill} decides to keep. Best-effort and
   * conservative: `ps`/`lsof`/`/proc` failures or an unconfirmed pid make
   * this a no-op for that pid — a missed duplicate is far safer than a
   * wrongful kill.
   *
   */
  async reapDuplicateChildren(): Promise<void> {
    if (this.stopped) return;

    let repos: RepoEntry[];
    try {
      repos = readRegistry().repos;
    } catch {
      return; // best-effort — never break the caller
    }

    for (const repo of repos) {
      const repoKey = canonRepoKey(repo.path);
      let holders: { pid: number; startedAt: number }[];
      try {
        holders = pidsHoldingRepoGraphDb(repoKey);
      } catch {
        continue; // best-effort — one repo's failure never blocks the rest
      }
      if (holders.length < 2) continue;

      const stateDir = join(repoKey, ".unerr", "state");
      const lockHolderPid = readProxyLockPid(stateDir);
      const toKill = selectDuplicateChildrenToKill(holders, lockHolderPid);
      for (const pid of toKill) {
        // Belt-and-suspenders re-confirm — holding graph.db is already proof.
        if (!isUnerrProxyProcess(pid)) continue;
        this.onEvent?.(
          "stopped",
          { path: repoKey, pid } as ManagedRepo,
          `duplicate graph.db writer for ${repoKey} — killing extra PID ${pid}`
        );
        await killProcessAndWait(pid);
      }
    }
  }

  /** Stop the idle sweep timer. */
  stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Free-tier single-active reconciler. The admission check in `ensure` only
   * blocks NEW foreign starts — it never stops proxies already running (a set
   * admitted while the account was Pro, then lapsed to free, keeps running).
   * When the resolved repo limit is 1, bring the running set down to that one
   * slot: keep the repo with the most connections, then the most recent
   * activity (ties by newest start), and stop every other live proxy — forked
   * or adopted. No-op when the limit is unlimited (Pro/Team) or ≤1 proxy runs.
   * Returns the count stopped. Never throws — a failed stop retries next call.
   *
   */
  async reconcileFreeTier(): Promise<number> {
    if (this.stopped) return 0;
    if (repoLimit(tierFromCache()) !== 1) return 0;

    const live = [...this.repos.values()].filter(
      (r) => r.status === "running" || r.status === "starting"
    );
    if (live.length <= 1) return 0;

    // Keep the repo the user is most likely inside: most connections first, then
    // most-recently-active, then newest start. Every other live proxy is stopped.
    const keep = live.reduce((best, r) => {
      if (r.connections !== best.connections) {
        return r.connections > best.connections ? r : best;
      }
      if (r.lastActivity !== best.lastActivity) {
        return r.lastActivity > best.lastActivity ? r : best;
      }
      return (r.startedAt ?? 0) > (best.startedAt ?? 0) ? r : best;
    });

    let stopped = 0;
    for (const repo of live) {
      if (repo === keep) continue;
      this.onEvent?.("stopped", repo, "free-tier single-active reconcile");
      try {
        await this.stop(repo.path);
        stopped++;
      } catch {
        /* best-effort — a failed stop is retried on the next reconcile */
      }
    }
    return stopped;
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
    const adopted = await this.tryAdopt(key);
    if (adopted) {
      // A live proxy is serving — any prior fork failures are moot.
      this.startupFailures.delete(key);
      // Stamp lastStarted here too: adoption means this repo is now in active
      // use, just like a fresh fork (which stamps it in spawn()). Without this,
      // fleet `last_used_at` stayed null on every repo a long-lived daemon
      // adopted rather than forked.
      touchRepoStarted(key, new Date().toISOString());
      return adopted;
    }

    // `await tryAdopt` above yields the event loop, so a CONCURRENT ensure() for
    // the same cold repo can create the `starting` entry (and fork its child)
    // while we were suspended. Re-check before forking: join the in-flight
    // startup as a waiter instead of forking a SECOND duplicate child — without
    // this, two IDE sessions opening the same repo each fork, and the first
    // caller's waiter is orphaned on the overwritten entry and hangs.
    const concurrent = this.repos.get(key);
    if (concurrent?.status === "starting") {
      return this.waitForReady(concurrent);
    }
    if (concurrent?.status === "running" && concurrent.sock) {
      return concurrent.sock;
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
      const readopted = await this.tryAdopt(key);
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
   * Adopt a per-repo proxy that is already alive on disk — PID lock present,
   * the named process running, its UDS socket connectable, AND its `/health`
   * endpoint responsive. Registers a managed entry (with no child handle) and
   * returns the socket, so unerrd tracks and forwards to the live proxy
   * instead of forking a duplicate. Returns null when no live, healthy proxy
   * is present (caller then spawns one) — including when the pid/socket look
   * alive but `/health` never answers, which kills the wedged holder first so
   * the fresh fork is the sole writer of the repo's `graph.db`.
   */
  private async tryAdopt(repoPath: string): Promise<string | null> {
    const stateDir = join(repoPath, ".unerr", "state");
    const sockPath = join(stateDir, "proxy.sock");
    if (!existsSync(sockPath)) return null;

    const pid = readProxyLockPid(stateDir);
    if (pid === null || !isProcessAlive(pid)) {
      // Dead pid behind a leftover lock — clear the stale files so the fresh
      // fork acquires the lock cleanly instead of racing a ghost entry.
      clearProxyLockFiles(stateDir);
      return null;
    }

    // The pid is alive, but only a CONNECTABLE proxy is actually serving. A
    // proxy whose pid lives but whose UDS socket refuses a connection is WEDGED
    // (crashed mid-init, holding the lock, or mid-restart). Adopting it returns
    // a dead sock — the bridge forwards `initialize` into nothing and the
    // dashboard/pm-status flap "stopped" — AND it keeps holding graph.db, so no
    // WAL checkpoint can truncate and graph.db-wal sticks at its high-water
    // mark. Kill it, wait for a FULL exit, clear its files, then fall through to
    // fork a fresh SOLE owner. This is what closes the restart-overlap window.
    // (`isSockConnectable` succeeds the moment the proxy has `listen()`ed, even
    // while mid-index, so a merely-busy proxy is adopted here, never killed.)
    if (!(await isSockConnectable(sockPath))) {
      // Only force-kill a pid we can CONFIRM is a unerr proxy — a stale lock may
      // point at a recycled, unrelated pid we must never signal. If unconfirmed,
      // skip the kill but still clear the stale files so the fresh fork owns the
      // lock cleanly.
      if (isUnerrProxyProcess(pid)) {
        this.onEvent?.(
          "stopped",
          { path: repoPath, pid } as ManagedRepo,
          "wedged proxy (alive pid, dead socket) — killing before respawn"
        );
        await killProcessAndWait(pid);
      }
      clearProxyLockFiles(stateDir);
      return null;
    }

    // A connectable socket only proves the proxy called `listen()` — not that
    // its event loop is unblocked. This is the exact gap the WAL-growth
    // incident exploited: a proxy pegged on a CozoDB op still accepts TCP/UDS
    // connections, so `isSockConnectable` alone adopted it as healthy while it
    // sat wedged holding graph.db open, and a second fork/adoption became a
    // second writer. Health-ping `/health` (from the lock file's healthPort,
    // absent on legacy locks) with retries; only after every attempt fails do
    // we treat it as wedged and kill it exactly like the dead-socket case
    // above.
    const lockData = readProxyLockFile(stateDir);
    if (lockData?.healthPort && !(await pingHealth(lockData.healthPort))) {
      if (isUnerrProxyProcess(pid)) {
        this.onEvent?.(
          "stopped",
          { path: repoPath, pid } as ManagedRepo,
          "wedged proxy (socket connects, /health unresponsive) — killing before respawn"
        );
        await killProcessAndWait(pid);
      }
      clearProxyLockFiles(stateDir);
      return null;
    }

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
      // Adopted external proxy — no IPC handle; terminate by PID if alive AND
      // still a confirmed unerr proxy (never a recycled, unrelated pid).
      if (
        repo.adopted &&
        repo.pid !== null &&
        isProcessAlive(repo.pid) &&
        isUnerrProxyProcess(repo.pid)
      ) {
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
    const handledPids = new Set<number>();

    // 1. Repos this daemon is tracking. A forked child has an IPC handle, so it
    //    gets a graceful { type: "shutdown" } (snapshots + WAL checkpoint on the
    //    way out). An ADOPTED proxy has child === null but a real pid — the old
    //    code skipped it, so `pm stop` killed the daemon and ORPHANED every
    //    adopted proxy. Kill those by pid and wait for a full exit.
    for (const repo of this.repos.values()) {
      if (repo.status === "stopped") continue;
      if (repo.child) {
        shutdowns.push(this.shutdownChild(repo));
        if (repo.pid !== null) handledPids.add(repo.pid);
      } else if (repo.pid !== null && isUnerrProxyProcess(repo.pid)) {
        // Adopted proxy (no IPC handle). Kill by pid, but only once confirmed it
        // is still a unerr proxy — never a recycled, unrelated pid.
        handledPids.add(repo.pid);
        shutdowns.push(killProcessAndWait(repo.pid));
      }
    }

    // 2. Sweep the registry for any live per-repo proxy this daemon never
    //    tracked (an orphan from a prior generation, or a standalone `unerr`).
    //    `pm stop` must leave ZERO repo proxies behind, so terminate those too
    //    by their lock pid, then clear the stale lock files.
    for (const entry of readRegistry().repos) {
      const stateDir = join(entry.path, ".unerr", "state");
      const pid = readProxyLockPid(stateDir);
      if (pid === null || handledPids.has(pid) || !isProcessAlive(pid))
        continue;
      if (!isUnerrProxyProcess(pid)) continue; // recycled/unrelated pid — leave it
      handledPids.add(pid);
      shutdowns.push(
        killProcessAndWait(pid).then(() => clearProxyLockFiles(stateDir))
      );
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

    const child = forkUnerr(["--daemon-child"], {
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

    // Persist the last-known activity to the registry before the in-memory
    // value is lost, so a stopped repo still reports a real last_activity in
    // the fleet inventory (and after a daemon restart).
    if (repo.lastActivity > 0) {
      touchRepoActivity(repoPath, new Date(repo.lastActivity).toISOString());
    }

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

  /**
   * Liveness probe for forked RUNNING proxies. `tryAdopt` only health-checks a
   * proxy the moment something adopts it; a proxy that wedges mid-serve (a cozo
   * op that froze its event loop, the class of freeze the worker-thread db
   * isolation prevents — see cozo-worker-client.ts) keeps its IPC handle AND its
   * bridge connections, so the idle sweep, which skips connected proxies, never
   * touches it and it stays frozen (the pid-47377 case). This /health-pings each
   * such proxy and recycles one that fails {@link LIVENESS_MAX_STRIKES}
   * consecutive probes so its next bridge frame respawns a clean proxy. Pings run
   * in parallel so a wedged proxy's ~3s ping budget never serializes the rest.
   */
  private async probeLiveness(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const candidates: Array<{ repo: ManagedRepo; healthPort: number }> = [];
    for (const repo of this.repos.values()) {
      if (repo.status !== "running") continue;
      // Adopted proxies run their own lifecycle (no IPC handle to shutdownChild).
      if (repo.adopted || !repo.child) continue;
      // A freshly-spawned proxy may not have its health server up yet.
      if (repo.startedAt && now - repo.startedAt < LIVENESS_PROBE_GRACE_MS) {
        continue;
      }
      const lock = readProxyLockFile(join(repo.path, ".unerr", "state"));
      if (typeof lock?.healthPort !== "number") continue;
      candidates.push({ repo, healthPort: lock.healthPort });
    }

    await Promise.all(
      candidates.map(async ({ repo, healthPort }) => {
        const alive = await pingHealth(healthPort);
        const { failures, recycle } = nextLivenessState(
          repo.livenessFailures ?? 0,
          alive
        );
        repo.livenessFailures = failures;
        if (!recycle) return;
        this.onEvent?.(
          "stopped",
          repo,
          `wedged proxy failed ${failures} liveness probes — recycling`
        );
        repo.livenessFailures = 0;
        await this.shutdownChild(repo).catch(() => {
          /* best-effort — probe never breaks the sweep */
        });
      })
    );
  }

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

    // Free-tier single-active convergence: down-scale a running set that was
    // admitted under Pro and then lapsed to free (ensure only blocks NEW
    // starts). Fire-and-forget — a stop failure retries on the next sweep.
    void this.reconcileFreeTier().catch(() => {
      /* best-effort — reconcile never breaks the sweep */
    });

    // Double-writer backstop: clean up any duplicate `--daemon-child` that
    // appeared since the last sweep (a leftover from a prior generation, a
    // double-fork race) within one minute of it surfacing.
    void this.reapDuplicateChildren().catch(() => {
      /* best-effort — reaper never breaks the sweep */
    });

    // Mid-serve wedge backstop: recycle a forked proxy that stopped answering
    // /health (an event-loop freeze the idle path can't see because the proxy is
    // still "connected"). Fire-and-forget — a failure retries next sweep.
    void this.probeLiveness().catch(() => {
      /* best-effort — liveness probe never breaks the sweep */
    });
  }
}
