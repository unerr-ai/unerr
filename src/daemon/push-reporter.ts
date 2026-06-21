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
import { watch } from "node:fs";
import { join } from "node:path";
import { CloudClient } from "../cloud/client.js";
import { assembleDrainers } from "../cloud/drainers/index.js";
import { reapDrainedDeadSegments } from "../cloud/drainers/ingest.js";
import { canPushTelemetry } from "../cloud/entitlements.js";
import { PushCursor } from "../cloud/push-cursor.js";
import {
  type BuildDrainers,
  type DrainOutcome,
  drainRepo,
} from "../cloud/push-drainer.js";
import { deriveRepoId } from "../cloud/repo-identity.js";
import {
  ensureEventsDir,
  eventsDir,
  machineEventsRoot,
} from "../events/event-store.js";
import { getCurrentBranch, getHeadSha } from "../utils/git.js";
import { UNERR_VERSION } from "../version.js";

/** Default cadence between drain ticks when nothing is failing. */
export const DEFAULT_PUSH_INTERVAL_MS = 60_000;
/** First retry delay after a soft failure; doubles each repeat up to the cap. */
const BACKOFF_BASE_MS = 10_000;
/** Backoff ceiling after repeated machine-wide failures (L4: ~5 min). */
const MAX_BACKOFF_MS = 5 * 60_000;
/** The `source` envelope field every pushed row carries. */
const PUSH_SOURCE = `unerr-cli@${UNERR_VERSION}`;
/** Debounce a burst of segment appends into one push-ASAP drain (L3, ≤1s). */
export const WATCH_DEBOUNCE_MS = 1_000;
/** Watcher key for the machine-level fleet store (`~/.unerr/events/`). A real
 *  repo path is absolute, so this sentinel can never collide with one. */
const MACHINE_KEY = "__machine__";

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
  /**
   * Watch one directory for changes; returns a closable handle. Defaults to a
   * non-persistent `fs.watch` (won't keep the daemon alive). Injected so a test
   * can fire the change callback synchronously instead of touching the FS.
   */
  watchDir?: (dir: string, onChange: () => void) => { close: () => void };
  /** Resolve the machine-level events root (defaults to {@link machineEventsRoot}). */
  machineEventsRoot?: () => string;
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
      | "watchDir"
      | "machineEventsRoot"
    >
  > &
    PushReporterDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;
  /** Live event-dir watchers, keyed by repo path (+ {@link MACHINE_KEY}). */
  private readonly watchers = new Map<string, { close: () => void }>();
  /** Pending per-target debounce timers (a burst → one drain). */
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  /** Targets with a wakeup drain in flight — collapses overlapping wakeups. */
  private readonly drainingNow = new Set<string>();

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
      watchDir:
        deps.watchDir ??
        ((dir, onChange) => {
          const w = watch(dir, { persistent: false }, () => onChange());
          return {
            close: () => {
              try {
                w.close();
              } catch {
                /* already closed / dir gone */
              }
            },
          };
        }),
      machineEventsRoot: deps.machineEventsRoot ?? machineEventsRoot,
    };
  }

  /**
   * Begin draining: attach event-dir watchers (push-ASAP), run a tick now, then
   * loop on the slow backstop cadence. The watchers — not the timer — are the
   * primary drain trigger; the timer only backstops missed events + L4 parking.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.syncWatchers();
    void this.runCycle();
  }

  /** Stop the loop + every watcher. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.debounceTimers.values()) this.deps.clearTimer(t);
    this.debounceTimers.clear();
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

    // Reconcile watchers each tick so a repo added/removed without a proxy
    // start/stop event still gains/loses its watcher within one backstop cycle.
    this.syncWatchers();

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
      });
      // Reap fully-drained per-pid segments of dead processes before saving, so
      // the cursor-forget rides the same write. Bounds the segment-file count.
      reapDrainedDeadSegments(repoPath, cursor);
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
   * Attach an event-dir watcher to every live repo plus the machine-level fleet
   * store, and detach watchers for repos that went away. A segment append wakes
   * a debounced drain of that one target within {@link WATCH_DEBOUNCE_MS} —
   * push-ASAP, no busy poll. Idempotent: call on start, on the daemon's proxy
   * start/stop events, and once per backstop tick. No-op when stopped.
   */
  syncWatchers(): void {
    if (!this.running) return;
    const desired = new Map<string, string>();
    for (const repo of this.deps.getRepos()) desired.set(repo.path, repo.path);
    desired.set(MACHINE_KEY, this.deps.machineEventsRoot());

    for (const [key, root] of desired) {
      if (this.watchers.has(key)) continue;
      try {
        ensureEventsDir(root);
        const handle = this.deps.watchDir(eventsDir(root), () =>
          this.onSegmentChange(key)
        );
        this.watchers.set(key, handle);
      } catch (err) {
        this.deps.log?.(
          `push: watch ${root} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    for (const key of [...this.watchers.keys()]) {
      if (desired.has(key)) continue;
      this.watchers.get(key)?.close();
      this.watchers.delete(key);
      const pending = this.debounceTimers.get(key);
      if (pending) {
        this.deps.clearTimer(pending);
        this.debounceTimers.delete(key);
      }
    }
  }

  /** A segment write fired — debounce, then drain just that target ASAP. */
  private onSegmentChange(key: string): void {
    if (!this.running) return;
    const existing = this.debounceTimers.get(key);
    if (existing) this.deps.clearTimer(existing);
    this.debounceTimers.set(
      key,
      this.deps.setTimer(() => {
        this.debounceTimers.delete(key);
        void this.drainTargetNow(key);
      }, WATCH_DEBOUNCE_MS)
    );
  }

  /**
   * Drain one woken target — a repo path, or {@link MACHINE_KEY} for the fleet
   * store — outside the tick loop. A per-target in-flight guard collapses
   * overlapping wakeups; a concurrent backstop drain of the same target is still
   * safe (deterministic event_ids → server dedup). Skips silently when logged
   * out / not entitled. Never throws.
   */
  private async drainTargetNow(key: string): Promise<void> {
    if (this.drainingNow.has(key)) return;
    this.drainingNow.add(key);
    try {
      if (!this.deps.isEntitled(Date.now())) return;
      const auth = this.deps.resolveAuth();
      if (!auth) return;
      const client = this.deps.makeClient(auth.apiUrl, auth.token);
      if (key === MACHINE_KEY) await this.drainMachine(client);
      else await this.drainOneRepo(key, client);
    } catch {
      /* best-effort — a wakeup drain never blocks the daemon */
    } finally {
      this.drainingNow.delete(key);
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
      });
      reapDrainedDeadSegments(root, cursor);
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
