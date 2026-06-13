/**
 * The fleet reporter: a daemon-owned, best-effort loop that ships the heartbeat
 * (fast cadence) and full inventory (on events + slow cadence) to the cloud. It
 * never blocks or throws into the daemon — every cycle is guarded, failures back
 * off with jitter, and the latest report always supersedes a failed one (so no
 * queue of stale payloads is kept). All dependencies are injected, so it talks
 * to no module directly and is fully testable offline.
 *
 * @sem domain=infrastructure
 */
import type { CloudResult } from "../cloud/client.js";
import {
  type CheckinResponse,
  CloudClient,
  type InventoryAck,
} from "../cloud/client.js";
import { buildFleetReport, buildHeartbeatReport } from "./fleet-inventory.js";
import type { RepoStatusEntry } from "./protocol.js";

/** Default fast cadence between heartbeats when the server gives no override. */
export const DEFAULT_CHECKIN_INTERVAL_MS = 5 * 60_000;
/** Floor/ceiling clamps on a server-driven cadence (defensive). */
const MIN_CHECKIN_INTERVAL_MS = 30_000;
const MAX_CHECKIN_INTERVAL_MS = 60 * 60_000;
/** Send a full inventory in place of a heartbeat every Nth cycle (self-heal). */
const INVENTORY_EVERY_N_CHECKINS = 6;
/** Coalesce a burst of events into one inventory push. */
const EVENT_DEBOUNCE_MS = 2_000;
/** Backoff ceiling after repeated failures. */
const MAX_BACKOFF_MS = 15 * 60_000;

/** Resolved auth for one report attempt; null means "not logged in". */
export interface FleetAuth {
  apiUrl: string;
  token: string;
  machineId: string;
}

/** Minimal client surface the reporter needs (test seam). */
export interface FleetClient {
  postCheckin(
    beat: Parameters<CloudClient["postCheckin"]>[0]
  ): Promise<CloudResult<CheckinResponse>>;
  putInventory(
    report: Parameters<CloudClient["putInventory"]>[0]
  ): Promise<CloudResult<InventoryAck>>;
}

/** Everything the reporter depends on — all injected for testability. */
export interface FleetReporterDeps {
  /** Live per-repo status from the process manager. */
  getStatusEntries: () => RepoStatusEntry[];
  /** Resolve auth, or null when logged out. */
  resolveAuth: () => FleetAuth | null;
  /** The actually-bound dashboard port. */
  dashboardPort: () => number;
  /** Optional structured logger (stderr). */
  log?: (msg: string) => void;
  /** Build a client for an attempt (defaults to a real CloudClient). */
  makeClient?: (apiUrl: string, token: string) => FleetClient;
  /** Schedule a callback after a delay; returns a clearable handle. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Jitter factor in [0,1) (defaults to Math.random; injectable for tests). */
  jitter?: () => number;
}

/**
 * Drives the heartbeat/inventory loop for one daemon. Construct once, `start()`
 * on boot, `notifyEvent()` on repo/proxy changes, `stop()` on shutdown.
 *
 * @sem domain=infrastructure
 */
export class FleetReporter {
  private readonly deps: Required<
    Pick<FleetReporterDeps, "makeClient" | "setTimer" | "clearTimer" | "jitter">
  > &
    FleetReporterDeps;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private checkinCount = 0;
  private failures = 0;

  constructor(deps: FleetReporterDeps) {
    this.deps = {
      ...deps,
      makeClient:
        deps.makeClient ??
        ((apiUrl, token) => new CloudClient({ apiUrl, token })),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref()),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h)),
      jitter: deps.jitter ?? Math.random,
    };
  }

  /** Begin reporting: push a full inventory now, then loop heartbeats. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runCycle(true);
  }

  /** Stop all timers. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.debounce) {
      this.deps.clearTimer(this.debounce);
      this.debounce = null;
    }
  }

  /**
   * Signal a fleet-changing event (repo add/remove, proxy start/stop). Coalesces
   * a burst into a single full-inventory push.
   */
  notifyEvent(reason: string): void {
    if (!this.running) return;
    if (this.debounce) this.deps.clearTimer(this.debounce);
    this.debounce = this.deps.setTimer(() => {
      this.debounce = null;
      void this.runCycle(true, reason);
    }, EVENT_DEBOUNCE_MS);
  }

  /** One report attempt. `forceInventory` sends the full snapshot. */
  private async runCycle(
    forceInventory: boolean,
    reason?: string
  ): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    let nextDelay = DEFAULT_CHECKIN_INTERVAL_MS;
    try {
      nextDelay = await this.report(forceInventory, reason);
      this.failures = 0;
    } catch (err) {
      // Best-effort: a failure never propagates; just back off.
      this.failures += 1;
      nextDelay = this.backoffDelay();
      this.deps.log?.(
        `fleet: report failed (attempt ${this.failures}), retrying in ${Math.round(
          nextDelay / 1000
        )}s: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.inFlight = false;
      if (this.running) this.scheduleNext(nextDelay);
    }
  }

  /**
   * Build + send one report. Returns the delay until the next cycle. Skips
   * silently (default delay) when logged out — never an error.
   */
  private async report(
    forceInventory: boolean,
    reason?: string
  ): Promise<number> {
    const auth = this.deps.resolveAuth();
    if (!auth) return DEFAULT_CHECKIN_INTERVAL_MS;

    const inputs = {
      statusEntries: this.deps.getStatusEntries(),
      dashboardPort: this.deps.dashboardPort(),
    };
    const client = this.deps.makeClient(auth.apiUrl, auth.token);

    this.checkinCount += 1;
    const sendInventory =
      forceInventory || this.checkinCount % INVENTORY_EVERY_N_CHECKINS === 0;

    if (sendInventory) {
      const report = await buildFleetReport(inputs);
      if (!report) return DEFAULT_CHECKIN_INTERVAL_MS;
      const res = await client.putInventory(report);
      if (!res.ok)
        throw new Error(res.error?.message ?? `inventory ${res.status}`);
      if (reason) this.deps.log?.(`fleet: inventory pushed (${reason})`);
      return DEFAULT_CHECKIN_INTERVAL_MS;
    }

    const beat = buildHeartbeatReport(inputs);
    if (!beat) return DEFAULT_CHECKIN_INTERVAL_MS;
    const res = await client.postCheckin(beat);
    if (!res.ok) throw new Error(res.error?.message ?? `checkin ${res.status}`);
    return this.clampInterval(res.data?.next_checkin_after_seconds);
  }

  /** Schedule the next cycle (always a heartbeat unless the Nth/forced). */
  private scheduleNext(delayMs: number): void {
    if (this.timer) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => void this.runCycle(false), delayMs);
  }

  /** Apply a server-driven cadence (seconds), clamped, or the default. */
  private clampInterval(seconds?: number): number {
    if (seconds === undefined || !Number.isFinite(seconds)) {
      return DEFAULT_CHECKIN_INTERVAL_MS;
    }
    const ms = seconds * 1000;
    return Math.min(
      Math.max(ms, MIN_CHECKIN_INTERVAL_MS),
      MAX_CHECKIN_INTERVAL_MS
    );
  }

  /** Exponential backoff with ±15% jitter, capped. */
  private backoffDelay(): number {
    const base = Math.min(
      DEFAULT_CHECKIN_INTERVAL_MS * 2 ** (this.failures - 1),
      MAX_BACKOFF_MS
    );
    const jitter = 0.85 + this.deps.jitter() * 0.3;
    return Math.round(base * jitter);
  }
}
