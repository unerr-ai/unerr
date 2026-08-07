/**
 * L5 — fleet reporter loop. The payload builders are mocked (covered in
 * fleet-inventory.test.ts); this isolates the loop logic: start appends a full
 * inventory, heartbeats follow at the default cadence, events debounce into one
 * inventory append, the logged-out gate short-circuits, and an append failure
 * backs off without ever throwing into the daemon. Rev-3: both fleet payloads
 * are `machine_inventory` / `machine_checkin` events appended to the machine
 * segment store (`~/.unerr/events/fleet.jsonl`); the daemon's push loop drains
 * them. The reporter no longer pushes to the cloud directly, so the seam under
 * test is `appendFleetEvent`, not a client.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../daemon/fleet-inventory.js", () => ({
  buildFleetReport: vi.fn(),
  buildHeartbeatReport: vi.fn(),
}));

// Hermetic home dir so `isTelemetryDisabledByConfig`'s machine-wide check
// (used by the per-repo opt-out filter below) never reads the real
// `~/.unerr/config.json`.
let tempHome: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import {
  buildFleetReport,
  buildHeartbeatReport,
} from "../daemon/fleet-inventory.js";
import {
  DEFAULT_CHECKIN_INTERVAL_MS,
  type FleetAuth,
  FleetReporter,
  type FleetReporterDeps,
  INVENTORY_KEEPALIVE_MS,
  inventoryFingerprint,
} from "../daemon/fleet-reporter.js";
import type { RepoStatusEntry } from "../daemon/protocol.js";

/** A minimal valid RepoStatusEntry for a given repo root path. */
function statusEntry(path: string): RepoStatusEntry {
  return {
    path,
    label: path,
    status: "running",
    pid: 1,
    memory: 1,
    idle: 0,
    connections: 0,
    lastActivity: null,
    entityCount: 1,
    edgeCount: 1,
    needsInput: [],
  };
}

const mockedBuildFleet = vi.mocked(buildFleetReport);
const mockedBuildBeat = vi.mocked(buildHeartbeatReport);

/** A contract-valid daemon runtime block, reused by both payloads. */
const DAEMON = { pid: 1, uptime_s: 1, rss_bytes: 1, dashboard_port: 1 };
/** A contract-valid machine block for the inventory detail. */
const MACHINE = {
  machine_name: "host",
  os: "mac",
  arch: "arm64",
  cli_version: "1",
  daemon: DAEMON,
};

/** Real-timer microtask flush so injected async cycles settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
  reporter: FleetReporter;
  /** The one sink seam; every fleet event is appended through it. */
  append: ReturnType<typeof vi.fn>;
  /** How many `machine_inventory` events were appended so far. */
  inventoryCount: () => number;
  /** How many `machine_checkin` events were appended so far. */
  checkinCount: () => number;
  timers: Map<NodeJS.Timeout, { fn: () => void; ms: number }>;
  fireLatest: () => Promise<void>;
  setAuth: (a: FleetAuth | null) => void;
}

function makeHarness(over: Partial<FleetReporterDeps> = {}): Harness {
  const append = vi.fn();

  // Count appends by the discriminant on the single appended event.
  const typeCount = (t: string) =>
    append.mock.calls.filter((c) => (c[0] as { type?: string })?.type === t)
      .length;

  const timers = new Map<NodeJS.Timeout, { fn: () => void; ms: number }>();
  let nextId = 1;

  let auth: FleetAuth | null = {
    apiUrl: "https://app.unerr.dev",
    token: "unerr_sk_x",
    machineId: "m_1",
  };

  const reporter = new FleetReporter({
    getStatusEntries: () => [],
    resolveAuth: () => auth,
    isEntitled: () => true,
    dashboardPort: () => 9847,
    appendFleetEvent: append,
    setTimer: (fn, ms) => {
      const h = nextId++ as unknown as NodeJS.Timeout;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    jitter: () => 0.5,
    // Hermetic dedup state: never touch ~/.unerr; each test starts fresh
    // (lastInventoryAt=0 → inventory due on first cycle) unless it overrides.
    loadState: () => null,
    saveState: () => {},
    ...over,
  });

  async function fireLatest(): Promise<void> {
    const entries = [...timers.entries()];
    const last = entries[entries.length - 1];
    if (!last) return;
    timers.delete(last[0]);
    last[1].fn();
    await flush();
  }

  return {
    reporter,
    append,
    inventoryCount: () => typeCount("machine_inventory"),
    checkinCount: () => typeCount("machine_checkin"),
    timers,
    fireLatest,
    setAuth: (a) => {
      auth = a;
    },
  };
}

beforeEach(() => {
  mockedBuildFleet.mockResolvedValue({ machine: MACHINE, repos: [] } as any);
  mockedBuildBeat.mockReturnValue({ daemon: DAEMON, repos: [] } as any);
  tempHome = mkdtempSync(join(tmpdir(), "unerr-fleet-home-"));
  process.env.__TEST_HOME = tempHome;
});

afterEach(() => {
  vi.clearAllMocks();
  // biome-ignore lint/performance/noDelete: must unset the env var — assigning undefined would set it to the string "undefined"
  delete process.env.__TEST_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("FleetReporter", () => {
  it("appends a full inventory on start, then schedules a heartbeat", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush();
    expect(h.inventoryCount()).toBe(1);
    expect(h.checkinCount()).toBe(0);
    // The appended event is the contract `machine_inventory` variant.
    const firstEvent = h.append.mock.calls[0]?.[0] as { type?: string };
    expect(firstEvent?.type).toBe("machine_inventory");
    // A next-cycle timer is scheduled at the default cadence.
    const last = [...h.timers.values()].at(-1);
    expect(last?.ms).toBe(DEFAULT_CHECKIN_INTERVAL_MS);
    h.reporter.stop();
  });

  it("appends a heartbeat on the next cycle at the default cadence", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush(); // start inventory
    await h.fireLatest(); // first heartbeat
    expect(h.checkinCount()).toBe(1);
    const last = [...h.timers.values()].at(-1);
    expect(last?.ms).toBe(DEFAULT_CHECKIN_INTERVAL_MS);
    h.reporter.stop();
  });

  it("debounces a burst of events into one inventory append", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush();
    h.append.mockClear();
    // A real structural change, else the fingerprint dedup suppresses the push.
    mockedBuildFleet.mockResolvedValue({
      machine: MACHINE,
      repos: [
        { path: "/r", repo: "abc", status: "running", connections: 0 } as any,
      ],
    } as any);
    h.reporter.notifyEvent("repo-add");
    h.reporter.notifyEvent("proxy-start");
    h.reporter.notifyEvent("repo-add");
    await h.fireLatest(); // fire the single debounce timer
    expect(h.inventoryCount()).toBe(1);
    h.reporter.stop();
  });

  it("skips the inventory append when nothing structural changed", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush();
    expect(h.inventoryCount()).toBe(1); // initial snapshot
    h.append.mockClear();
    // Same report → same fingerprint → an event appends NEITHER inventory nor a
    // heartbeat (a no-op proxy flap costs zero rows).
    h.reporter.notifyEvent("proxy-start");
    await h.fireLatest();
    expect(h.append).not.toHaveBeenCalled();
    h.reporter.stop();
  });

  it("suppresses the startup inventory burst when persisted state is fresh", async () => {
    const report = { machine: MACHINE, repos: [] };
    mockedBuildFleet.mockResolvedValue(report as any);
    const persisted = {
      lastInventoryFp: inventoryFingerprint(report as any),
      lastInventoryAt: 1_000_000,
    };
    // Restart 1 min later, well inside the keepalive window, state unchanged.
    const h = makeHarness({
      loadState: () => persisted,
      now: () => 1_000_000 + 60_000,
    });
    h.reporter.start();
    await flush();
    expect(h.inventoryCount()).toBe(0);
    h.reporter.stop();
  });

  it("re-sends inventory when the keepalive window elapsed even if unchanged", async () => {
    const report = { machine: MACHINE, repos: [] };
    mockedBuildFleet.mockResolvedValue(report as any);
    const persisted = {
      lastInventoryFp: inventoryFingerprint(report as any),
      lastInventoryAt: 0,
    };
    const h = makeHarness({
      loadState: () => persisted,
      now: () => INVENTORY_KEEPALIVE_MS + 1, // keepalive elapsed
    });
    h.reporter.start();
    await flush();
    expect(h.inventoryCount()).toBe(1);
    h.reporter.stop();
  });

  it("does nothing when logged out", async () => {
    const h = makeHarness();
    h.setAuth(null);
    h.reporter.start();
    await flush();
    expect(h.append).not.toHaveBeenCalled();
    h.reporter.stop();
  });

  it("does nothing when not entitled (fail-closed, even while logged in)", async () => {
    const h = makeHarness({ isEntitled: () => false });
    h.reporter.start();
    await flush();
    expect(h.append).not.toHaveBeenCalled();
    expect(mockedBuildFleet).not.toHaveBeenCalled();
    h.reporter.stop();
  });

  it("excludes a repo with its own telemetry:false from the inventory/heartbeat inputs", async () => {
    const optedOut = mkdtempSync(join(tmpdir(), "unerr-fleet-repo-out-"));
    const optedIn = mkdtempSync(join(tmpdir(), "unerr-fleet-repo-in-"));
    mkdirSync(join(optedOut, ".unerr"), { recursive: true });
    writeFileSync(
      join(optedOut, ".unerr", "config.json"),
      JSON.stringify({ telemetry: false })
    );
    try {
      const h = makeHarness({
        getStatusEntries: () => [statusEntry(optedOut), statusEntry(optedIn)],
      });
      h.reporter.start();
      await flush();
      expect(mockedBuildFleet).toHaveBeenCalledTimes(1);
      const inputs = mockedBuildFleet.mock.calls[0]?.[0] as {
        statusEntries: RepoStatusEntry[];
      };
      expect(inputs.statusEntries.map((e) => e.path)).toEqual([optedIn]);
      h.reporter.stop();
    } finally {
      rmSync(optedOut, { recursive: true, force: true });
      rmSync(optedIn, { recursive: true, force: true });
    }
  });

  it("backs off without throwing when the append fails", async () => {
    const h = makeHarness({
      appendFleetEvent: () => {
        throw new Error("disk full");
      },
    });
    expect(() => h.reporter.start()).not.toThrow();
    await flush();
    // Still scheduled a retry — the loop survives an append failure.
    expect(h.timers.size).toBeGreaterThan(0);
    h.reporter.stop();
  });

  it("stop() halts the loop and clears timers", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush();
    h.reporter.stop();
    expect(h.timers.size).toBe(0);
  });
});
