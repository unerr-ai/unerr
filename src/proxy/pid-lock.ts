/**
 * PID Lock — single-instance enforcement for the proxy.
 *
 * PID file format (JSON): { pid, startedAt, healthPort }
 * Health check HTTP endpoint on random high port for stale detection.
 * Heartbeat every 10s. Backward-compatible with plain PID format.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server as HttpServer, createServer } from "node:http";
import { join } from "node:path";

const HEARTBEAT_INTERVAL_MS = 10_000;
const PID_FILENAME = "proxy.pid";
const HEALTH_CHECK_TIMEOUT_MS = 500;
/** Growing per-attempt timeout for `checkHealthWithRetry` — a proxy pegged on
 * a synchronous CozoDB op (WAL checkpoint, index burst) can miss one 500ms
 * check without being wedged. */
const HEALTH_RETRY_TIMEOUTS_MS = [500, 1000, 1500];
const HEALTH_RETRY_GAP_MS = 200;

export interface PidFileData {
  pid: number;
  startedAt: string;
  healthPort: number;
}

export type PidLockOutcome =
  | "primary"
  | "secondary"
  | "stale_recovered"
  | "wedged";

export interface PidLockResult {
  acquired: boolean;
  outcome: PidLockOutcome;
  /** PID of existing process if lock not acquired */
  existingPid?: number;
  /** Health port of existing proxy (if secondary) */
  existingHealthPort?: number;
  /** Health port of this proxy (if primary) */
  healthPort?: number;
}

export class PidLock {
  private pidPath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthServer: HttpServer | null = null;
  private healthPort = 0;
  private startedAt = "";
  private toolCalls = 0;
  private mode = "full";

  constructor(unerrStateDir: string) {
    this.pidPath = join(unerrStateDir, PID_FILENAME);
  }

  /**
   * Set the current operating mode (for health endpoint).
   */
  setMode(mode: string): void {
    this.mode = mode;
  }

  /**
   * Increment tool call counter (for health endpoint).
   */
  recordToolCall(): void {
    this.toolCalls++;
  }

  /**
   * Get the health port (for external discovery).
   */
  getHealthPort(): number {
    return this.healthPort;
  }

  /**
   * Attempt to acquire the PID lock.
   * Returns outcome: primary (we're the proxy), secondary (another is running), stale_recovered.
   */
  async acquire(): Promise<PidLockResult> {
    const stateDir = join(this.pidPath, "..");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    // Check existing PID
    if (existsSync(this.pidPath)) {
      try {
        const raw = readFileSync(this.pidPath, "utf-8").trim();
        const pidData = parsePidFile(raw);

        if (pidData && isProcessAlive(pidData.pid)) {
          // Process is alive — verify it's really unerr via health check
          if (pidData.healthPort) {
            const healthy = await checkHealthWithRetry(pidData.healthPort);
            if (healthy) {
              return {
                acquired: false,
                outcome: "secondary",
                existingPid: pidData.pid,
                existingHealthPort: pidData.healthPort,
              };
            }
            // Health check failed after retries. Two very different causes:
            // the pid was recycled onto an unrelated process (genuinely
            // stale — safe to reclaim), or it's still a real unerr proxy
            // that's wedged (busy/pegged, event loop blocked) and still
            // holds graph.db — becoming a second writer here is the WAL-bloat
            // incident. Disambiguate by process identity before deciding.
            if (isUnerrProxyPid(pidData.pid)) {
              return {
                acquired: false,
                outcome: "wedged",
                existingPid: pidData.pid,
                existingHealthPort: pidData.healthPort,
              };
            }
            unlinkSync(this.pidPath);
            return await this.becomePrimary("stale_recovered");
          }
          // No health port (legacy format) → assume real proxy
          return {
            acquired: false,
            outcome: "secondary",
            existingPid: pidData.pid,
          };
        }
        // Stale — clean up
        unlinkSync(this.pidPath);
        return await this.becomePrimary("stale_recovered");
      } catch {
        // Corrupt PID file — remove it
        try {
          unlinkSync(this.pidPath);
        } catch {
          /* ignore */
        }
      }
    }

    return await this.becomePrimary("primary");
  }

  private async becomePrimary(outcome: PidLockOutcome): Promise<PidLockResult> {
    // Start health server on random port
    await this.startHealthServer();

    this.startedAt = new Date().toISOString();

    // Write JSON PID file
    this.writePidFile();

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      try {
        this.writePidFile();
      } catch {
        // PID file disappeared — directory might be deleted
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }

    // Cleanup on exit (crash recovery)
    process.on("exit", () => {
      try {
        unlinkSync(this.pidPath);
      } catch {
        /* ignore */
      }
    });

    return { acquired: true, outcome, healthPort: this.healthPort };
  }

  private writePidFile(): void {
    const data: PidFileData = {
      pid: process.pid,
      startedAt: this.startedAt,
      healthPort: this.healthPort,
    };
    writeFileSync(this.pidPath, JSON.stringify(data), "utf-8");
  }

  private async startHealthServer(): Promise<void> {
    return new Promise((resolve) => {
      this.healthServer = createServer((req, res) => {
        if (req.url === "/health" && req.method === "GET") {
          const uptimeS = Math.round(
            (Date.now() - new Date(this.startedAt).getTime()) / 1000
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              uptime_s: uptimeS,
              tool_calls: this.toolCalls,
              mode: this.mode,
              pid: process.pid,
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      // Listen on random port (0 = OS assigns)
      this.healthServer.listen(0, "127.0.0.1", () => {
        const addr = this.healthServer?.address();
        this.healthPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });

      this.healthServer.unref();
    });
  }

  /**
   * Release the PID lock, stop heartbeat, and close health server.
   */
  release(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }
    try {
      if (existsSync(this.pidPath)) {
        const raw = readFileSync(this.pidPath, "utf-8").trim();
        const data = parsePidFile(raw);
        if (data && data.pid === process.pid) {
          unlinkSync(this.pidPath);
        }
      }
    } catch {
      // Best effort cleanup
    }
  }

  /**
   * Check if a proxy is currently running (for external callers).
   */
  isLocked(): { locked: boolean; pid?: number; healthPort?: number } {
    if (!existsSync(this.pidPath)) return { locked: false };
    try {
      const raw = readFileSync(this.pidPath, "utf-8").trim();
      const data = parsePidFile(raw);
      if (data && isProcessAlive(data.pid)) {
        return { locked: true, pid: data.pid, healthPort: data.healthPort };
      }
      return { locked: false };
    } catch {
      return { locked: false };
    }
  }

  /**
   * Non-destructive probe: check if proxy is alive without acquiring the lock.
   * Uses health check for full verification (unlike isLocked() which is sync-only).
   */
  async probe(): Promise<{
    alive: boolean;
    pid?: number;
    healthPort?: number;
  }> {
    if (!existsSync(this.pidPath)) return { alive: false };

    try {
      const raw = readFileSync(this.pidPath, "utf-8").trim();
      const pidData = parsePidFile(raw);
      if (!pidData || !isProcessAlive(pidData.pid)) return { alive: false };

      if (pidData.healthPort) {
        const healthy = await checkHealth(pidData.healthPort);
        if (!healthy) return { alive: false };
      }

      return { alive: true, pid: pidData.pid, healthPort: pidData.healthPort };
    } catch {
      return { alive: false };
    }
  }

  /**
   * Read the PID file data (for external callers like --mcp bridge).
   */
  static readPidFile(stateDir: string): PidFileData | null {
    const pidPath = join(stateDir, PID_FILENAME);
    if (!existsSync(pidPath)) return null;
    try {
      const raw = readFileSync(pidPath, "utf-8").trim();
      const data = parsePidFile(raw);
      if (data && isProcessAlive(data.pid)) return data;
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Parse PID file — handles both JSON format and legacy plain number.
 */
function parsePidFile(raw: string): PidFileData | null {
  // Try JSON first
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw) as PidFileData;
      if (typeof data.pid === "number" && !Number.isNaN(data.pid)) {
        return data;
      }
    } catch {
      /* fall through */
    }
  }

  // Legacy: plain PID number
  const pid = Number.parseInt(raw, 10);
  if (!Number.isNaN(pid)) {
    return { pid, startedAt: "", healthPort: 0 };
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a health endpoint is responding (used for stale PID verification).
 */
async function checkHealth(
  port: number,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Retry the health check with growing per-attempt timeouts before concluding
 * a proxy is unresponsive. A single 500ms check can miss a proxy that is
 * briefly busy (a WAL checkpoint or index burst) without being wedged —
 * retrying avoids misclassifying it as dead.
 */
async function checkHealthWithRetry(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_RETRY_TIMEOUTS_MS.length; i++) {
    if (await checkHealth(port, HEALTH_RETRY_TIMEOUTS_MS[i])) return true;
    if (i < HEALTH_RETRY_TIMEOUTS_MS.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_GAP_MS));
    }
  }
  return false;
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
 * src/daemon/process-manager.ts; pid-lock.ts is a low-level proxy module and
 * must not import from src/daemon, so the check is duplicated here rather
 * than shared.
 */
export function isUnerrProxyCommand(cmd: string): boolean {
  if (!/cli\.js(\s|$)/.test(cmd) && !/\/unerr(\s|$)/.test(cmd)) return false;
  if (/\bunerrd\b/.test(cmd)) return false;
  if (/(^|\s)--mcp(\s|$)/.test(cmd)) return false;
  if (/(^|\s)exec(\s|$)/.test(cmd)) return false;
  return true;
}

/**
 * Confirm a pid read from the proxy lock file is genuinely a unerr proxy
 * (managed or standalone) before treating a failed health check as "wedged,
 * don't reclaim" rather than "recycled, safe to reclaim". Any failure to
 * verify returns false (treated as recycled, not wedged).
 */
function isUnerrProxyPid(pid: number): boolean {
  if (process.platform === "win32") {
    // No portable `ps`; fall back to today's recycled-pid behavior.
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
    return false;
  }
}
