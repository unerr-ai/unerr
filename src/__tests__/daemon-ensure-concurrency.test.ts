/**
 * Regression: concurrent ensure() must wake ALL waiters.
 *
 * Two IDE sessions opening the same cold repo at the same moment issue two
 * `ensure` requests. The daemon's UDS server dispatches them concurrently
 * (fire-and-forget `.then` per frame), so both land in `ProcessManager`
 * while the per-repo proxy is still `status==="starting"`. Both must resolve
 * when the child sends `ready`.
 *
 * The original bug: waitForReady stored resolve/reject in a SINGLE per-repo
 * slot, so the second caller overwrote the first's resolver. On `ready`, only
 * the surviving waiter fired; the other `ensure` promise hung until the
 * 6.5-minute request timeout — surfacing as "the second MCP session times out
 * on tool calls / -32001".
 */

import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.fn();
vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

function makeFakeChild(): EventEmitter & {
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
  child.pid = 987654;
  child.send = vi.fn();
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

describe("ProcessManager.ensure — concurrent waiters", () => {
  let testDir: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
    testDir = join(tmpdir(), `ensure-conc-${Date.now()}-${counter}`);
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

  it("wakes BOTH concurrent ensure() callers when the child becomes ready", async () => {
    const fakeChild = makeFakeChild();
    forkMock.mockReturnValue(fakeChild);

    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoDir = join(testDir, "cold-repo");
    mkdirSync(repoDir, { recursive: true });
    const sock = join(repoDir, ".unerr", "state", "proxy.sock");

    // Two concurrent ensure() calls — the second must register as an additional
    // waiter, not clobber the first's resolver. Only ONE fork should happen.
    const p1 = pm.ensure(repoDir);
    const p2 = pm.ensure(repoDir);

    await new Promise((r) => setImmediate(r));
    expect(forkMock).toHaveBeenCalledTimes(1);

    // Child signals ready exactly once.
    fakeChild.emit("message", { type: "ready", sock });

    // Both promises must resolve to the same sock within a tight budget. On the
    // buggy single-slot code, p1 never resolves and this rejects via timeout.
    const guard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("a waiter hung — lost wakeup")), 2_000)
    );
    const [s1, s2] = (await Promise.race([
      Promise.all([p1, p2]),
      guard,
    ])) as [string, string];

    expect(s1).toBe(sock);
    expect(s2).toBe(sock);
  });

  it("rejects ALL concurrent waiters when the child exits during startup", async () => {
    const fakeChild = makeFakeChild();
    forkMock.mockReturnValue(fakeChild);

    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoDir = join(testDir, "crash-repo");
    mkdirSync(repoDir, { recursive: true });

    const p1 = pm.ensure(repoDir);
    const p2 = pm.ensure(repoDir);

    await new Promise((r) => setImmediate(r));

    // Child crashes on startup (code=1) — both waiters must reject, not hang.
    fakeChild.emit("exit", 1, null);

    const guard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("a waiter hung after child exit")), 2_000)
    );
    const settled = await Promise.race([
      Promise.allSettled([p1, p2]),
      guard,
    ]);

    expect((settled as PromiseSettledResult<string>[]).map((s) => s.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });

  it("re-adopts a race-winning proxy when the forked child exits during startup", async () => {
    const fakeChild = makeFakeChild();
    forkMock.mockReturnValue(fakeChild);

    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();

    const repoDir = join(testDir, "race-repo");
    const stateDir = join(repoDir, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const sock = join(stateDir, "proxy.sock");

    // No proxy on disk yet → first tryAdopt misses → ensure() forks a child.
    const p = pm.ensure(repoDir);
    await new Promise((r) => setImmediate(r));
    expect(forkMock).toHaveBeenCalledTimes(1);

    // A competing proxy wins the per-repo PID lock between tryAdopt and fork:
    // a live PID + sock now exist on disk (our own PID is guaranteed alive).
    writeFileSync(sock, "");
    writeFileSync(
      join(stateDir, "proxy.pid"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        healthPort: 0,
      })
    );

    // Our forked child loses the race and exits during startup. ensure() must
    // re-probe and adopt the live winner rather than surfacing the exit error.
    fakeChild.emit("exit", 0, null);

    const resolved = await p;
    expect(resolved).toBe(sock);
  });
});
