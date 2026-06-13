/**
 * Phase C4 — `pm remove` frees the free-tier cap slot.
 *
 * `unregisterRepo()` must drop the registry row (and, when the daemon is up,
 * stop the child first). With no daemon running it falls back to the bare
 * `removeRepo()`. The key guarantee: after a free user (limit 1) removes their
 * one repo, they can add a DIFFERENT repo.
 *
 * Isolated via a temp `~/.unerr`; no daemon socket exists, so `probeDaemon`
 * returns false and the bare-removal fallback is exercised.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = join(
  tmpdir(),
  `unerr-pm-remove-home-${process.pid}-${Date.now()}`
);
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

import { addRepo, listRepos, writeRegistry } from "../daemon/registry.js";
import { unregisterRepo } from "../commands/pm.js";

let n = 0;
function makeRepo(name: string): string {
  n++;
  const p = join(testHome, `repo-${n}`, name);
  mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  mkdirSync(testHome, { recursive: true });
  writeRegistry({ version: 1, repos: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pm remove — free the slot", () => {
  it("drops the registry row (daemon not running → bare removal)", async () => {
    const repo = makeRepo("alpha");
    const result = addRepo(repo, {}, { repoLimit: 1 });
    expect(result.ok).toBe(true);
    expect(listRepos()).toHaveLength(1);

    const removed = await unregisterRepo(repo);
    expect(removed).toBe(true);
    expect(listRepos()).toHaveLength(0);
  });

  it("returns false when the repo was never registered", async () => {
    const repo = makeRepo("ghost");
    const removed = await unregisterRepo(repo);
    expect(removed).toBe(false);
  });

  it("a free user (limit 1) can add a DIFFERENT repo after removing the first", async () => {
    const first = makeRepo("first");
    const second = makeRepo("second");

    // At the cap: first repo registered.
    expect(addRepo(first, {}, { repoLimit: 1 }).ok).toBe(true);

    // Cap blocks a second repo while the first occupies the slot.
    const blocked = addRepo(second, {}, { repoLimit: 1 });
    expect(blocked.ok).toBe(false);

    // Free the slot.
    expect(await unregisterRepo(first)).toBe(true);
    expect(listRepos()).toHaveLength(0);

    // Now the different repo registers.
    const added = addRepo(second, {}, { repoLimit: 1 });
    expect(added.ok).toBe(true);
    expect(listRepos().map((r) => r.path)).toContain(second);
  });
});
