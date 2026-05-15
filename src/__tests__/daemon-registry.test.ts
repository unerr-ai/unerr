/**
 * Tests for the daemon registry (DM-1 Tasks 2-5, 9).
 *
 * Uses temp dirs for both ~/.unerr (global) and fake repo paths.
 * Mocks `os.homedir()` to isolate from real user state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir before importing registry (module-level side effect via globalDir)
const testHome = join(tmpdir(), `unerr-test-home-${process.pid}-${Date.now()}`);
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

import type { RepoEntry } from "../daemon/protocol.js";
import {
  addRepo,
  deriveLabel,
  detectChildConflicts,
  detectParentConflict,
  findRepo,
  listRepos,
  readNeedsInput,
  readRegistry,
  removeRepo,
  updateRepoSettings,
  writeNeedsInput,
  writeRegistry,
} from "../daemon/registry.js";

let testNum = 0;
function makeRepo(name: string): string {
  testNum++;
  const p = join(testHome, `test-${testNum}`, name);
  mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  mkdirSync(testHome, { recursive: true });
  // Reset registry for test isolation
  writeRegistry({ version: 1, repos: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Registry CRUD", () => {
  it("adds a new repo and writes repos.json", () => {
    const repoPath = makeRepo("my-app");
    const result = addRepo(repoPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.entry.path).toBe(repoPath);
    expect(result.entry.label).toBe("my-app");
    expect(result.entry.idleTimeout).toBe(1800);

    const reg = readRegistry();
    expect(reg.repos).toHaveLength(1);
    expect(reg.repos[0]!.path).toBe(repoPath);
  });

  it("is idempotent — adding the same path twice returns existing entry", () => {
    const repoPath = makeRepo("idempotent");
    const first = addRepo(repoPath);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);

    const second = addRepo(repoPath);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.entry.path).toBe(repoPath);
  });

  it("removes a repo", () => {
    const repoPath = makeRepo("to-remove");
    addRepo(repoPath);
    expect(listRepos()).toHaveLength(1);

    const removed = removeRepo(repoPath);
    expect(removed).toBe(true);
    expect(listRepos()).toHaveLength(0);
  });

  it("returns false when removing non-existent repo", () => {
    expect(removeRepo("/nonexistent")).toBe(false);
  });

  it("findRepo by path", () => {
    const repoPath = makeRepo("findable");
    addRepo(repoPath);
    const found = findRepo(repoPath);
    expect(found).toBeDefined();
    expect(found!.path).toBe(repoPath);
  });

  it("findRepo by label", () => {
    const repoPath = makeRepo("by-label");
    addRepo(repoPath);
    const found = findRepo("by-label");
    expect(found).toBeDefined();
    expect(found!.path).toBe(repoPath);
  });

  it("listRepos returns all registered repos", () => {
    addRepo(makeRepo("repo-a"));
    addRepo(makeRepo("repo-b"));
    addRepo(makeRepo("repo-c"));
    expect(listRepos()).toHaveLength(3);
  });
});

describe("Settings", () => {
  it("add with settings writes to registry and local config", () => {
    const repoPath = makeRepo("with-settings");
    const result = addRepo(repoPath, {
      idleTimeout: 60,
      javaBuildTool: "Gradle",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.idleTimeout).toBe(60);
    expect(result.entry.settings.javaBuildTool).toBe("Gradle");

    // Verify local config mirror
    const localConfig = JSON.parse(
      readFileSync(join(repoPath, ".unerr", "config.json"), "utf-8")
    );
    expect(localConfig.javaBuildTool).toBe("Gradle");
  });

  it("updateRepoSettings patches and mirrors", () => {
    const repoPath = makeRepo("update-settings");
    addRepo(repoPath, { javaBuildTool: "Maven" });

    const updated = updateRepoSettings(repoPath, {
      javaBuildTool: "Gradle",
      idleTimeout: 120,
    });
    expect(updated).not.toBeNull();
    expect(updated!.settings.javaBuildTool).toBe("Gradle");
    expect(updated!.idleTimeout).toBe(120);

    // Verify persisted
    const reg = readRegistry();
    const persisted = reg.repos.find((r) => r.path === repoPath)!;
    expect(persisted.settings.javaBuildTool).toBe("Gradle");
    expect(persisted.idleTimeout).toBe(120);

    // Verify local mirror
    const localConfig = JSON.parse(
      readFileSync(join(repoPath, ".unerr", "config.json"), "utf-8")
    );
    expect(localConfig.javaBuildTool).toBe("Gradle");
  });

  it("updateRepoSettings returns null for unknown repo", () => {
    expect(updateRepoSettings("/nonexistent", { idleTimeout: 60 })).toBeNull();
  });
});

describe("Parent detection", () => {
  it("detects registered parent directory", () => {
    const parent = makeRepo("monorepo");
    const child = join(parent, "packages", "frontend");
    mkdirSync(child, { recursive: true });

    addRepo(parent);
    const repos = listRepos();
    const conflict = detectParentConflict(child, repos);
    expect(conflict).toBe(parent);
  });

  it("returns null when no parent conflict", () => {
    const a = makeRepo("standalone-a");
    const b = makeRepo("standalone-b");
    addRepo(a);
    const repos = listRepos();
    expect(detectParentConflict(b, repos)).toBeNull();
  });

  it("addRepo blocks registration when parent exists", () => {
    const parent = makeRepo("parent-block");
    const child = join(parent, "sub", "project");
    mkdirSync(child, { recursive: true });

    addRepo(parent);
    const result = addRepo(child);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.parentConflict).toBe(parent);
  });

  it("addRepo allows with skipParentCheck", () => {
    const parent = makeRepo("parent-allow");
    const child = join(parent, "sub", "project");
    mkdirSync(child, { recursive: true });

    addRepo(parent);
    const result = addRepo(child, {}, { skipParentCheck: true });
    expect(result.ok).toBe(true);
  });
});

describe("Child detection", () => {
  it("detects registered child directories", () => {
    const parent = makeRepo("new-parent");
    const childA = join(parent, "packages", "a");
    const childB = join(parent, "packages", "b");
    mkdirSync(childA, { recursive: true });
    mkdirSync(childB, { recursive: true });

    addRepo(childA, {}, { skipParentCheck: true });
    addRepo(childB, {}, { skipParentCheck: true });

    const repos = listRepos();
    const conflicts = detectChildConflicts(parent, repos);
    expect(conflicts).toHaveLength(2);
    expect(conflicts).toContain(childA);
    expect(conflicts).toContain(childB);
  });

  it("returns empty when no child conflicts", () => {
    const a = makeRepo("no-child-a");
    addRepo(a);
    const b = makeRepo("no-child-b");
    const repos = listRepos();
    expect(detectChildConflicts(b, repos)).toHaveLength(0);
  });
});

describe("Label generation", () => {
  it("uses basename for first repo", () => {
    expect(deriveLabel("/users/dev/my-app", [])).toBe("my-app");
  });

  it("uses parent-basename on collision", () => {
    const existing = [{ label: "my-app" }] as RepoEntry[];
    expect(deriveLabel("/users/work/my-app", existing)).toBe("work-my-app");
  });

  it("uses numeric suffix on double collision", () => {
    const existing = [
      { label: "my-app" },
      { label: "work-my-app" },
    ] as RepoEntry[];
    expect(deriveLabel("/other/work/my-app", existing)).toBe("my-app-2");
  });
});

describe("Needs-input signals", () => {
  it("write and read round-trip", () => {
    const repoPath = makeRepo("needs-input-test");
    const signals = [
      {
        type: "needs_input" as const,
        key: "javaBuildTool",
        auto: "Gradle",
        alternatives: ["Maven"],
        reason: "gradlew wrapper present",
      },
    ];
    writeNeedsInput(repoPath, signals);
    const read = readNeedsInput(repoPath);
    expect(read).toEqual(signals);
  });

  it("returns empty array when no signals file", () => {
    expect(readNeedsInput("/nonexistent")).toEqual([]);
  });
});

describe("Ensures .unerr/ directory", () => {
  it("creates .unerr/ on add if missing", () => {
    const repoPath = makeRepo("ensure-dir");
    addRepo(repoPath);
    expect(existsSync(join(repoPath, ".unerr"))).toBe(true);
  });

  it("creates .unerr/config.json with settings", () => {
    const repoPath = makeRepo("config-file");
    addRepo(repoPath, { javaBuildTool: "Maven" });
    expect(existsSync(join(repoPath, ".unerr", "config.json"))).toBe(true);
  });
});
