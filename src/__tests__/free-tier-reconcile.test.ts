/**
 * `ProcessManager.reconcileFreeTier` used to bring a running set down to one
 * proxy when the resolved repo limit was exactly 1 (an account lapsed from
 * Pro to free). The repo limit is unlimited on every plan now, so the method
 * is permanently a no-op — this proves it never stops a live proxy.
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

describe("ProcessManager.reconcileFreeTier", () => {
  let testDir: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
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

  it("is a permanent no-op — never stops a live proxy", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoA = join(testDir, "repo-a");
    const repoB = join(testDir, "repo-b");
    await seedRunning(pm, repoA, 111111);
    await seedRunning(pm, repoB, 222222);
    expect(forkMock).toHaveBeenCalledTimes(2);

    const stopped = await pm.reconcileFreeTier();
    expect(stopped).toBe(0);
    expect(pm.getManaged(repoA)?.status).toBe("running");
    expect(pm.getManaged(repoB)?.status).toBe("running");
  });
});
