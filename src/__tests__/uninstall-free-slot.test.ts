/**
 * Phase C4 — `uninstall` frees the free-tier cap slot + `--purge` semantics.
 *
 * After removing MCP config / skills / hooks, `uninstall` must also unregister
 * the repo from pm (stop child + drop registry row) so the free slot frees.
 * The `<repo>/.unerr` data dir is KEPT by default and only removed with
 * `--purge` — user data is never destroyed silently.
 *
 * Isolated via a temp `~/.unerr` (registry) and a temp cwd (the fake repo).
 * No daemon socket exists, so the bare-removal fallback runs.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = join(
  tmpdir(),
  `unerr-uninstall-home-${process.pid}-${Date.now()}`
);
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

import { registerUninstallCommand } from "../commands/uninstall.js";
import { addRepo, listRepos, writeRegistry } from "../daemon/registry.js";

let n = 0;
let originalCwd: string;

function makeRepo(name: string): string {
  n++;
  const p = join(testHome, `repo-${n}`, name);
  mkdirSync(join(p, ".unerr"), { recursive: true });
  // A breadcrumb file so we can confirm the data dir survives a default uninstall.
  writeFileSync(join(p, ".unerr", "config.json"), "{}\n");
  // Canonicalize: macOS tmpdir is a /var → /private/var symlink, and
  // `process.cwd()` (which the command reads) returns the canonical form. The
  // registry key must match what the command passes, mirroring real use.
  return realpathSync(p);
}

/** Run `uninstall` against the given cwd with the supplied argv flags. */
async function runUninstallCmd(cwd: string, args: string[]): Promise<void> {
  originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const program = new Command();
    program.exitOverride();
    registerUninstallCommand(program);
    await program.parseAsync(["node", "unerr", "uninstall", ...args]);
  } finally {
    process.chdir(originalCwd);
  }
}

beforeEach(() => {
  mkdirSync(testHome, { recursive: true });
  writeRegistry({ version: 1, repos: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uninstall — free the slot", () => {
  it("unregisters the repo so the slot frees (no agent arg)", async () => {
    const repo = makeRepo("alpha");
    expect(addRepo(repo, {}, { repoLimit: 1 }).ok).toBe(true);
    expect(listRepos()).toHaveLength(1);

    await runUninstallCmd(repo, []);

    expect(listRepos()).toHaveLength(0);
  });

  it("after uninstall, a free user (limit 1) can add a DIFFERENT repo", async () => {
    const first = makeRepo("first");
    const second = makeRepo("second");
    expect(addRepo(first, {}, { repoLimit: 1 }).ok).toBe(true);
    // Cap blocks the second while the first holds the slot.
    expect(addRepo(second, {}, { repoLimit: 1 }).ok).toBe(false);

    await runUninstallCmd(first, []);

    expect(addRepo(second, {}, { repoLimit: 1 }).ok).toBe(true);
    expect(listRepos().map((r) => r.path)).toContain(second);
  });

  it("default uninstall KEEPS the .unerr data dir", async () => {
    const repo = makeRepo("keep");
    addRepo(repo, {}, { repoLimit: 1 });

    await runUninstallCmd(repo, []);

    expect(existsSync(join(repo, ".unerr"))).toBe(true);
    expect(existsSync(join(repo, ".unerr", "config.json"))).toBe(true);
  });

  it("--purge removes the .unerr data dir", async () => {
    const repo = makeRepo("purge");
    addRepo(repo, {}, { repoLimit: 1 });

    await runUninstallCmd(repo, ["--purge"]);

    expect(existsSync(join(repo, ".unerr"))).toBe(false);
    expect(listRepos()).toHaveLength(0);
  });
});
