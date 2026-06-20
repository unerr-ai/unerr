/**
 * The push reporter: a daemon-owned, best-effort loop that drains every repo's
 * local telemetry/sync stores to the cloud. It mirrors the fleet reporter's
 * lifecycle (`start`/`stop`/`runCycle`/backoff) but instead of building one
 * machine report it walks every registered repo, derives its salted id, opens
 * its push cursor, and runs `drainRepo` against the assembled stream drainers.
 *
 * One machine-wide loop with one rate-limiter/backoff (the plan's "write
 * per-repo, drain in unerrd" decision). It never blocks or throws into the
 * daemon — every cycle is guarded, failures back off with jitter, and a
 * logged-out machine skips the whole cycle (no credentials). Telemetry flows on
 * every plan, free included — the only entitlement skip is the explicit
 * `cloud_ingest: false` force-disable. All dependencies are
 * injected so it talks to no module directly and is fully testable offline.
 *
 * @sem domain=infrastructure
 */
import { join } from "node:path";
import { CloudClient } from "../cloud/client.js";
import { assembleDrainers } from "../cloud/drainers/index.js";
import { canPushTelemetry } from "../cloud/entitlements.js";
import { PushCursor } from "../cloud/push-cursor.js";
import {
  type BuildDrainers,
  type DrainOutcome,
  drainRepo,
} from "../cloud/push-drainer.js";
import { deriveRepoId } from "../cloud/repo-identity.js";
import { UNERR_VERSION } from "../version.js";

/** Default cadence between drain ticks when nothing is failing. */
export const DEFAULT_PUSH_INTERVAL_MS = 60_000;
/** Backoff ceiling after repeated machine-wide failures. */
const MAX_BACKOFF_MS = 15 * 60_000;
/** The `source` envelope field every pushed row carries. */
const PUSH_SOURCE = `unerr-cli@${UNERR_VERSION}`;

/** Resolved auth for one drain tick; null means "not logged in". */
export interface PushAuth {
  apiUrl: string;
  token: string;
}

/** Everything the reporter depends on — all injected for testability. */
export interface PushReporterDeps {
  /** Live repo paths from the process manager (one entry per registered repo). */
  getRepos: () => { path: string }[];
  /** Resolve auth, or null when logged out. */
  resolveAuth: () => PushAuth | null;
  /** Telemetry-entitlement check; defaults to {@link canPushTelemetry}. */
  isEntitled?: (now: number) => boolean;
  /** Assemble a repo's stream drainers; defaults to {@link assembleDrainers}. */
  buildDrainers?: BuildDrainers;
  /** Derive a repo's salted id; defaults to {@link deriveRepoId}. */
  deriveRepoId?: (repoPath: string) => Promise<string>;
  /** Map a repo path to its `.unerr` dir; defaults to `<path>/.unerr`. */
  unerrDir?: (repoPath: string) => string;
  /** Build a client for an attempt (defaults to a real CloudClient). */
  makeClient?: (apiUrl: string, token: string) => CloudClient;
  /** Optional structured logger (stderr). */
  log?: (msg: string) => void;
  /** Schedule a callback after a delay; returns a clearable handle. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Jitter factor in [0,1) (defaults to Math.random; injectable for tests). */
  jitter?: () => number;
}

/** A status that means the cloud was reachable but pushed back (slow down). */
function isSoftFailure(status: DrainOutcome["status"]): boolean {
  return (
    status === "network" ||
    status === "rate_limited" ||
    status === "server_error"
  );
}

/**
 * Drives the telemetry drain loop for one daemon. Construct once, `start()` on
 * boot, `stop()` on shutdown. Each tick drains every repo; a machine-wide
 * backoff slows the whole loop when the cloud is unreachable or rate-limiting.
 *
 * @sem domain=infrastructure
 */
export class PushReporter {
  private readonly deps: Required<
    Pick<
      PushReporterDeps,
      | "isEntitled"
      | "buildDrainers"
      | "deriveRepoId"
      | "unerrDir"
      | "makeClient"
      | "setTimer"
      | "clearTimer"
      | "jitter"
    >
  > &
    PushReporterDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;

  constructor(deps: PushReporterDeps) {
    this.deps = {
      ...deps,
      isEntitled: deps.isEntitled ?? canPushTelemetry,
      buildDrainers: deps.buildDrainers ?? assembleDrainers,
      deriveRepoId: deps.deriveRepoId ?? deriveRepoId,
      unerrDir: deps.unerrDir ?? ((p) => join(p, ".unerr")),
      makeClient:
        deps.makeClient ??
        ((apiUrl, token) => new CloudClient({ apiUrl, token })),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref()),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h)),
      jitter: deps.jitter ?? Math.random,
    };
  }

  /** Begin draining: run a tick now, then loop on the default cadence. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runCycle();
  }

  /** Stop the loop. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** One drain tick across every repo. Never throws; schedules the next tick. */
  async runCycle(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    let nextDelay = DEFAULT_PUSH_INTERVAL_MS;
    try {
      const soft = await this.drainAll();
      if (soft) {
        this.failures += 1;
        nextDelay = this.backoffDelay();
      } else {
        this.failures = 0;
      }
    } catch (err) {
      // Best-effort: a failure never propagates; just back off.
      this.failures += 1;
      nextDelay = this.backoffDelay();
      this.deps.log?.(
        `push: cycle failed (attempt ${this.failures}), retrying in ${Math.round(
          nextDelay / 1000
        )}s: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.inFlight = false;
      if (this.running) this.scheduleNext(nextDelay);
    }
  }

  /**
   * Drain every repo once. Returns true if any repo hit a soft failure (network
   * / rate-limit / 5xx) so the caller backs the whole loop off. Skips silently
   * when logged out or not entitled (B5) — that is not a failure.
   */
  private async drainAll(): Promise<boolean> {
    const now = Date.now();
    if (!this.deps.isEntitled(now)) return false;
    const auth = this.deps.resolveAuth();
    if (!auth) return false;

    const client = this.deps.makeClient(auth.apiUrl, auth.token);
    let soft = false;
    for (const repo of this.deps.getRepos()) {
      if (!this.running) break;
      soft = (await this.drainOneRepo(repo.path, client)) || soft;
    }
    return soft;
  }

  /**
   * Drain one repo's streams immediately, outside the tick loop. Called right
   * before a repo is deregistered so its final rows — notably the `removed`
   * repo_activity event — ship before the repo drops out of the rotation and is
   * never ticked again. No-op when logged out or not entitled (the rows stay
   * spooled). Never throws. A concurrent main-loop drain of the same repo is
   * safe: every row's event_id is deterministic, so the server dedups any
   * overlap.
   */
  async drainRepoNow(repoPath: string): Promise<void> {
    try {
      if (!this.deps.isEntitled(Date.now())) return;
      const auth = this.deps.resolveAuth();
      if (!auth) return;
      const client = this.deps.makeClient(auth.apiUrl, auth.token);
      await this.drainOneRepo(repoPath, client);
    } catch {
      /* best-effort final drain — never blocks removal */
    }
  }

  /** Drain one repo's streams; returns true on a soft (retryable) failure. */
  private async drainOneRepo(
    repoPath: string,
    client: CloudClient
  ): Promise<boolean> {
    const unerrDir = this.deps.unerrDir(repoPath);
    let set: Awaited<ReturnType<BuildDrainers>> | null = null;
    try {
      const repoId = await this.deps.deriveRepoId(repoPath);
      const cursor = await PushCursor.open(unerrDir);
      set = await this.deps.buildDrainers({
        repoPath,
        unerrDir,
        repoId,
        client,
        source: PUSH_SOURCE,
        log: this.deps.log,
      });
      if (set.drainers.length === 0) return false;

      const outcomes = await drainRepo(cursor, set.drainers, {
        isEntitled: this.deps.isEntitled,
        log: this.deps.log,
      });
      await cursor.save();

      const pushed = outcomes.reduce((n, o) => n + o.pushed, 0);
      const parked = outcomes.reduce((n, o) => n + o.parked, 0);
      const dead = outcomes.reduce((n, o) => n + o.deadLettered, 0);
      if (pushed > 0 || parked > 0 || dead > 0) {
        this.deps.log?.(
          `push: ${repoPath} drained ${pushed} row(s)${parked > 0 ? `, ${parked} parked` : ""}${dead > 0 ? `, ${dead} dead-lettered` : ""}`
        );
      }
      return outcomes.some((o) => isSoftFailure(o.status));
    } catch (err) {
      // A per-repo failure (corrupt store, missing dir) never sinks the tick.
      this.deps.log?.(
        `push: ${repoPath} drain failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return true;
    } finally {
      await set?.dispose?.();
    }
  }

  /** Schedule the next tick. */
  private scheduleNext(delayMs: number): void {
    if (this.timer) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => void this.runCycle(), delayMs);
  }

  /** Exponential backoff with ±15% jitter, capped. */
  private backoffDelay(): number {
    const base = Math.min(
      DEFAULT_PUSH_INTERVAL_MS * 2 ** (this.failures - 1),
      MAX_BACKOFF_MS
    );
    const jitter = 0.85 + this.deps.jitter() * 0.3;
    return Math.round(base * jitter);
  }
}
