/**
 * C3.2/C3.4 — fleet reporter loop. The payload builders are mocked (covered in
 * fleet-inventory.test.ts); this isolates the loop logic: start pushes a full
 * inventory, heartbeats follow the server-driven cadence, events debounce into
 * one inventory push, the logged-out gate short-circuits, and a failure backs
 * off without ever throwing into the daemon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../daemon/fleet-inventory.js", () => ({
  buildFleetReport: vi.fn(),
  buildHeartbeatReport: vi.fn(),
}));

import {
  buildFleetReport,
  buildHeartbeatReport,
} from "../daemon/fleet-inventory.js";
import {
  DEFAULT_CHECKIN_INTERVAL_MS,
  type FleetAuth,
  type FleetClient,
  FleetReporter,
  type FleetReporterDeps,
} from "../daemon/fleet-reporter.js";

const mockedBuildFleet = vi.mocked(buildFleetReport);
const mockedBuildBeat = vi.mocked(buildHeartbeatReport);

/** Real-timer microtask flush so injected async cycles settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
  reporter: FleetReporter;
  postCheckin: ReturnType<typeof vi.fn>;
  putInventory: ReturnType<typeof vi.fn>;
  timers: Map<NodeJS.Timeout, { fn: () => void; ms: number }>;
  fireLatest: () => Promise<void>;
  setAuth: (a: FleetAuth | null) => void;
}

function makeHarness(over: Partial<FleetReporterDeps> = {}): Harness {
  const postCheckin = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { ack: true } });
  const putInventory = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { accepted: true } });
  const client: FleetClient = {
    postCheckin,
    putInventory,
  } as unknown as FleetClient;

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
    dashboardPort: () => 9847,
    makeClient: () => client,
    setTimer: (fn, ms) => {
      const h = nextId++ as unknown as NodeJS.Timeout;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    jitter: () => 0.5,
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
    postCheckin,
    putInventory,
    timers,
    fireLatest,
    setAuth: (a) => {
      auth = a;
    },
  };
}

beforeEach(() => {
  mockedBuildFleet.mockResolvedValue({
    schema_version: 1,
    machine: { machine_name: "host" } as any,
    repos: [],
  });
  mockedBuildBeat.mockReturnValue({
    schema_version: 1,
    daemon: {} as any,
    repos: [],
  });
});

afterEach(() => vi.clearAllMocks());

describe("FleetReporter", () => {
  it("pushes a full inventory on start, then schedules a heartbeat", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush();
    expect(h.putInventory).toHaveBeenCalledTimes(1);
    expect(h.putInventory).toHaveBeenCalledWith(expect.any(Object));
    expect(h.postCheckin).not.toHaveBeenCalled();
    // A next-cycle timer is scheduled at the default cadence.
    const last = [...h.timers.values()].at(-1);
    expect(last?.ms).toBe(DEFAULT_CHECKIN_INTERVAL_MS);
    h.reporter.stop();
  });

  it("sends a heartbeat on the next cycle and honors server cadence", async () => {
    const h = makeHarness();
    h.postCheckin.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ack: true, next_checkin_after_seconds: 120 },
    });
    h.reporter.start();
    await flush(); // start inventory
    await h.fireLatest(); // first heartbeat
    expect(h.postCheckin).toHaveBeenCalledTimes(1);
    const last = [...h.timers.values()].at(-1);
    expect(last?.ms).toBe(120_000);
    h.reporter.stop();
  });

  it("clamps an out-of-range server cadence", async () => {
    const h = makeHarness();
    h.postCheckin.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ack: true, next_checkin_after_seconds: 5 }, // below the floor
    });
    h.reporter.start();
    await flush();
    await h.fireLatest();
    const last = [...h.timers.values()].at(-1);
    expect(last?.ms).toBe(30_000); // MIN_CHECKIN_INTERVAL_MS
    h.reporter.stop();
  });

  it("debounces a burst of events into one inventory push", async () => {
    const h = makeHarness();
    h.reporter.start();
    await flush();
    h.putInventory.mockClear();
    h.reporter.notifyEvent("repo-add");
    h.reporter.notifyEvent("proxy-start");
    h.reporter.notifyEvent("repo-add");
    await h.fireLatest(); // fire the single debounce timer
    expect(h.putInventory).toHaveBeenCalledTimes(1);
    h.reporter.stop();
  });

  it("does nothing when logged out", async () => {
    const h = makeHarness();
    h.setAuth(null);
    h.reporter.start();
    await flush();
    expect(h.putInventory).not.toHaveBeenCalled();
    h.reporter.stop();
  });

  it("backs off on a failed response without throwing", async () => {
    const h = makeHarness();
    h.putInventory.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: "server_error", message: "down" },
    });
    expect(() => h.reporter.start()).not.toThrow();
    await flush();
    // Still scheduled a retry — the loop survives.
    expect(h.timers.size).toBeGreaterThan(0);
    h.reporter.stop();
  });

  it("never throws when the client itself throws", async () => {
    const h = makeHarness({
      makeClient: () => {
        throw new Error("boom");
      },
    });
    expect(() => h.reporter.start()).not.toThrow();
    await flush();
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
