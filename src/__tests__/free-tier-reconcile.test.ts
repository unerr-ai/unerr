/**
 * Free-tier single-active RECONCILER: `ProcessManager.reconcileFreeTier` brings
 * a running set that was admitted under Pro (then lapsed to free) down to the
 * one free slot. The admission check in `ensure` only blocks NEW foreign
 * starts — it never stops proxies already running, so this reconciler is what
 * makes free actually converge to a single active repo.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.fn();
vi.mock("node:child_process", async (importActual) => ({
  ...(await importActual<typeof import("node:child_process")>()),
  fork: (...args: unknown[]) => forkMock(...args),
}));

// Keep warm-start / system-health host-independent (unused here but imported
// transitively by the daemon module graph).
vi.mock("../daemon/system-health.js", () => ({
  onBattery: () => false,
  loadAverage1: () => 0,
}));

// Mutable tier so a test can seed repos under Pro (unlimited) then flip to free
// (limit 1) and assert the reconcile converges — the exact Pro→free lapse.
const tierState = { limit: -1 };
vi.mock("../cloud/tier-query.js", async (importActual) => ({
  ...(await importActual<typeof import("../cloud/tier-query.js")>()),
  tierFromCache: () => ({
    plan: tierState.limit === 1 ? "free" : "pro",
    source: "cache" as const,
    features: {},
    limits: {
      maxActiveRepos: tierState.limit,
      maxMembers: tierState.limit === 1 ? 1 : -1,
      maxMachines: tierState.limit === 1 ? 1 : -1,
    },
  }),
}));

type FakeChild = EventEmitter & {
  pid: number;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
};

function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  // A graceful { type: "shutdown" } resolves shutdownChild by emitting exit.
  child.send = vi.fn((msg: { type?: string }) => {
    if (msg?.type === "shutdown") {
      setImmediate(() => child.emit("exit", 0, null));
    }
    return true;
  });
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", null, "SIGKILL");
    return true;
  });
  return child;
}

describe("free-tier single-active reconciler", () => {
  let testDir: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
    tierState.limit = -1; // start Pro so seeding two repos is allowed
    testDir = join(tmpdir(), `reconcile-${Date.now()}-${counter}`);
    mkdirSync(join(testDir, ".unerr"), { recursive: true });
    vi.stubEnv("UNERR_HOME", testDir);
    writeFileSync(
      join(testDir, ".unerr", "repos.json"),
      JSON.stringify({ version: 1, repos: [] })
    );
    forkMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  /** Ensure a repo to "running" via a fake forked child that reaches ready. */
  async function seedRunning(
    pm: import("../daemon/process-manager.js").ProcessManager,
    repoPath: string,
    pid: number
  ): Promise<void> {
    const stateDir = join(repoPath, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const sock = join(stateDir, "proxy.sock");
    const child = makeFakeChild(pid);
    forkMock.mockReturnValueOnce(child);
    const p = pm.ensure(repoPath);
    await new Promise((r) => setImmediate(r));
    child.emit("message", { type: "ready", sock });
    const out = await p;
    expect(out).toBe(sock);
  }

  it("stops all but the most-connected/active repo when the tier lapses to free", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoA = join(testDir, "repo-a");
    const repoB = join(testDir, "repo-b");

    // Both admitted under Pro (cap is a no-op) → two live proxies.
    await seedRunning(pm, repoA, 111111);
    await seedRunning(pm, repoB, 222222);
    expect(forkMock).toHaveBeenCalledTimes(2);

    // repoB is the one the user is inside — give it a live connection so the
    // keep-selection (most connections first) is deterministic.
    pm.connect(repoB);

    // Pro lapses to free.
    tierState.limit = 1;

    const stopped = await pm.reconcileFreeTier();
    expect(stopped).toBe(1);

    expect(pm.getManaged(repoB)?.status).toBe("running");
    expect(pm.getManaged(repoA)?.status).toBe("stopped");
  });

  it("is a no-op on Pro (unlimited) even with several repos running", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoA = join(testDir, "repo-a");
    const repoB = join(testDir, "repo-b");
    await seedRunning(pm, repoA, 333333);
    await seedRunning(pm, repoB, 444444);

    // Tier stays Pro (limit -1).
    const stopped = await pm.reconcileFreeTier();
    expect(stopped).toBe(0);
    expect(pm.getManaged(repoA)?.status).toBe("running");
    expect(pm.getManaged(repoB)?.status).toBe("running");
  });

  it("is a no-op on free when only one repo is running", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoA = join(testDir, "repo-a");
    await seedRunning(pm, repoA, 555555);
    tierState.limit = 1;

    const stopped = await pm.reconcileFreeTier();
    expect(stopped).toBe(0);
    expect(pm.getManaged(repoA)?.status).toBe("running");
  });
});
