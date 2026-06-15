/**
 * Free-tier runtime single-active cap (C2): warm-start picks ONLY the last
 * active repo when the limit is 1, and the daemon refuses a second concurrent
 * `ensure()` for a different repo with `already_active`.
 *
 * No entitlement cache exists in these temp homes, so `tierFromCache()` returns
 * the free fallback (limit 1) — exactly the case the cap targets.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoEntry } from "../daemon/protocol.js";

const forkMock = vi.fn();
vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

// Keep warm-start out of its battery/load abort paths so the selection logic
// (the unit under test) runs deterministically regardless of the host.
vi.mock("../daemon/system-health.js", () => ({
  onBattery: () => false,
  loadAverage1: () => 0,
}));

// Pin the tier to free (limit 1) — the case this cap targets. A real machine
// can carry a dev-minted PRO entitlement (`.unerr/dev.json` / `UNERR_ENTITLEMENT_*`
// env), which would resolve `tierFromCache()` to pro, lift the limit, and let the
// 2nd repo spawn — defeating the assertion. Both call sites under test
// (process-manager + warm-start) read the exported `tierFromCache`, so mocking it
// here is enough; every other export stays real.
vi.mock("../cloud/tier-query.js", async (importActual) => ({
  ...(await importActual<typeof import("../cloud/tier-query.js")>()),
  tierFromCache: () => ({
    plan: "free",
    source: "free_fallback" as const,
    features: {},
    limits: { maxActiveRepos: 1, maxMembers: 1, maxMachines: 1 },
  }),
}));

function makeFakeChild(pid: number): EventEmitter & {
  pid: number;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.pid = pid;
  child.send = vi.fn();
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

function entry(path: string, lastActivity: string | null): RepoEntry {
  return {
    path,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastStarted: null,
    lastActivity,
    idleTimeout: 1800,
    label: path.split("/").pop() ?? path,
    settings: {},
  };
}

describe("free-tier runtime single-active cap", () => {
  let testDir: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
    testDir = join(tmpdir(), `active-cap-${Date.now()}-${counter}`);
    mkdirSync(join(testDir, ".unerr"), { recursive: true });
    vi.stubEnv("UNERR_HOME", testDir);
    writeFileSync(
      join(testDir, ".unerr", "repos.json"),
      JSON.stringify({ version: 1, repos: [] })
    );
    forkMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { resetCICache } = await import("../daemon/detect-ci.js");
    resetCICache();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("lastActiveRepo picks max(lastActivity ?? lastStarted ?? addedAt)", async () => {
    const { lastActiveRepo } = await import("../daemon/warm-start.js");
    const repos = [
      entry("/r/old", "2026-01-02T00:00:00.000Z"),
      entry("/r/newest", "2026-06-01T00:00:00.000Z"),
      entry("/r/mid", "2026-03-01T00:00:00.000Z"),
    ];
    expect(lastActiveRepo(repos)?.path).toBe("/r/newest");
    expect(lastActiveRepo([])).toBeNull();
  });

  it("warm-start starts ONLY the last-active repo when the limit is 1", async () => {
    // runWarmStart short-circuits under CI — force the non-CI path so the
    // selection logic actually runs on CI machines too.
    vi.stubEnv("CI", "");
    vi.stubEnv("CONTINUOUS_INTEGRATION", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    const { resetCICache } = await import("../daemon/detect-ci.js");
    resetCICache();

    // Timestamps are RELATIVE to now: the warm-start idle cutoff
    // (warmStartIdleDays = 14) skips any repo whose lastActivity is older than
    // that window, so absolute dates would time-bomb the test once "now" drifts
    // past the cutoff. repoB is the most recent (and within the window) → the
    // single repo the limit-1 cap selects.
    const DAY = 24 * 60 * 60 * 1000;
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const repoB = join(testDir, "r-b");
    const repos = [
      entry(join(testDir, "r-a"), iso(5 * DAY)),
      entry(repoB, iso(1 * DAY)), // most recent (within idle window) → only this one
      entry(join(testDir, "r-c"), iso(3 * DAY)),
    ];
    for (const e of repos) mkdirSync(e.path, { recursive: true });
    writeFileSync(
      join(testDir, ".unerr", "repos.json"),
      JSON.stringify({ version: 1, repos })
    );

    const { runWarmStart } = await import("../daemon/warm-start.js");

    // Stub the ProcessManager.ensure so we observe which repos warm-start picks.
    const ensured: string[] = [];
    const pm = {
      ensure: vi.fn(async (p: string) => {
        ensured.push(p);
        return p;
      }),
    } as unknown as import("../daemon/process-manager.js").ProcessManager;

    const result = await runWarmStart(pm);

    expect(ensured).toEqual([repoB]);
    expect(result.started.length).toBe(1);
  });

  it("refuses a 2nd concurrent ensure for a DIFFERENT repo with already_active", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoA = join(testDir, "repo-a");
    const repoB = join(testDir, "repo-b");
    const stateA = join(repoA, ".unerr", "state");
    mkdirSync(stateA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const sockA = join(stateA, "proxy.sock");

    // First repo spawns a child and becomes ready → it now holds the one slot.
    const childA = makeFakeChild(424242);
    forkMock.mockReturnValueOnce(childA);
    const pA = pm.ensure(repoA);
    await new Promise((r) => setImmediate(r));
    childA.emit("message", { type: "ready", sock: sockA });
    const outA = await pA;
    expect(outA).toBe(sockA);

    // Second repo, while A is running, must be refused — no extra fork.
    const outB = await pm.ensure(repoB);
    expect(typeof outB).not.toBe("string");
    if (typeof outB !== "string") {
      expect(outB.refused).toBe("already_active");
      expect(outB.activePath).toBe(repoA);
      expect(outB.message).toContain("upgrade to Pro");
    }
    // Only ONE fork ever happened (A); B was refused before spawning.
    expect(forkMock).toHaveBeenCalledTimes(1);
  });
});
