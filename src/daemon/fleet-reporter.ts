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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MachineCheckinEvent,
  MachineInventoryEvent,
} from "@unerr-ai/contracts/fleet";
import { validateBody } from "../cloud/drainers/validate.js";
import { type EmitContext, stampEvent } from "../events/enqueue.js";
import {
  FLEET_SEGMENT,
  type StoredEvent,
  appendEvent,
  machineEventsRoot,
} from "../events/event-store.js";
import { UNERR_VERSION } from "../version.js";
import {
  type InventoryDetail,
  buildFleetReport,
  buildHeartbeatReport,
} from "./fleet-inventory.js";
import type { RepoStatusEntry } from "./protocol.js";
import { globalDir } from "./registry.js";

/** The `source` envelope field every stamped fleet event carries. */
const FLEET_SOURCE = `unerr-cli@${UNERR_VERSION}`;

/** Stamp context for fleet events: machine-level, so they ride the machine
 *  segment store (`~/.unerr/events/fleet.jsonl`) rather than a per-repo file.
 *  The daemon drains this segment exactly as it drains each repo; the machine is
 *  resolved from the token server-side, never the body. */
const FLEET_CTX: EmitContext = {
  repoRoot: machineEventsRoot(),
  segment: FLEET_SEGMENT,
  source: FLEET_SOURCE,
};

/** Idle liveness cadence between heartbeats. */
export const DEFAULT_CHECKIN_INTERVAL_MS = 15 * 60_000;
/**
 * Slow keepalive for the full inventory: re-send a complete snapshot at least
 * this often even when nothing structural changed, so a missed delta self-heals.
 * Between keepalives, inventory is sent ONLY on a real fingerprint change.
 */
export const INVENTORY_KEEPALIVE_MS = 6 * 60 * 60_000;
/** Coalesce a burst of events into one inventory push. */
const EVENT_DEBOUNCE_MS = 10_000;
/** Backoff ceiling after repeated failures. */
const MAX_BACKOFF_MS = 15 * 60_000;

/** Persisted across daemon restarts so a re-spawn never re-bursts an
 *  already-sent inventory (the auth/startup-burst flood source). */
export interface FleetReporterState {
  lastInventoryFp: string;
  lastInventoryAt: number;
}

function fleetStatePath(): string {
  return join(globalDir(), "state", "fleet-reporter.json");
}

/** Read the last-sent inventory fingerprint + timestamp. null on first run /
 *  missing / corrupt — the reporter then treats inventory as due. */
function loadFleetState(): FleetReporterState | null {
  try {
    const s = JSON.parse(readFileSync(fleetStatePath(), "utf8"));
    if (
      typeof s?.lastInventoryFp === "string" &&
      typeof s?.lastInventoryAt === "number"
    ) {
      return {
        lastInventoryFp: s.lastInventoryFp,
        lastInventoryAt: s.lastInventoryAt,
      };
    }
  } catch {
    /* missing / corrupt → fresh start */
  }
  return null;
}

/** Persist the last-sent inventory fingerprint + timestamp. Best-effort. */
function saveFleetState(state: FleetReporterState): void {
  try {
    mkdirSync(join(globalDir(), "state"), { recursive: true });
    writeFileSync(fleetStatePath(), JSON.stringify(state), "utf8");
  } catch {
    /* best-effort — a write failure just means a restart may re-send once */
  }
}

/**
 * Structural fingerprint of an inventory report — the subset whose change is
 * worth a network push. Excludes pure telemetry that changes every tick
 * (uptime, rss, per-repo memory, connections, idle, last_activity timestamps),
 * so idle heartbeat churn and no-op proxy flaps produce an identical hash and
 * are skipped. Repos are sorted by path so order never perturbs the hash.
 */
export function inventoryFingerprint(report: InventoryDetail): string {
  const structural = {
    m: {
      n: report.machine.machine_name,
      o: report.machine.os,
      a: report.machine.arch,
      v: report.machine.cli_version,
      p: report.machine.daemon?.dashboard_port,
    },
    r: report.repos
      .map((x) => ({
        p: x.path,
        repo: x.repo,
        s: x.status,
        hp: x.http_port,
        o: x.origin,
        ec: x.entity_count,
        gc: x.edge_count,
      }))
      .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(structural)).digest("hex");
}

/** Resolved auth for one report attempt; null means "not logged in". */
export interface FleetAuth {
  apiUrl: string;
  token: string;
  machineId: string;
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
  /**
   * Append one stamped fleet event to the machine segment store. Defaults to
   * `appendEvent(machineEventsRoot(), FLEET_SEGMENT, …)`. Injected so a test
   * never writes to the real `~/.unerr/events`.
   */
  appendFleetEvent?: (event: StoredEvent) => void;
  /** Schedule a callback after a delay; returns a clearable handle. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Jitter factor in [0,1) (defaults to Math.random; injectable for tests). */
  jitter?: () => number;
  /** Wall clock in ms (defaults to Date.now; injectable for tests). */
  now?: () => number;
  /** Load persisted last-sent inventory state (defaults to a file in ~/.unerr). */
  loadState?: () => FleetReporterState | null;
  /** Persist last-sent inventory state (defaults to a file in ~/.unerr). */
  saveState?: (state: FleetReporterState) => void;
}

/**
 * Drives the heartbeat/inventory loop for one daemon. Construct once, `start()`
 * on boot, `notifyEvent()` on repo/proxy changes, `stop()` on shutdown.
 *
 * @sem domain=infrastructure
 */
export class FleetReporter {
  private readonly deps: Required<
    Pick<
      FleetReporterDeps,
      | "appendFleetEvent"
      | "setTimer"
      | "clearTimer"
      | "jitter"
      | "now"
      | "loadState"
      | "saveState"
    >
  > &
    FleetReporterDeps;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;
  /** Fingerprint of the last successfully-sent inventory (dedup key). */
  private lastInventoryFp = "";
  /** When the last inventory was successfully sent (ms); drives the keepalive. */
  private lastInventoryAt = 0;

  constructor(deps: FleetReporterDeps) {
    this.deps = {
      ...deps,
      appendFleetEvent:
        deps.appendFleetEvent ??
        ((e) => appendEvent(machineEventsRoot(), FLEET_SEGMENT, e)),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref()),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h)),
      jitter: deps.jitter ?? Math.random,
      now: deps.now ?? (() => Date.now()),
      loadState: deps.loadState ?? loadFleetState,
      saveState: deps.saveState ?? saveFleetState,
    };
    // Seed dedup state from the prior run so a restarted daemon never re-bursts
    // an inventory it already sent (within the keepalive window).
    const persisted = this.deps.loadState();
    if (persisted) {
      this.lastInventoryFp = persisted.lastInventoryFp;
      this.lastInventoryAt = persisted.lastInventoryAt;
    }
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

    // Inventory is considered on a fleet-changing event (forceInventory) or when
    // the slow keepalive elapsed. It is actually SENT only when its structural
    // fingerprint changed, or the keepalive forces a refresh — so idle ticks and
    // no-op proxy flaps cost zero requests.
    const now = this.deps.now();
    const inventoryDue = now - this.lastInventoryAt >= INVENTORY_KEEPALIVE_MS;
    if (forceInventory || inventoryDue) {
      const detail = await buildFleetReport(inputs);
      if (detail) {
        const fp = inventoryFingerprint(detail);
        if (fp !== this.lastInventoryFp || inventoryDue) {
          const event = stampEvent(FLEET_CTX, {
            type: "machine_inventory",
            detail: detail as unknown as Record<string, unknown>,
          });
          validateBody(MachineInventoryEvent, event, "fleet:inventory", (m) =>
            this.deps.log?.(m)
          );
          this.deps.appendFleetEvent(event);
          this.lastInventoryFp = fp;
          this.lastInventoryAt = now;
          this.deps.saveState({
            lastInventoryFp: this.lastInventoryFp,
            lastInventoryAt: this.lastInventoryAt,
          });
          if (reason) this.deps.log?.(`fleet: inventory pushed (${reason})`);
          return DEFAULT_CHECKIN_INTERVAL_MS;
        }
      }
      // An event-driven cycle with no structural change → nothing to report.
      // (A scheduled tick falls through to the liveness heartbeat below.)
      if (forceInventory) return DEFAULT_CHECKIN_INTERVAL_MS;
    }

    // Scheduled tick → liveness heartbeat on the one ingest stream.
    const beat = buildHeartbeatReport(inputs);
    if (!beat) return DEFAULT_CHECKIN_INTERVAL_MS;
    const event = stampEvent(FLEET_CTX, {
      type: "machine_checkin",
      detail: beat as unknown as Record<string, unknown>,
    });
    validateBody(MachineCheckinEvent, event, "fleet:checkin", (m) =>
      this.deps.log?.(m)
    );
    this.deps.appendFleetEvent(event);
    return DEFAULT_CHECKIN_INTERVAL_MS;
  }

  /** Schedule the next cycle (always a heartbeat unless the Nth/forced). */
  private scheduleNext(delayMs: number): void {
    if (this.timer) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => void this.runCycle(false), delayMs);
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
