import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchAck, CloudResult } from "../cloud/client.js";
import type {
  BuildDrainers,
  DrainerContext,
  StreamBatch,
  StreamDrainer,
} from "../cloud/push-drainer.js";
import {
  DEFAULT_PUSH_INTERVAL_MS,
  type PushAuth,
  PushReporter,
  type PushReporterDeps,
} from "../daemon/push-reporter.js";

const ok = (ack: BatchAck): CloudResult<BatchAck> => ({
  ok: true,
  status: 200,
  data: ack,
});
const netErr = (): CloudResult<BatchAck> => ({
  ok: false,
  status: 0,
  network: true,
  error: { code: "network_error", message: "offline" },
});

const auth: PushAuth = { apiUrl: "https://api.test", token: "tok" };

/** Per-test temp dir (set in beforeEach); closed over by makeHarness. */
let unerrDir: string;

/** A drainer that yields one batch then null, recording each push. */
function oneShotDrainer(
  key: string,
  result: () => CloudResult<BatchAck>,
  pushed: unknown[][]
): StreamDrainer {
  let read = false;
  return {
    key,
    async read() {
      if (read) return null;
      read = true;
      const batch: StreamBatch = { rows: [{ a: 1 }], next: { lastId: 1 } };
      return batch;
    },
    async push(rows) {
      pushed.push(rows);
      return result();
    },
  };
}

/**
 * A deterministic harness: `start()` fires cycle #1 immediately; the loop's
 * `setTimer` is captured (never auto-fires). `settled()` returns a promise that
 * resolves the moment a cycle finishes (it schedules the next via setTimer);
 * `advance()` fires the captured timer to run the following cycle by hand.
 */
function makeHarness(over: Partial<PushReporterDeps> = {}) {
  const ctxs: DrainerContext[] = [];
  const delays: number[] = [];
  let timerFn: (() => void) | null = null;
  let onSchedule: (() => void) | null = null;

  // Both the repo and the machine-level fleet store live under the per-test temp
  // dir. The drain is timer-driven (no event-dir watcher), so a hand-fired
  // `setTimer` is the only trigger the harness needs.
  const repoPath = join(unerrDir, "repo-a");
  const machineRoot = join(unerrDir, "machine");

  const defaultBuild: BuildDrainers = async (ctx) => {
    ctxs.push(ctx);
    return { drainers: [] };
  };
  const { buildDrainers: overBuild, ...restOver } = over;
  const userBuild = overBuild ?? defaultBuild;
  // The machine-level fleet drain rides the same loop as a pseudo-repo; tests
  // here exercise the per-repo path, so neutralize the machine call (and keep it
  // out of `ctxs`) — its own behaviour is covered by drainMachine assertions.
  const wrappedBuild: BuildDrainers = async (ctx) =>
    ctx.repoPath === machineRoot ? { drainers: [] } : userBuild(ctx);

  const reporter = new PushReporter({
    getRepos: () => [{ path: repoPath }],
    resolveAuth: () => auth,
    isEntitled: () => true,
    buildDrainers: wrappedBuild,
    deriveRepoId: async (p) => `id-${p}`,
    unerrDir: (p) => p,
    makeClient: () => ({}) as never,
    machineEventsRoot: () => machineRoot,
    setTimer: (fn, ms) => {
      timerFn = fn;
      delays.push(ms);
      onSchedule?.();
      return 1 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
    jitter: () => 0,
    ...restOver,
  });

  /** A promise that resolves when the next cycle finishes (calls setTimer). */
  const settled = () =>
    new Promise<void>((res) => {
      onSchedule = () => {
        onSchedule = null;
        res();
      };
    });
  /** Fire the captured timer callback to run the next cycle. */
  const advance = () => timerFn?.();

  return { reporter, ctxs, delays, settled, advance, repoPath };
}

describe("PushReporter", () => {
  beforeEach(async () => {
    unerrDir = await mkdtemp(join(tmpdir(), "unerr-pushrep-"));
  });

  it("passes repoId, unerrDir, and source into the drainer context", async () => {
    const { reporter, ctxs, settled, repoPath } = makeHarness({
      unerrDir: () => unerrDir,
    });
    const done = settled();
    reporter.start();
    await done;
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]).toMatchObject({
      repoPath,
      unerrDir,
      repoId: `id-${repoPath}`,
    });
    expect(ctxs[0]?.source).toMatch(/^unerr-cli@/);
  });

  it("skips silently when logged out", async () => {
    const build = vi.fn(async () => ({ drainers: [] }));
    const { reporter, settled } = makeHarness({
      resolveAuth: () => null,
      buildDrainers: build,
    });
    const done = settled();
    reporter.start();
    await done;
    expect(build).not.toHaveBeenCalled();
  });

  it("skips silently when not entitled (B5)", async () => {
    const build = vi.fn(async () => ({ drainers: [] }));
    const { reporter, settled } = makeHarness({
      isEntitled: () => false,
      buildDrainers: build,
    });
    const done = settled();
    reporter.start();
    await done;
    expect(build).not.toHaveBeenCalled();
  });

  it("skips one repo when its .unerr/config.json sets telemetry:false", async () => {
    const build = vi.fn(async () => ({ drainers: [] }));
    const { reporter, settled, repoPath } = makeHarness({
      buildDrainers: build,
    });
    mkdirSync(join(repoPath, ".unerr"), { recursive: true });
    writeFileSync(
      join(repoPath, ".unerr", "config.json"),
      JSON.stringify({ telemetry: false })
    );
    const done = settled();
    reporter.start();
    await done;
    expect(build).not.toHaveBeenCalled();
  });

  it("drains a stream and disposes the set", async () => {
    const pushed: unknown[][] = [];
    const dispose = vi.fn();
    const { reporter, settled } = makeHarness({
      unerrDir: () => unerrDir,
      buildDrainers: async () => ({
        drainers: [oneShotDrainer("events", () => ok({ accepted: 1 }), pushed)],
        dispose,
      }),
    });
    const done = settled();
    reporter.start();
    await done;
    expect(pushed).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes even when a drainer throws on read", async () => {
    const dispose = vi.fn();
    const { reporter, settled } = makeHarness({
      unerrDir: () => unerrDir,
      buildDrainers: async () => ({
        drainers: [
          {
            key: "events",
            async read() {
              throw new Error("locked");
            },
            async push() {
              return ok({ accepted: 0 });
            },
          },
        ],
        dispose,
      }),
    });
    const done = settled();
    reporter.start();
    await done;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("backs off on repeated soft failures and resets after a clean cycle", async () => {
    const pushed: unknown[][] = [];
    let result: CloudResult<BatchAck> = netErr();
    const { reporter, delays, settled, advance } = makeHarness({
      unerrDir: () => unerrDir,
      jitter: () => 1, // upper jitter bound, so growth is unambiguous
      buildDrainers: async () => ({
        drainers: [oneShotDrainer("events", () => result, pushed)],
      }),
    });

    const done1 = settled();
    reporter.start(); // cycle #1: network error → first backoff
    await done1;
    const first = delays.at(-1) ?? 0;

    const done2 = settled();
    advance(); // cycle #2: still failing → backoff grows
    await done2;
    const second = delays.at(-1) ?? 0;
    expect(second).toBeGreaterThan(first);

    result = ok({ accepted: 1 });
    const done3 = settled();
    advance(); // cycle #3: clean → back to default cadence
    await done3;
    expect(delays.at(-1)).toBe(DEFAULT_PUSH_INTERVAL_MS);
  });

  it("stop() halts the loop — a fired timer does no work", async () => {
    const build = vi.fn(async () => ({ drainers: [] }));
    const { reporter, settled, advance } = makeHarness({
      buildDrainers: build,
    });
    const done = settled();
    reporter.start();
    await done;
    expect(build).toHaveBeenCalledOnce();
    reporter.stop();
    advance(); // would-be next cycle: running === false → no-op
    expect(build).toHaveBeenCalledOnce();
  });
});
