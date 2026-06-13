/**
 * Active-repo lock — free-tier single-active enforcement (C2).
 *
 * The lock at `<UNERR_HOME>/state/active-repo.lock` holds the one repo a free
 * account may run. These tests cover: acquire on a free slot, refusal when a
 * LIVE pid for a different repo holds it, reclaim of a stale (dead-pid) holder,
 * same-repo re-acquire, and release freeing the slot.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("active-repo-lock", () => {
  let testDir: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
    testDir = join(tmpdir(), `active-lock-${Date.now()}-${counter}`);
    mkdirSync(testDir, { recursive: true });
    vi.stubEnv("UNERR_HOME", testDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("acquires the slot when free", async () => {
    const { acquireActiveRepoLock, activeRepoHolder } = await import(
      "../daemon/active-repo-lock.js"
    );
    const result = acquireActiveRepoLock("/repo/a");
    expect(result.acquired).toBe(true);

    const holder = activeRepoHolder();
    expect(holder).not.toBeNull();
    expect(holder?.path).toBe("/repo/a");
    expect(holder?.pid).toBe(process.pid);
  });

  it("refuses a second acquire for a DIFFERENT path while held by a live pid", async () => {
    const { acquireActiveRepoLock, activeRepoLockPath } = await import(
      "../daemon/active-repo-lock.js"
    );

    // Hold the lock under THIS process's pid (guaranteed alive).
    const first = acquireActiveRepoLock("/repo/a");
    expect(first.acquired).toBe(true);
    // Sanity: the on-disk holder is the live current process.
    const body = JSON.parse(readFileSync(activeRepoLockPath(), "utf8"));
    expect(body.pid).toBe(process.pid);

    const second = acquireActiveRepoLock("/repo/b");
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holder.path).toBe("/repo/a");
      expect(second.holder.pid).toBe(process.pid);
    }
  });

  it("re-acquires for the SAME path (refreshes the pid, stays acquired)", async () => {
    const { acquireActiveRepoLock } = await import(
      "../daemon/active-repo-lock.js"
    );
    expect(acquireActiveRepoLock("/repo/a").acquired).toBe(true);
    // Same repo asking again is always allowed.
    expect(acquireActiveRepoLock("/repo/a").acquired).toBe(true);
  });

  it("reclaims a stale holder whose pid is dead", async () => {
    const { acquireActiveRepoLock, activeRepoLockPath, activeRepoHolder } =
      await import("../daemon/active-repo-lock.js");

    // Plant a lock owned by a dead pid for a different repo. globalDir() is
    // `<UNERR_HOME>/.unerr`, so the lock lives under `.unerr/state/`.
    mkdirSync(join(testDir, ".unerr", "state"), { recursive: true });
    const deadPid = 2_147_483_646; // not a live process
    writeFileSync(
      activeRepoLockPath(),
      JSON.stringify({ path: "/repo/dead", pid: deadPid })
    );
    // The holder accessor treats a dead pid as free.
    expect(activeRepoHolder()).toBeNull();

    const result = acquireActiveRepoLock("/repo/new");
    expect(result.acquired).toBe(true);
    expect(activeRepoHolder()?.path).toBe("/repo/new");
  });

  it("release frees the slot for a different repo", async () => {
    const { acquireActiveRepoLock, releaseActiveRepoLock, activeRepoHolder } =
      await import("../daemon/active-repo-lock.js");

    expect(acquireActiveRepoLock("/repo/a").acquired).toBe(true);
    releaseActiveRepoLock();
    expect(activeRepoHolder()).toBeNull();

    // A different repo can now take the slot.
    expect(acquireActiveRepoLock("/repo/b").acquired).toBe(true);
    expect(activeRepoHolder()?.path).toBe("/repo/b");
  });
});
