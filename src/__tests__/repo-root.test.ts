/**
 * resolveRepoRoot walks up to the project root so short-lived unerr processes
 * pin their `.unerr` scratch to one place — never scattering it into whatever
 * subfolder the agent `cd`'d into.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRepoRootCache, resolveRepoRoot } from "../utils/repo-root.js";

describe("resolveRepoRoot", () => {
  let root: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
    root = join(tmpdir(), `reporoot-${Date.now()}-${counter}`);
    mkdirSync(root, { recursive: true });
    clearRepoRootCache();
  });

  afterEach(() => {
    clearRepoRootCache();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns the git root from a nested subdirectory", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "docs", "design");
    mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBe(root);
  });

  it("treats a .git FILE (worktree/submodule) as a root", () => {
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
    const nested = join(wt, "src");
    mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBe(wt);
  });

  it("prefers a .git root OVER a nearer stray .unerr subdir", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    const sub = join(root, "docs");
    mkdirSync(join(sub, ".unerr", "state"), { recursive: true });
    // Even though docs/.unerr exists, the .git root wins.
    expect(resolveRepoRoot(sub)).toBe(root);
  });

  it("falls back to the nearest existing .unerr when there is no .git", () => {
    mkdirSync(join(root, ".unerr"), { recursive: true });
    const nested = join(root, "pkg", "lib");
    mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBe(root);
  });

  it("ignores a .unerr FILE and uses the nearest .unerr DIRECTORY instead", () => {
    // .unerr DIR at root is the real marker; a .unerr FILE in the subdir must
    // be skipped so resolution climbs past it to the directory.
    mkdirSync(join(root, ".unerr"), { recursive: true });
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".unerr"), "not a dir");
    expect(resolveRepoRoot(sub)).toBe(root);
  });

  it("caches the resolution per startDir", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "x");
    mkdirSync(nested, { recursive: true });
    const first = resolveRepoRoot(nested);
    // Remove the marker; a cached lookup must still return the first result.
    rmSync(join(root, ".git"), { recursive: true, force: true });
    expect(resolveRepoRoot(nested)).toBe(first);
  });
});
