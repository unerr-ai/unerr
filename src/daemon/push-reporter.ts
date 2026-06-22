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
import {
  reapDrainedDeadSegments,
  truncateDrainedLongLivedSegments,
} from "../cloud/drainers/ingest.js";
import { canPushTelemetry } from "../cloud/entitlements.js";
import { PushCursor } from "../cloud/push-cursor.js";
import {
  type BuildDrainers,
  type DrainOutcome,
  drainRepo,
} from "../cloud/push-drainer.js";
import { deriveRepoId } from "../cloud/repo-identity.js";
import { machineEventsRoot } from "../events/event-store.js";
import { getCurrentBranch, getHeadSha } from "../utils/git.js";
import { UNERR_VERSION } from "../version.js";

/**
 * Cadence between drain ticks. The drain is timer-driven only — producers append
 * events to local disk segments (the queue) and never block on the network; the
 * daemon coalesces each repo's pending events into the fewest combined POSTs once
 * per tick. 10s batches keep the cloud near-live without per-event request storms.
 */
export const DEFAULT_PUSH_INTERVAL_MS = 10_000;
/** First retry delay after a soft failure; doubles each repeat up to the cap. */
const BACKOFF_BASE_MS = 10_000;
/** Backoff ceiling after repeated machine-wide failures (L4: ~5 min). */
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * Cadence for the transcript materializer — slower than the 10s drain tick. The
 * heavy streaming read runs at most this often per repo; the per-file settle
 * gate (QUIET_MS) does the rest, leaning into the 5–60 min gap between sessions.
 */
const TRANSCRIPT_MATERIALIZE_INTERVAL_MS = 60_000;
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
  /** Resolve the machine-level events root (defaults to {@link machineEventsRoot}). */
  machineEventsRoot?: () => string;
  /** Materialize a repo's claimed transcripts (claim-check consumer) just before
   *  its drain, returning the number of turns enqueued. Injected so the daemon
   *  layer never imports `src/tracking/` (daemon-isolation guard). Defaults to a
   *  no-op; the daemon entrypoint wires the real implementation. */
  materializeClaims?: (opts: {
    repoCwd: string;
    unerrDir: string;
    now: number;
    log?: (msg: string) => void;
  }) => Promise<number>;
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
      | "machineEventsRoot"
      | "materializeClaims"
    >
  > &
    PushReporterDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;
  /** Last time the transcript materializer ran for a repo, so it runs on the
   *  slower {@link TRANSCRIPT_MATERIALIZE_INTERVAL_MS} cadence, not every tick. */
  private lastTranscriptTickByRepo = new Map<string, number>();

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
      machineEventsRoot: deps.machineEventsRoot ?? machineEventsRoot,
      materializeClaims: deps.materializeClaims ?? (async () => 0),
    };
  }

  /**
   * Begin draining: run a tick now, then loop on the {@link DEFAULT_PUSH_INTERVAL_MS}
   * cadence. The timer is the sole drain trigger — producers append to local disk
   * segments and never push, so a fixed ~10s batch coalesces all pending events.
   */
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
    // The machine-level fleet store rides the same loop as a pseudo-repo.
    if (this.running) soft = (await this.drainMachine(client)) || soft;
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
      // Materialize claimed transcripts BEFORE listing segments, so the rows
      // this enqueues to the `transcript` segment drain in the same tick. Runs
      // on the slower transcript cadence; the per-file settle gate bounds the
      // actual heavy read. Never throws (guarded internally).
      const tnow = Date.now();
      if (
        tnow - (this.lastTranscriptTickByRepo.get(repoPath) ?? 0) >=
        TRANSCRIPT_MATERIALIZE_INTERVAL_MS
      ) {
        this.lastTranscriptTickByRepo.set(repoPath, tnow);
        await this.deps.materializeClaims({
          repoCwd: repoPath,
          unerrDir,
          now: tnow,
          log: this.deps.log,
        });
      }

      const repoId = await this.deps.deriveRepoId(repoPath);
      const cursor = await PushCursor.open(unerrDir);
      // Resolve the repo's current branch + HEAD once per tick so every stream
      // whose source rows carry no per-row VCS (events/router/timeline) can
      // stamp `where` context. Best-effort: a non-git repo or a git failure
      // leaves both undefined and the drainers simply omit the fields.
      const [branch, commit] = await Promise.all([
        getCurrentBranch(repoPath).catch(() => null),
        getHeadSha(repoPath).catch(() => null),
      ]);
      set = await this.deps.buildDrainers({
        repoPath,
        unerrDir,
        repoId,
        client,
        source: PUSH_SOURCE,
        branch: branch ?? undefined,
        commit: commit ?? undefined,
        log: this.deps.log,
      });
      if (set.drainers.length === 0) return false;

      const outcomes = await drainRepo(cursor, set.drainers, {
        isEntitled: this.deps.isEntitled,
        log: this.deps.log,
        // Coalesce every segment stream into the fewest combined POSTs per tick.
        pushCombined: set.pushCombined,
      });
      // Reap fully-drained per-pid segments of dead processes before saving, so
      // the cursor-forget rides the same write. Bounds the segment-file count.
      reapDrainedDeadSegments(repoPath, cursor);
      // Empty fully-drained long-lived segments (proxy/transcript) so sent
      // telemetry does not linger on disk until the 5-day age-out.
      truncateDrainedLongLivedSegments(repoPath, cursor);
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

  /**
   * Drain the machine-level fleet store (`~/.unerr/events/`) — the
   * `machine_inventory` / `machine_checkin` segment the fleet reporter appends
   * to. Machine-level, so it carries no salted repo id and no VCS context:
   * `repoId:""` makes the drainer stamp no `repo`, and fleet rows skip the HR-2
   * sanitizer (their absolute `path` is legitimate). Returns true on a soft
   * (retryable) failure. Never throws.
   */
  private async drainMachine(client: CloudClient): Promise<boolean> {
    const root = this.deps.machineEventsRoot();
    const unerrDir = join(root, ".unerr");
    let set: Awaited<ReturnType<BuildDrainers>> | null = null;
    try {
      const cursor = await PushCursor.open(unerrDir);
      set = await this.deps.buildDrainers({
        repoPath: root,
        unerrDir,
        repoId: "",
        client,
        source: PUSH_SOURCE,
        log: this.deps.log,
      });
      if (set.drainers.length === 0) return false;

      const outcomes = await drainRepo(cursor, set.drainers, {
        isEntitled: this.deps.isEntitled,
        log: this.deps.log,
        // Coalesce every segment stream into the fewest combined POSTs per tick.
        pushCombined: set.pushCombined,
      });
      reapDrainedDeadSegments(root, cursor);
      // Empty the fully-drained machine fleet segment so it does not grow forever.
      truncateDrainedLongLivedSegments(root, cursor);
      await cursor.save();

      const pushed = outcomes.reduce((n, o) => n + o.pushed, 0);
      const parked = outcomes.reduce((n, o) => n + o.parked, 0);
      const dead = outcomes.reduce((n, o) => n + o.deadLettered, 0);
      if (pushed > 0 || parked > 0 || dead > 0) {
        this.deps.log?.(
          `push: fleet drained ${pushed} row(s)${parked > 0 ? `, ${parked} parked` : ""}${dead > 0 ? `, ${dead} dead-lettered` : ""}`
        );
      }
      return outcomes.some((o) => isSoftFailure(o.status));
    } catch (err) {
      this.deps.log?.(
        `push: fleet drain failed: ${err instanceof Error ? err.message : String(err)}`
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
      BACKOFF_BASE_MS * 2 ** (this.failures - 1),
      MAX_BACKOFF_MS
    );
    const jitter = 0.85 + this.deps.jitter() * 0.3;
    return Math.round(base * jitter);
  }
}
